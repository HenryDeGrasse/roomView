#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = [
#   "numpy>=1.26",
#   "plyfile>=1.0",
# ]
# ///
"""
Discover objects the RoomPlan recognizer missed by mining the trained
splat. The splat has high-opacity gaussians on every real surface it
saw; anything clustered in free space that's NOT already covered by a
mesh OBB and NOT hugging the shell is a candidate missed object (pillow,
plant, lamp, floor clutter, wall art).

Pipeline:
  1. Load the PLY (positions + opacity logits).
  2. Filter to "free-space candidates":
       - opacity sigmoid > 0.3 (real surface, not haze)
       - inside the room AABB (drops exterior halo)
       - outside existing mesh OBBs + margin (drops meshed objects)
       - off the shell (walls + floor + ceiling) by > WALL_MARGIN_M
  3. Voxel-cluster at CLUSTER_VOXEL_M (5cm); union-find merge
     neighbouring cells within 2 voxels.
  4. Drop clusters below MIN_CLUSTER_GAUSSIANS (~500) as noise.
  5. Fit an axis-aligned-XY OBB + vertical extent to each cluster:
       - PCA in XY for the yaw axis
       - min/max along local u/v/z for sizes
  6. Write candidates/manifest.json with {id, obb, n_gaussians,
     centroid, mean_color}. The viewer can render these as amber
     wireframes so the user can accept / dismiss each candidate.

Usage:
  uv run scripts/splat-to-mesh-candidates.py \\
      --fixture-id capture-bedroom110-4-20260420-005336
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import sys
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
from plyfile import PlyData


# Tuning constants — all chosen for bedroom-scale (5-8m) rooms.
# We cluster in 2D (XY only) because 3DGS trains haze gaussians in the
# air above every object. 3D clustering lumps an object + its vertical
# haze column into one cluster, producing OBBs that span floor → ceiling
# and never match actual objects. 2D XY cluster + percentile-derived Z
# extent gives tight vertical bounds matching real object heights.
OPACITY_SIGMOID_MIN = 0.1
CLUSTER_VOXEL_M = 0.06
NEIGHBOUR_RADIUS_VOXELS = 1
MIN_VOXEL_DENSITY = 4
MIN_CLUSTER_GAUSSIANS = 300
MIN_CLUSTER_EXTENT_M = 0.2
# Reject OBBs that span more than this fraction of the room floor.
MAX_CLUSTER_ROOM_FRACTION = 0.5
OBB_MARGIN_M = 0.05                  # exclude anything within 5cm of a mesh OBB
# Wall margin trimmed from 15cm → 2cm. Earlier 15cm was clipping the
# wall-touching side of beds/sofas/etc, dropping recall to 0%. 2cm only
# rejects gaussians physically embedded in the wall surface.
WALL_MARGIN_M = 0.02
# Z extent: use these percentiles of the cluster's gaussians, not the
# min/max. Tenth percentile kills any below-floor outliers, 90th kills
# the haze gaussians stretching to the ceiling.
Z_LOW_PERCENTILE = 5.0
Z_HIGH_PERCENTILE = 95.0


def _sigmoid(x: np.ndarray) -> np.ndarray:
    return 1.0 / (1.0 + np.exp(-x))


def _load_ply_fields(ply_path: Path) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    data = PlyData.read(str(ply_path))
    vertex = data["vertex"]
    positions = np.stack([
        np.asarray(vertex["x"], dtype=np.float32),
        np.asarray(vertex["y"], dtype=np.float32),
        np.asarray(vertex["z"], dtype=np.float32),
    ], axis=-1)
    opacity_logit = np.asarray(vertex["opacity"], dtype=np.float32)
    try:
        dc = np.stack([
            np.asarray(vertex["f_dc_0"], dtype=np.float32),
            np.asarray(vertex["f_dc_1"], dtype=np.float32),
            np.asarray(vertex["f_dc_2"], dtype=np.float32),
        ], axis=-1)
        C0 = 0.2820947917738781
        color_01 = np.clip(0.5 + dc * C0, 0.0, 1.0)
    except (ValueError, KeyError):
        color_01 = np.full_like(positions, 0.5)
    return positions, opacity_logit, color_01


def _load_splat_fields(splat_path: Path) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Antimatter15 .splat format: 32 bytes/gaussian.
    Bytes 0-11   : pos (3 float32)
    Bytes 12-23  : scale (3 float32) — unused
    Bytes 24-27  : color RGBA (4 uint8) — alpha is opacity 0-255
    Bytes 28-31  : rotation (packed uint8) — unused

    Every gaussian in this file corresponds to a unique depth-pixel
    observation, so opacity is uniformly high (usually 255) and density
    directly reflects surface coverage. That's exactly the signal we
    want for candidate detection.
    """
    raw = np.frombuffer(splat_path.read_bytes(), dtype=np.uint8)
    n = raw.size // 32
    raw = raw[: n * 32].reshape(n, 32)
    positions = raw[:, :12].copy().view(np.float32).reshape(n, 3)
    alpha = raw[:, 27].astype(np.float32) / 255.0
    # Return alpha as if it were a sigmoid(opacity_logit) so the main
    # filter's `_sigmoid(logit) >= threshold` reads identically. Convert
    # back to logit so the shared code path works.
    alpha_clipped = np.clip(alpha, 1e-4, 1 - 1e-4)
    opacity_logit = np.log(alpha_clipped / (1 - alpha_clipped)).astype(np.float32)
    color_01 = raw[:, 24:27].astype(np.float32) / 255.0
    return positions, opacity_logit, color_01


