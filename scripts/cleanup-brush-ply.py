#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = [
#   "numpy>=1.26",
#   "plyfile>=1.0",
#   "shapely>=2.0",
#   "scipy>=1.11",
#   "open3d>=0.18",
# ]
# ///
"""
Post-process a Brush-trained 3DGS PLY to kill common artifacts:

  1. Polygon clip — drop gaussians outside the floor polygon (real
     shapely containment + small dilation), capped by ceiling+slack.
     Catches through-window haze and L-shaped-corner leakage.
  2. Surface-band cull — keep gaussians within SURFACE_BAND_M of the
     actual scene mesh surface. Distance is exact point-to-triangle via
     Open3D's RaycastingScene BVH (not a vertex-proxy), so tight bands
     (1-2cm) are meaningful. Scene mesh is assembled from:
       - shell walls (rectangular panels from RoomPlan surface_frame)
       - shell floor + ceiling (triangulated from floor_polygon)
       - per-object TSDF meshes (loaded from meshes/*.ply)
     In strict mode (--require-near-mesh) this is the sole gate;
     otherwise an OR with a density floor keeps dense-but-unmeshed
     clusters (RoomPlan-missed content).
  3. Opacity cull — drop gaussians with raw opacity logit below
     OPACITY_LOGIT_MIN.

Writes the cleaned PLY alongside the original as `<name>_clean.ply`
with a sibling `.json` descriptor. Optionally patches scene.splat.

Usage:
  uv run scripts/cleanup-brush-ply.py \\
      --fixture-id capture-bedroom110-4-20260420-005336 \\
      --ply splats/brush-train/splat_brush_30000.ply \\
      --require-near-mesh \\
      --patch-scene
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import open3d as o3d
from plyfile import PlyData, PlyElement
from scipy.spatial import cKDTree
from shapely.geometry import Polygon
from shapely.ops import triangulate as shapely_triangulate
from shapely import contains_xy as shapely_contains


POLYGON_SLACK_XY_M = 0.05
CEILING_SLACK_Z_M = 0.05
FLOOR_SLACK_Z_M = 0.05
SURFACE_BAND_M = 0.025
DENSITY_RADIUS_M = 0.05
MIN_NEIGHBORS = 20
OPACITY_LOGIT_MIN = -5.0


def _floor_polygon(scene: dict) -> tuple[Polygon, float] | None:
    try:
        shell = scene["snapshot"]["state"]["room"]["shell"]
        verts = shell["floor_polygon"]["vertices"]
        ceiling = float(shell["ceiling_height"])
    except (KeyError, TypeError):
        return None
    if len(verts) < 3:
        return None
    pts = [(float(v["x"]), float(v["y"])) for v in verts]
    poly = Polygon(pts)
    if not poly.is_valid:
        poly = poly.buffer(0)
    if not poly.is_valid or poly.is_empty:
        return None
    return poly.buffer(POLYGON_SLACK_XY_M), ceiling


def _wall_verts_faces(surface: dict) -> tuple[np.ndarray, np.ndarray] | None:
    """Return (vertices, faces) for a two-triangle rectangular panel
    covering the wall surface's boundary rectangle in world space."""
    frame = surface.get("surface_frame") or {}
    boundary = (surface.get("boundary") or {}).get("vertices") or []
    if not frame or len(boundary) < 3:
        return None
    try:
        origin = np.array([frame["origin"][k] for k in "xyz"], dtype=np.float64)
        u = np.array([frame["u_axis"][k] for k in "xyz"], dtype=np.float64)
        v = np.array([frame["v_axis"][k] for k in "xyz"], dtype=np.float64)
    except (KeyError, TypeError):
        return None
    us = [float(p["x"]) for p in boundary]
    vs = [float(p["y"]) for p in boundary]
    u_min, u_max = min(us), max(us)
    v_min, v_max = min(vs), max(vs)
    if u_max - u_min < 1e-3 or v_max - v_min < 1e-3:
        return None
    corners_uv = [(u_min, v_min), (u_max, v_min), (u_max, v_max), (u_min, v_max)]
    verts = np.array([origin + uu * u + vv * v for uu, vv in corners_uv], dtype=np.float32)
    faces = np.array([[0, 1, 2], [0, 2, 3]], dtype=np.uint32)
    return verts, faces