def _load_gaussian_fields(path: Path) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Dispatch to the PLY or antimatter15 .splat loader by extension."""
    suffix = path.suffix.lower()
    if suffix == ".ply":
        return _load_ply_fields(path)
    if suffix == ".splat":
        return _load_splat_fields(path)
    raise SystemExit(f"unsupported splat format: {path}")


def _load_scene_shell(scene: dict) -> dict | None:
    try:
        shell = scene["snapshot"]["state"]["room"]["shell"]
    except (KeyError, TypeError):
        return None
    floor = shell.get("floor_polygon") or {}
    verts = floor.get("vertices") or []
    if not verts:
        return None
    xs = [float(v["x"]) for v in verts]
    ys = [float(v["y"]) for v in verts]
    surfaces = shell.get("surfaces") or []
    walls: list[dict] = []
    for s in surfaces:
        if s.get("type") != "wall":
            continue
        frame = s.get("surface_frame") or {}
        normal = frame.get("normal") or {}
        origin = frame.get("origin") or {}
        try:
            walls.append({
                "nx": float(normal.get("x", 0.0)),
                "ny": float(normal.get("y", 0.0)),
                "nz": float(normal.get("z", 0.0)),
                "ox": float(origin.get("x", 0.0)),
                "oy": float(origin.get("y", 0.0)),
                "oz": float(origin.get("z", 0.0)),
            })
        except (TypeError, ValueError):
            continue
    return {
        "min_x": min(xs), "max_x": max(xs),
        "min_y": min(ys), "max_y": max(ys),
        "ceiling_z": float(shell.get("ceiling_height", 2.5)),
        "walls": walls,
    }


def _load_covered_obbs(scene: dict, manifest_path: Path) -> list[dict]:
    if not manifest_path.exists():
        return []
    try:
        manifest = json.loads(manifest_path.read_text())
    except (json.JSONDecodeError, OSError):
        return []
    covered = set((manifest.get("meshes") or {}).keys())
    if not covered:
        return []
    try:
        objects = scene["snapshot"]["state"]["room"]["objects"] or []
    except (KeyError, TypeError):
        return []
    out: list[dict] = []
    for obj in objects:
        if not isinstance(obj, dict):
            continue
        oid = obj.get("object_id")
        obb = obj.get("obb")
        if oid not in covered or not obb:
            continue
        center = obb.get("center") or {}
        try:
            out.append({
                "object_id": oid,
                "cx": float(center.get("x", 0.0)),
                "cy": float(center.get("y", 0.0)),
                "cz": float(center.get("z", 0.0)),
                "hx": 0.5 * float(obb.get("size_x", 0.0)) + OBB_MARGIN_M,
                "hy": 0.5 * float(obb.get("size_y", 0.0)) + OBB_MARGIN_M,
                "hz": 0.5 * float(obb.get("size_z", 0.0)) + OBB_MARGIN_M,
                "yaw_deg": float(obb.get("yaw_degrees", 0.0)),
            })
        except (TypeError, ValueError):
            continue
    return out


def _filter_to_freespace_candidates(
    positions: np.ndarray,
    opacity_logit: np.ndarray,
    shell: dict,
    covered_obbs: list[dict],
) -> np.ndarray:
    debug: dict[str, int] = {}
    mask = _sigmoid(opacity_logit) >= OPACITY_SIGMOID_MIN
    debug["after_opacity"] = int(mask.sum())
    mask &= positions[:, 0] >= shell["min_x"] + 0.05
    mask &= positions[:, 0] <= shell["max_x"] - 0.05
    mask &= positions[:, 1] >= shell["min_y"] + 0.05
    mask &= positions[:, 1] <= shell["max_y"] - 0.05
    debug["after_xy_bounds"] = int(mask.sum())
    # Floor: drop anything within 15cm of z=0 (floor surface + dust). Higher
    # than wall margin because a lot of object gaussians are on TOP of
    # objects (table surface, bed top) well above the floor, so we can
    # afford to cut more aggressively at the bottom without killing
    # object clusters.
    mask &= positions[:, 2] > 0.15
    # Ceiling: drop anything close to the ceiling (lighting fixtures
    # hanging from ceiling will be missed here but that's OK for MVP).
    mask &= positions[:, 2] < shell["ceiling_z"] - 0.15
    debug["after_z_bounds"] = int(mask.sum())

    # Wall margin: reject gaussians within WALL_MARGIN_M of any wall plane.
    # This has to be small (2cm) because beds/sofas commonly back up
    # against walls and we want to keep those gaussians.
    for wall in shell["walls"]:
        nx, ny, nz = wall["nx"], wall["ny"], wall["nz"]
        dist = (
            nx * (positions[:, 0] - wall["ox"]) +
            ny * (positions[:, 1] - wall["oy"]) +
            nz * (positions[:, 2] - wall["oz"])
        )
        mask &= np.abs(dist) >= WALL_MARGIN_M
    debug["after_wall_margin"] = int(mask.sum())

    # Subtract mesh-covered OBBs.
    for obb in covered_obbs:
        if obb["hx"] <= 0 or obb["hy"] <= 0 or obb["hz"] <= 0:
            continue
        yaw = math.radians(obb["yaw_deg"])
        cos_y = math.cos(yaw)
        sin_y = math.sin(yaw)
        dx = positions[:, 0] - obb["cx"]
        dy = positions[:, 1] - obb["cy"]
        dz = positions[:, 2] - obb["cz"]
        local_x = cos_y * dx + sin_y * dy
        local_y = -sin_y * dx + cos_y * dy
        inside = (np.abs(local_x) < obb["hx"]) & (np.abs(local_y) < obb["hy"]) & (np.abs(dz) < obb["hz"])
        mask &= ~inside
    debug["after_obb_subtract"] = int(mask.sum())

    # Stash the debug counters on the function via sys.stderr so the
    # caller sees where gaussians dropped out at each step.
    print(f"[candidates] filter stages: {debug}", file=sys.stderr)
    return mask


def _voxel_connected_components(points: np.ndarray) -> np.ndarray:
    """Return per-point cluster_id via union-find on 3D voxel cells.
    Low-density cells are dropped before clustering so sparse noise
    doesn't bridge distinct objects. Points in dropped cells get
    cluster_id = -1 (excluded downstream)."""
    if points.size == 0:
        return np.zeros((0,), dtype=np.int32)
    vox = np.floor(points / CLUSTER_VOXEL_M).astype(np.int64)
    vox_keys = [(int(v[0]), int(v[1]), int(v[2])) for v in vox]
    cell_count: dict[tuple[int, int, int], int] = {}
    for k in vox_keys:
        cell_count[k] = cell_count.get(k, 0) + 1
    occupied: dict[tuple[int, int, int], int] = {}
    for k, n in cell_count.items():
        if n >= MIN_VOXEL_DENSITY:
            occupied[k] = len(occupied)
    if not occupied:
        return np.full(len(vox_keys), -1, dtype=np.int32)
    n_vox = len(occupied)
    parent = np.arange(n_vox, dtype=np.int32)

    def find(i: int) -> int:
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    def union(i: int, j: int) -> None:
        ri, rj = find(i), find(j)
        if ri != rj:
            parent[rj] = ri

    r = NEIGHBOUR_RADIUS_VOXELS
    offsets = [
        (dx, dy, dz)
        for dx in range(-r, r + 1)
        for dy in range(-r, r + 1)
        for dz in range(-r, r + 1)
        if not (dx == 0 and dy == 0 and dz == 0)
    ]
    for key, idx in occupied.items():
        for ox, oy, oz in offsets:
            neighbour = (key[0] + ox, key[1] + oy, key[2] + oz)
            if neighbour in occupied:
                union(idx, occupied[neighbour])

    point_cluster = np.array(
        [find(occupied[k]) if k in occupied else -1 for k in vox_keys],
        dtype=np.int32,
    )
    positives = point_cluster >= 0
    if positives.any():
        _, inv_positives = np.unique(point_cluster[positives], return_inverse=True)
        out = point_cluster.copy()
        out[positives] = inv_positives.astype(np.int32)
        return out
    return point_cluster


def _fit_xy_aligned_obb(points: np.ndarray) -> dict:
    """Fit OBB: yaw + XY extent from PCA; Z extent from density percentiles
    (5-95) so residual haze above objects doesn't stretch the box up."""
    centroid_xy = points[:, :2].mean(axis=0)
    centered_xy = points[:, :2] - centroid_xy
    if points.shape[0] >= 3:
        cov = np.cov(centered_xy, rowvar=False)
        evals, evecs = np.linalg.eigh(cov)
        u = evecs[:, np.argmax(evals)]
        v = np.array([-u[1], u[0]])
    else:
        u = np.array([1.0, 0.0])
        v = np.array([0.0, 1.0])
    u_proj = centered_xy @ u
    v_proj = centered_xy @ v
    # XY extent: use percentiles too, to trim occasional flyers that
    # escape the cluster's main XY mass.
    u_lo = float(np.percentile(u_proj, 5))
    u_hi = float(np.percentile(u_proj, 95))
    v_lo = float(np.percentile(v_proj, 5))
    v_hi = float(np.percentile(v_proj, 95))
    size_x = u_hi - u_lo
    size_y = v_hi - v_lo
    mid_u = 0.5 * (u_lo + u_hi)
    mid_v = 0.5 * (v_lo + v_hi)
    center_xy = centroid_xy + mid_u * u + mid_v * v
    z_lo = float(np.percentile(points[:, 2], Z_LOW_PERCENTILE))
    z_hi = float(np.percentile(points[:, 2], Z_HIGH_PERCENTILE))
    size_z = max(z_hi - z_lo, 0.05)
    center_z = 0.5 * (z_lo + z_hi)
    yaw_deg = math.degrees(math.atan2(u[1], u[0]))
    return {
        "center": {"x": float(center_xy[0]), "y": float(center_xy[1]), "z": center_z},
        "size_x": float(size_x),
        "size_y": float(size_y),
        "size_z": float(size_z),
        "yaw_degrees": float(yaw_deg),
    }


def _dominant_color(rgb_01: np.ndarray) -> dict:
    mean = rgb_01.mean(axis=0)
    return {"r": float(mean[0]), "g": float(mean[1]), "b": float(mean[2])}


def _iou_xy_aligned(obb_a: dict, obb_b: dict) -> float:
    """Rough IoU using the XY footprint + Z extent only (yaw ignored).
    Good enough for "did this candidate land on that known OBB?" sanity
    checks."""
    ax_lo = obb_a["center"]["x"] - obb_a["size_x"] * 0.5
    ax_hi = obb_a["center"]["x"] + obb_a["size_x"] * 0.5
    ay_lo = obb_a["center"]["y"] - obb_a["size_y"] * 0.5
    ay_hi = obb_a["center"]["y"] + obb_a["size_y"] * 0.5
    az_lo = obb_a["center"]["z"] - obb_a["size_z"] * 0.5
    az_hi = obb_a["center"]["z"] + obb_a["size_z"] * 0.5
    bx_lo = obb_b["center"]["x"] - obb_b["size_x"] * 0.5
    bx_hi = obb_b["center"]["x"] + obb_b["size_x"] * 0.5
    by_lo = obb_b["center"]["y"] - obb_b["size_y"] * 0.5
    by_hi = obb_b["center"]["y"] + obb_b["size_y"] * 0.5
    bz_lo = obb_b["center"]["z"] - obb_b["size_z"] * 0.5
    bz_hi = obb_b["center"]["z"] + obb_b["size_z"] * 0.5
    inter_x = max(0.0, min(ax_hi, bx_hi) - max(ax_lo, bx_lo))
    inter_y = max(0.0, min(ay_hi, by_hi) - max(ay_lo, by_lo))
    inter_z = max(0.0, min(az_hi, bz_hi) - max(az_lo, bz_lo))
    intersection = inter_x * inter_y * inter_z
    vol_a = obb_a["size_x"] * obb_a["size_y"] * obb_a["size_z"]
    vol_b = obb_b["size_x"] * obb_b["size_y"] * obb_b["size_z"]
    union = vol_a + vol_b - intersection
    return intersection / union if union > 0 else 0.0