def _triangulate_polygon(poly: Polygon) -> tuple[np.ndarray, np.ndarray]:
    """Delaunay-triangulate a shapely polygon, filtering out triangles
    whose centroid lies outside the polygon (handles concave shapes).
    Returns (vertices_2d, faces). Each face indexes into vertices_2d."""
    tris = shapely_triangulate(poly)
    verts: list[tuple[float, float]] = []
    faces: list[tuple[int, int, int]] = []
    for t in tris:
        if not poly.contains(t.centroid):
            continue
        coords = list(t.exterior.coords)[:3]  # exterior repeats first coord
        start = len(verts)
        verts.extend(coords)
        faces.append((start, start + 1, start + 2))
    if not faces:
        return np.zeros((0, 2), dtype=np.float32), np.zeros((0, 3), dtype=np.uint32)
    return (
        np.asarray(verts, dtype=np.float32),
        np.asarray(faces, dtype=np.uint32),
    )


SHELL_OWNER = "shell"


def _build_scene_triangles(
    scene: dict, fixture_dir: Path
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Assemble one (vertices, faces, triangle_owners) triple covering
    every surface splats should hug: shell walls + floor + ceiling +
    per-object TSDF meshes. `triangle_owners` is a (num_faces,) string
    array whose entries are either `SHELL_OWNER` or a scene object_id,
    identifying the source mesh each triangle came from. The split
    pipeline uses this to assign each gaussian to the object whose
    surface it hugs so per-object sub-splats move with their mesh."""
    all_verts: list[np.ndarray] = []
    all_faces: list[np.ndarray] = []
    all_owners: list[str] = []
    offset = 0

    def _append(verts: np.ndarray, faces: np.ndarray, owner: str) -> None:
        nonlocal offset
        if len(verts) == 0 or len(faces) == 0:
            return
        all_verts.append(verts.astype(np.float32, copy=False))
        all_faces.append((faces + offset).astype(np.uint32, copy=False))
        all_owners.extend([owner] * len(faces))
        offset += len(verts)

    try:
        shell = scene["snapshot"]["state"]["room"]["shell"]
        surfaces = shell.get("surfaces") or []
        floor_verts_raw = shell["floor_polygon"]["vertices"]
        ceiling = float(shell["ceiling_height"])
    except (KeyError, TypeError):
        surfaces = []
        floor_verts_raw = []
        ceiling = 0.0

    for s in surfaces:
        if s.get("type") != "wall":
            continue
        wf = _wall_verts_faces(s)
        if wf is not None:
            _append(wf[0], wf[1], SHELL_OWNER)

    if len(floor_verts_raw) >= 3:
        poly = Polygon([(float(v["x"]), float(v["y"])) for v in floor_verts_raw])
        if not poly.is_valid:
            poly = poly.buffer(0)
        if poly.is_valid and not poly.is_empty:
            v2d, f = _triangulate_polygon(poly)
            if len(f) > 0:
                floor_v = np.hstack([v2d, np.zeros((len(v2d), 1), dtype=np.float32)])
                _append(floor_v, f, SHELL_OWNER)
                ceiling_v = np.hstack([v2d, np.full((len(v2d), 1), ceiling, dtype=np.float32)])
                _append(ceiling_v, f, SHELL_OWNER)

    manifest_path = fixture_dir / "meshes" / "manifest.json"
    if manifest_path.exists():
        try:
            manifest = json.loads(manifest_path.read_text())
        except (json.JSONDecodeError, OSError):
            manifest = {}
        for oid, rel in (manifest.get("meshes") or {}).items():
            mp = fixture_dir / rel
            if not mp.exists():
                continue
            try:
                mesh = o3d.io.read_triangle_mesh(str(mp))
                mv = np.asarray(mesh.vertices, dtype=np.float32)
                mf = np.asarray(mesh.triangles, dtype=np.uint32)
                if len(mv) == 0 or len(mf) == 0:
                    continue
                _append(mv, mf, str(oid))
            except Exception:
                continue

    if not all_verts:
        return (
            np.zeros((0, 3), dtype=np.float32),
            np.zeros((0, 3), dtype=np.uint32),
            np.zeros((0,), dtype=object),
        )
    return (
        np.concatenate(all_verts, axis=0),
        np.concatenate(all_faces, axis=0),
        np.asarray(all_owners, dtype=object),
    )


def clean_ply(
    ply_path: Path,
    fixture_dir: Path,
    scene: dict,
    surface_band_m: float,
    density_radius_m: float,
    min_neighbors: int,
    min_opacity_logit: float,
    require_near_mesh: bool = False,
) -> tuple[PlyElement, dict, dict]:
    data = PlyData.read(str(ply_path))
    vertex = data["vertex"]
    count_in = len(vertex)

    positions = np.stack([
        np.asarray(vertex["x"], dtype=np.float32),
        np.asarray(vertex["y"], dtype=np.float32),
        np.asarray(vertex["z"], dtype=np.float32),
    ], axis=-1)
    opacity_logit = np.asarray(vertex["opacity"], dtype=np.float32)

    keep = np.ones(count_in, dtype=bool)
    stats: dict = {"count_in": count_in}

    poly_info = _floor_polygon(scene)
    removed_polygon = 0
    if poly_info is not None:
        polygon, ceiling = poly_info
        inside_xy = shapely_contains(polygon, positions[:, 0], positions[:, 1])
        z_ok = (positions[:, 2] >= -FLOOR_SLACK_Z_M) & (
            positions[:, 2] <= ceiling + CEILING_SLACK_Z_M
        )
        poly_mask = inside_xy & z_ok
        removed_polygon = int((~poly_mask & keep).sum())
        keep &= poly_mask
    stats["removed_polygon_clip"] = removed_polygon

    scene_verts, scene_faces, triangle_owners = _build_scene_triangles(scene, fixture_dir)
    stats["scene_mesh_vertex_count"] = int(len(scene_verts))
    stats["scene_mesh_face_count"] = int(len(scene_faces))

    # Per-gaussian owner assignment (used later for per-object splat
    # splitting). Default everyone to SHELL_OWNER; overwritten for any
    # gaussian whose nearest triangle belongs to an object mesh.
    gaussian_owners = np.full(count_in, SHELL_OWNER, dtype=object)

    removed_gate = 0
    if len(scene_faces) > 0 and keep.any():
        raycast = o3d.t.geometry.RaycastingScene()
        raycast.add_triangles(
            o3d.core.Tensor(scene_verts, dtype=o3d.core.Dtype.Float32),
            o3d.core.Tensor(scene_faces, dtype=o3d.core.Dtype.UInt32),
        )
        positions_tensor = o3d.core.Tensor(positions.astype(np.float32), dtype=o3d.core.Dtype.Float32)
        closest = raycast.compute_closest_points(positions_tensor)
        # primitive_ids is a (N,) int32 tensor of triangle indices in
        # the concatenated mesh; map each back to its source object.
        primitive_ids = closest["primitive_ids"].numpy().astype(np.int64)
        # Clamp to valid range just in case; then look up owners.
        primitive_ids = np.clip(primitive_ids, 0, len(triangle_owners) - 1)
        gaussian_owners = triangle_owners[primitive_ids]
        # Per-gaussian surface distance via the closest hit point.
        closest_points = closest["points"].numpy()
        diff = closest_points - positions.astype(np.float32)
        surf_dist = np.linalg.norm(diff, axis=1)
        near_mesh_mask = surf_dist < surface_band_m

        if require_near_mesh:
            gate_mask = near_mesh_mask
            stats["gate_mode"] = "surface_band_only"
            stats["kept_by_surface_band"] = int((near_mesh_mask & keep).sum())
        else:
            gauss_tree = cKDTree(positions)
            neighbor_counts = np.asarray(
                gauss_tree.query_ball_point(
                    positions, r=density_radius_m, return_length=True, workers=-1
                ),
                dtype=np.int32,
            )
            dense_mask = (neighbor_counts - 1) >= min_neighbors
            gate_mask = near_mesh_mask | dense_mask
            stats["gate_mode"] = "surface_band_or_density"
            stats["kept_by_surface_band"] = int((near_mesh_mask & keep).sum())
            stats["kept_by_density_floor_only"] = int(
                (dense_mask & ~near_mesh_mask & keep).sum()
            )

        removed_gate = int((~gate_mask & keep).sum())
        keep &= gate_mask
    stats["removed_gate"] = removed_gate

    opacity_mask = opacity_logit >= min_opacity_logit
    removed_opacity = int((~opacity_mask & keep).sum())
    keep &= opacity_mask
    stats["removed_opacity_cull"] = removed_opacity

    stats["count_out"] = int(keep.sum())
    new_vertex_data = vertex.data[keep]
    new_element = PlyElement.describe(new_vertex_data, "vertex")
    # Build a split record: for each owner we kept, carry the relevant
    # slice of the original vertex structured array so the caller can
    # write per-object PLYs without re-running closest-point queries.
    kept_owners = gaussian_owners[keep]
    split_payload: dict = {"owner_of_kept": kept_owners, "kept_vertex_data": new_vertex_data}
    stats["owner_counts"] = {
        str(owner): int((kept_owners == owner).sum())
        for owner in np.unique(kept_owners)
    }
    return new_element, stats, split_payload


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--fixture-id", required=True)
    parser.add_argument("--repo-root", type=Path, default=Path.cwd())
    parser.add_argument(
        "--ply",
        type=Path,
        default=None,
        help=(
            "PLY path relative to the fixture dir, e.g. "
            "'splats/brush-train/splat_brush_30000.ply'. Defaults to the "
            "latest splat_brush_*.ply in splats/brush-train/."
        ),
    )
    parser.add_argument("--surface-band-m", type=float, default=SURFACE_BAND_M)
    parser.add_argument("--density-radius-m", type=float, default=DENSITY_RADIUS_M)
    parser.add_argument("--min-neighbors", type=int, default=MIN_NEIGHBORS)
    parser.add_argument(
        "--require-near-mesh",
        action="store_true",
        help=(
            "Only keep gaussians within --surface-band-m of a scene mesh "
            "triangle. Disables the density floor."
        ),
    )
    parser.add_argument("--min-opacity-logit", type=float, default=OPACITY_LOGIT_MIN)
    parser.add_argument(
        "--patch-scene",
        action="store_true",
        help="Update scene.splat to point at the cleaned PLY.",
    )
    parser.add_argument(
        "--split-by-object",
        action="store_true",
        help=(
            "Also emit one PLY per object (plus a shell PLY) alongside the "
            "combined cleaned PLY, with a `splat_split.json` manifest. The "
            "web viewer can then load each PLY as its own sub-splat so "
            "moving a mesh moves its gaussians with it."
        ),
    )
    args = parser.parse_args()

    fixture_dir = (args.repo_root / "fixtures" / "roomplan" / args.fixture_id).resolve()
    if not fixture_dir.exists():
        raise SystemExit(f"fixture dir not found: {fixture_dir}")

    if args.ply is None:
        candidates = sorted((fixture_dir / "splats" / "brush-train").glob("splat_brush_*.ply"))
        candidates = [p for p in candidates if "_clean" not in p.name]
        if not candidates:
            raise SystemExit(
                f"no splat_brush_*.ply under {fixture_dir}/splats/brush-train"
            )
        ply_path = candidates[-1]
    else:
        ply_path = (fixture_dir / args.ply).resolve()
        if not ply_path.exists():
            raise SystemExit(f"ply not found: {ply_path}")

    scene = json.loads((fixture_dir / "scene.json").read_text())

    new_element, stats, split_payload = clean_ply(
        ply_path,
        fixture_dir=fixture_dir,
        scene=scene,
        surface_band_m=args.surface_band_m,
        density_radius_m=args.density_radius_m,
        min_neighbors=args.min_neighbors,
        min_opacity_logit=args.min_opacity_logit,
        require_near_mesh=args.require_near_mesh,
    )

    out_path = ply_path.with_name(ply_path.stem + "_clean.ply")
    PlyData([new_element], text=False).write(str(out_path))

    split_manifest: dict | None = None
    if args.split_by_object:
        split_dir = out_path.parent / (out_path.stem + "_split")
        split_dir.mkdir(parents=True, exist_ok=True)
        # Wipe previous splits so stale object PLYs don't accumulate.
        for prior in split_dir.glob("*.ply"):
            prior.unlink()
        owners = split_payload["owner_of_kept"]
        kept_data = split_payload["kept_vertex_data"]
        sub_entries: list[dict] = []
        for owner in sorted(set(owners.tolist())):
            mask = owners == owner
            count = int(mask.sum())
            if count == 0:
                continue
            sub_element = PlyElement.describe(kept_data[mask], "vertex")
            safe_name = str(owner)
            if owner != SHELL_OWNER:
                # Use the short tail of the object_id so filenames stay readable.
                safe_name = owner.split("-")[-1] if "-" in owner else owner
            sub_path = split_dir / f"splat_{safe_name}.ply"
            PlyData([sub_element], text=False).write(str(sub_path))
            rel_sub = sub_path.relative_to(fixture_dir).as_posix()
            sub_entries.append(
                {
                    "owner": str(owner),
                    "uri": f"/dev/fixtures/{args.fixture_id}/{rel_sub}",
                    "bytes": sub_path.stat().st_size,
                    "gaussian_count": count,
                }
            )
        manifest_path_split = split_dir / "splat_split.json"
        split_manifest = {
            "capture_id": args.fixture_id,
            "kind": "per-object-splat",
            "source_clean": str(out_path.relative_to(fixture_dir)),
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "sub_splats": sub_entries,
        }
        manifest_path_split.write_text(json.dumps(split_manifest, indent=2) + "\n")

    size_bytes = out_path.stat().st_size
    sha = hashlib.sha256(out_path.read_bytes()).hexdigest()
    splat_id = f"splat:brush-clean-{sha[:12]}"
    rel_path = out_path.relative_to(fixture_dir).as_posix()
    rel_uri = f"/dev/fixtures/{args.fixture_id}/{rel_path}"
    descriptor = {
        "splat_id": splat_id,
        "capture_id": args.fixture_id,
        "generator_kind": "brush-clean",
        "source_ply": str(ply_path.relative_to(fixture_dir)),
        "ply_uri": rel_uri,
        "ply_bytes_sha256": sha,
        "ply_bytes": size_bytes,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "cleanup_stats": stats,
        "params": {
            "polygon_slack_xy_m": POLYGON_SLACK_XY_M,
            "surface_band_m": args.surface_band_m,
            "density_radius_m": args.density_radius_m,
            "min_neighbors": args.min_neighbors,
            "min_opacity_logit": args.min_opacity_logit,
            "distance_mode": "open3d.t.RaycastingScene.compute_distance",
        },
    }
    out_path.with_suffix(".json").write_text(json.dumps(descriptor, indent=2) + "\n")

    if args.patch_scene:
        splat = scene.get("splat") or {}
        splat["status"] = "ready"
        splat["asset_id"] = splat_id
        splat["uri"] = rel_uri
        splat["updated_at"] = descriptor["generated_at"]
        if split_manifest is not None:
            rel_split = (
                out_path.parent / (out_path.stem + "_split") / "splat_split.json"
            ).relative_to(fixture_dir).as_posix()
            splat["split_manifest_uri"] = f"/dev/fixtures/{args.fixture_id}/{rel_split}"
        else:
            splat.pop("split_manifest_uri", None)
        scene["splat"] = splat
        (fixture_dir / "scene.json").write_text(json.dumps(scene, indent=2) + "\n")
        manifest_path = fixture_dir.parent.parent / "manifest.json"
        if manifest_path.exists():
            now = datetime.now(timezone.utc).timestamp()
            os.utime(manifest_path, (now, now))

    print(json.dumps(descriptor, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