def _load_all_scene_obbs(scene: dict) -> list[dict]:
    """Like _load_covered_obbs but returns every object's OBB, not just
    the mesh-covered ones. Used by validation mode to check whether our
    cluster detector recovers what RoomPlan already detected."""
    try:
        objects = scene["snapshot"]["state"]["room"]["objects"] or []
    except (KeyError, TypeError):
        return []
    out: list[dict] = []
    for obj in objects:
        if not isinstance(obj, dict):
            continue
        oid = obj.get("object_id")
        obb = obj.get("obb")
        if not oid or not obb:
            continue
        center = obb.get("center") or {}
        try:
            out.append({
                "object_id": oid,
                "class": obj.get("class"),
                "center": {
                    "x": float(center.get("x", 0.0)),
                    "y": float(center.get("y", 0.0)),
                    "z": float(center.get("z", 0.0)),
                },
                "size_x": float(obb.get("size_x", 0.0)),
                "size_y": float(obb.get("size_y", 0.0)),
                "size_z": float(obb.get("size_z", 0.0)),
                "yaw_degrees": float(obb.get("yaw_degrees", 0.0)),
            })
        except (TypeError, ValueError):
            continue
    return out


def discover_candidates(fixture_dir: Path, skip_obb_subtract: bool = False, source_ply: Path | None = None) -> dict:
    scene_path = fixture_dir / "scene.json"
    scene = json.loads(scene_path.read_text())

    if source_ply is not None:
        ply_path = source_ply
    else:
        # Prefer the RGBD-init fast splat (every gaussian = a real depth
        # pixel, no training haze) over the Brush-trained PLY. Look for
        # splat_*.splat in the fixture's splats/ root.
        fast_candidates = sorted(
            p for p in (fixture_dir / "splats").glob("splat_*.splat")
        )
        if fast_candidates:
            ply_path = fast_candidates[-1]
        else:
            splat = scene.get("splat") or {}
            uri = splat.get("uri") or ""
            if not uri.startswith("/dev/fixtures/"):
                raise SystemExit(f"scene.splat.uri missing or malformed: {uri!r}")
            rel = uri[len("/dev/fixtures/"):].split("/", 1)[1]
            ply_path = fixture_dir / rel
    if not ply_path.exists():
        raise SystemExit(f"splat file not found at {ply_path}")
    print(f"[candidates] using source: {ply_path.name}", file=sys.stderr)

    shell = _load_scene_shell(scene)
    if shell is None:
        raise SystemExit("scene has no shell / floor_polygon; nothing to discover against")
    covered_obbs = [] if skip_obb_subtract else _load_covered_obbs(scene, fixture_dir / "meshes" / "manifest.json")

    positions, opacity_logit, color_01 = _load_gaussian_fields(ply_path)
    mask = _filter_to_freespace_candidates(positions, opacity_logit, shell, covered_obbs)
    if not mask.any():
        return {
            "fixture_id": fixture_dir.name,
            "candidates": [],
            "stats": {
                "total_gaussians": int(positions.shape[0]),
                "freespace_gaussians": 0,
                "clusters_found": 0,
            },
            "generated_at": datetime.now(timezone.utc).isoformat(),
        }

    free_positions = positions[mask]
    free_colors = color_01[mask]
    cluster_ids = _voxel_connected_components(free_positions)

    room_area = (shell["max_x"] - shell["min_x"]) * (shell["max_y"] - shell["min_y"])
    candidates = []
    for cid in np.unique(cluster_ids):
        if cid < 0:
            continue  # sparse-cell noise
        idx = cluster_ids == cid
        n = int(idx.sum())
        if n < MIN_CLUSTER_GAUSSIANS:
            continue
        cluster_points = free_positions[idx]
        extent_x = float(cluster_points[:, 0].max() - cluster_points[:, 0].min())
        extent_y = float(cluster_points[:, 1].max() - cluster_points[:, 1].min())
        extent_z = float(cluster_points[:, 2].max() - cluster_points[:, 2].min())
        if max(extent_x, extent_y) < MIN_CLUSTER_EXTENT_M or extent_z < MIN_CLUSTER_EXTENT_M:
            continue
        if room_area > 0 and (extent_x * extent_y) / room_area > MAX_CLUSTER_ROOM_FRACTION:
            # Spans most of the room — over-merged cluster, not a real object.
            continue
        obb = _fit_xy_aligned_obb(cluster_points)
        color = _dominant_color(free_colors[idx])
        cluster_hash = hashlib.md5(cluster_points.tobytes()).hexdigest()[:8]
        candidates.append({
            "candidate_id": f"candidate-{cluster_hash}",
            "n_gaussians": n,
            "obb": obb,
            "mean_color": color,
        })

    candidates.sort(key=lambda c: -c["n_gaussians"])

    return {
        "fixture_id": fixture_dir.name,
        "candidates": candidates,
        "stats": {
            "total_gaussians": int(positions.shape[0]),
            "freespace_gaussians": int(mask.sum()),
            "clusters_found": len(candidates),
        },
        "generated_at": datetime.now(timezone.utc).isoformat(),
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--fixture-id", required=True)
    parser.add_argument("--repo-root", type=Path, default=Path.cwd())
    parser.add_argument("--out", type=Path, default=None,
                        help="Output manifest path. Defaults to fixtures/roomplan/<id>/candidates/manifest.json")
    parser.add_argument("--source", type=Path, default=None,
                        help="Explicit splat file to use (.splat or .ply). Default: prefer the RGBD-init .splat (cleaner surface signal than the trained Brush PLY).")
    parser.add_argument("--validate", action="store_true",
                        help=("Diagnostic mode: disable the existing-OBB filter so we cluster the "
                              "whole room, then match candidates against every known RoomPlan object. "
                              "Reports how many of the known objects our detector recovered — "
                              "a sanity check for detector quality vs splat quality."))
    parser.add_argument("--iou-threshold", type=float, default=0.15,
                        help="IoU threshold for --validate matching (default 0.15).")
    args = parser.parse_args()

    fixture_dir = (args.repo_root / "fixtures" / "roomplan" / args.fixture_id).resolve()
    if not fixture_dir.exists():
        raise SystemExit(f"fixture dir not found: {fixture_dir}")

    result = discover_candidates(fixture_dir, skip_obb_subtract=args.validate, source_ply=args.source)

    if args.validate:
        scene = json.loads((fixture_dir / "scene.json").read_text())
        known = _load_all_scene_obbs(scene)
        candidates = result["candidates"]
        matches: list[dict] = []
        matched_known_ids: set[str] = set()
        for cand in candidates:
            best_iou = 0.0
            best_known = None
            for known_obb in known:
                iou = _iou_xy_aligned(cand["obb"], known_obb)
                if iou > best_iou:
                    best_iou = iou
                    best_known = known_obb
            matches.append({
                "candidate_id": cand["candidate_id"],
                "n_gaussians": cand["n_gaussians"],
                "matched_object_id": best_known["object_id"] if best_known and best_iou >= args.iou_threshold else None,
                "matched_class": best_known["class"] if best_known and best_iou >= args.iou_threshold else None,
                "iou": round(best_iou, 3),
            })
            if best_known and best_iou >= args.iou_threshold:
                matched_known_ids.add(best_known["object_id"])
        missed = [k for k in known if k["object_id"] not in matched_known_ids]
        recall = len(matched_known_ids) / len(known) if known else 0.0
        result["validation"] = {
            "known_object_count": len(known),
            "matched_known_count": len(matched_known_ids),
            "recall": round(recall, 3),
            "iou_threshold": args.iou_threshold,
            "matches": matches,
            "missed_objects": [
                {"object_id": k["object_id"], "class": k["class"],
                 "center": k["center"],
                 "size": [k["size_x"], k["size_y"], k["size_z"]]}
                for k in missed
            ],
        }

    out_path = args.out or (fixture_dir / "candidates" / "manifest.json")
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
