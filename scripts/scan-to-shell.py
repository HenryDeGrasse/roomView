#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = [
#   "numpy>=1.26",
#   "open3d>=0.18",
# ]
# ///
"""
Fit a real room shell (walls + floor + ceiling) from the committed splat
point cloud, replacing the synthesized shell that `arkitscenes-to-bundle.py`
derives from OBB AABB + 40cm padding.

Pipeline:
  1. Read the fixture's .splat positions.
  2. Iteratively run Open3D's RANSAC `segment_plane` to peel off the
     largest planes: floor + ceiling + walls.
  3. Classify each plane by normal orientation. Horizontal (|n.z|>0.95)
     → floor/ceiling. Vertical (|n.z|<0.1) → wall.
  4. Snap wall normals to the nearest cardinal direction when within 8°
     — bedrooms are axis-aligned to within capture noise.
  5. For a rectangular room (the typical case for ARKitScenes bedrooms),
     take the min/max X and Y inlier extents across all walls as the
     floor polygon AABB. Floor/ceiling Z come from the plane models.
  6. Rewrite scene.shell.floor_polygon, ceiling_height, and the four
     wall `surface_frame`s in place. Surface IDs are preserved so
     downstream splat/mesh manifests stay valid.

Usage:
    uv run scripts/scan-to-shell.py --fixture-id fixture-bedroom-arkitscenes

Writes the updated scene.json back to the fixture directory. The original
is replaced — commit it alongside the regenerated splat/meshes.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

import numpy as np
import open3d as o3d


# RANSAC tuning. These defaults work on the committed fixture's 355k
# gaussian bedroom; other scene scales may need adjustment.
PLANE_DIST_THRESHOLD_M = 0.04       # inlier if within 4cm of plane
PLANE_RANSAC_SAMPLES = 3             # minimum for a 3D plane
PLANE_RANSAC_ITERATIONS = 500        # good/fast for our point counts
MAX_PLANES_TO_EXTRACT = 12           # peel off at most 12 before stopping
MIN_INLIERS_PER_PLANE = 3000         # anything smaller is noise / furniture
HORIZONTAL_NORMAL_Z_THRESHOLD = 0.95 # |n.z| above this → floor/ceiling
VERTICAL_NORMAL_Z_THRESHOLD = 0.15   # |n.z| below this → wall
WALL_SNAP_ANGLE_DEG = 8.0            # snap wall normals to cardinal within this
MIN_WALL_INLIER_HEIGHT_M = 1.0       # a wall's inliers must span >1m vertically


def parse_args(argv: list[str]) -> dict[str, Any]:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--fixture-id", required=True)
    parser.add_argument("--repo-root", type=Path, default=Path.cwd())
    parser.add_argument("--dry-run", action="store_true", help="Print the new shell but don't rewrite scene.json")
    return vars(parser.parse_args(argv))


def load_splat_positions(fixture_dir: Path) -> np.ndarray:
    """Extract (N, 3) float32 positions from the committed .splat file."""
    splats_dir = fixture_dir / "splats"
    splat_files = list(splats_dir.glob("*.splat"))
    if not splat_files:
        raise SystemExit(f"no .splat file found under {splats_dir}")
    if len(splat_files) > 1:
        raise SystemExit(f"expected exactly one .splat, found {len(splat_files)}")
    data = splat_files[0].read_bytes()
    # antimatter15 format: 32 bytes per gaussian, positions at offset 0 (float32 x3).
    strided = np.frombuffer(data, dtype=np.float32).reshape(-1, 8)
    return strided[:, :3].copy()


def iterative_ransac_planes(
    positions: np.ndarray,
) -> list[dict[str, Any]]:
    """
    Peel off planes one at a time until we run out of large planar
    regions. Each returned dict has `normal` (unit vector), `offset`
    (plane equation: normal·x + offset = 0), and `inlier_points`.
    """
    pcd = o3d.geometry.PointCloud()
    pcd.points = o3d.utility.Vector3dVector(positions.astype(np.float64))
    planes: list[dict[str, Any]] = []
    remaining = pcd
    for step in range(MAX_PLANES_TO_EXTRACT):
        remaining_pts = np.asarray(remaining.points)
        if remaining_pts.shape[0] < MIN_INLIERS_PER_PLANE:
            break
        model, inlier_indices = remaining.segment_plane(
            distance_threshold=PLANE_DIST_THRESHOLD_M,
            ransac_n=PLANE_RANSAC_SAMPLES,
            num_iterations=PLANE_RANSAC_ITERATIONS,
        )
        if len(inlier_indices) < MIN_INLIERS_PER_PLANE:
            break
        a, b, c, d = model
        normal = np.array([a, b, c], dtype=np.float64)
        mag = np.linalg.norm(normal)
        if mag < 1e-6:
            break
        normal /= mag
        offset = float(d) / mag
        inlier_pts = remaining_pts[inlier_indices]
        planes.append({
            "step": step,
            "normal": normal,
            "offset": offset,
            "inlier_count": int(len(inlier_indices)),
            "inlier_points": inlier_pts,
        })
        remaining = remaining.select_by_index(inlier_indices, invert=True)
    return planes


def classify_planes(planes: list[dict[str, Any]]) -> tuple[list[dict], list[dict], list[dict]]:
    """
    Separate planes into (floors, ceilings, walls) by normal direction.
    """
    floors: list[dict] = []
    ceilings: list[dict] = []
    walls: list[dict] = []
    for plane in planes:
        nz = plane["normal"][2]
        if abs(nz) > HORIZONTAL_NORMAL_Z_THRESHOLD:
            # z = -offset/nz when plane eq is normal·x + offset = 0
            z_plane = -plane["offset"] / nz
            plane["z_plane"] = z_plane
            if z_plane < 1.0:
                floors.append(plane)
            else:
                ceilings.append(plane)
        elif abs(nz) < VERTICAL_NORMAL_Z_THRESHOLD:
            # Drop walls whose inliers don't cover a meaningful vertical range
            # (small wall = probably side of a wardrobe, not a room wall).
            z_col = plane["inlier_points"][:, 2]
            z_range = float(z_col.max() - z_col.min())
            if z_range >= MIN_WALL_INLIER_HEIGHT_M:
                walls.append(plane)
    return floors, ceilings, walls


def snap_wall_normal(normal: np.ndarray) -> np.ndarray:
    """Snap a (nearly) axis-aligned wall normal to the nearest cardinal."""
    n_horiz = normal.copy()
    n_horiz[2] = 0.0
    mag = np.linalg.norm(n_horiz)
    if mag < 1e-6:
        return normal
    n_horiz /= mag
    # Candidates: ±X, ±Y
    candidates = np.array([[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0]], dtype=np.float64)
    dots = candidates @ n_horiz
    best = int(np.argmax(dots))
    angle_deg = np.degrees(np.arccos(np.clip(dots[best], -1, 1)))
    if angle_deg <= WALL_SNAP_ANGLE_DEG:
        return candidates[best].astype(np.float64)
    return normal


def pick_dominant_horizontal_plane(planes: list[dict], prefer: str) -> dict | None:
    """Pick the floor (lowest z_plane) or ceiling (highest z_plane), ranked by inlier count."""
    if not planes:
        return None
    if prefer == "floor":
        planes_sorted = sorted(planes, key=lambda p: (p["z_plane"], -p["inlier_count"]))
    else:
        planes_sorted = sorted(planes, key=lambda p: (-p["z_plane"], -p["inlier_count"]))
    return planes_sorted[0]


def compute_wall_aabb(
    walls: list[dict],
    floor: dict | None,
) -> tuple[float | None, float | None, float | None, float | None]:
    """
    Return (min_x, max_x, min_y, max_y) for a rectangular room.

    Strategy: group walls by whether their snapped normal is ±X or ±Y,
    compute each wall's plane position along that axis, and take the
    outermost plane as the room boundary. Open3D's plane normals point
    in either direction on a double-sided plane; "normal direction"
    alone doesn't tell us which side of a plane the room interior is
    on. So we look for the OUTERMOST detected planes per axis — those
    are the real room walls. Planes between the outermost pair are
    furniture surfaces (wardrobe, headboard, etc.) even if they
    registered as "wall-like" with a large inlier count.
    """
    axis_positions: dict[str, list[tuple[float, int]]] = {"x": [], "y": []}
    for wall in walls:
        snapped = snap_wall_normal(wall["normal"])
        snapped_int = tuple(int(round(c)) for c in snapped)
        if snapped_int in ((1, 0, 0), (-1, 0, 0)):
            # x = -offset/n_x. Use the snapped cardinal (sign doesn't
            # matter for position since -offset/(-1) = offset/1).
            n_x = float(snapped_int[0])
            pos = float(-wall["offset"] / n_x)
            axis_positions["x"].append((pos, wall["inlier_count"]))
        elif snapped_int in ((0, 1, 0), (0, -1, 0)):
            n_y = float(snapped_int[1])
            pos = float(-wall["offset"] / n_y)
            axis_positions["y"].append((pos, wall["inlier_count"]))
        # Skip non-cardinal walls entirely — they're probably tilted
        # furniture, not room walls.

    # Filter: only keep walls with at least 10% of the dominant wall's
    # inliers on that axis. Cuts interior furniture "side" walls that
    # occasionally pass the min-inlier threshold.
    def dominant_outer_pair(candidates: list[tuple[float, int]]) -> tuple[float | None, float | None]:
        if not candidates:
            return None, None
        max_inliers = max(c[1] for c in candidates)
        threshold = max_inliers * 0.10
        strong = [c for c in candidates if c[1] >= threshold]
        if not strong:
            strong = candidates
        positions = [c[0] for c in strong]
        return min(positions), max(positions)

    min_x, max_x = dominant_outer_pair(axis_positions["x"])
    min_y, max_y = dominant_outer_pair(axis_positions["y"])
    return min_x, max_x, min_y, max_y


def build_shell_update(
    walls: list[dict],
    floor: dict | None,
    ceiling: dict | None,
    existing_scene: dict,
) -> dict:
    """Construct the replacement shell block (preserving surface IDs)."""
    old_shell = existing_scene["snapshot"]["state"]["room"]["shell"]
    min_x, max_x, min_y, max_y = compute_wall_aabb(walls, floor)
    # Fall back to old shell extents for any missing wall.
    old_floor_verts = old_shell["floor_polygon"]["vertices"]
    old_xs = [float(v["x"]) for v in old_floor_verts]
    old_ys = [float(v["y"]) for v in old_floor_verts]
    if min_x is None: min_x = min(old_xs)
    if max_x is None: max_x = max(old_xs)
    if min_y is None: min_y = min(old_ys)
    if max_y is None: max_y = max(old_ys)

    # Normalize the room so min corner sits at world origin — that's the
    # invariant the rest of the pipeline (and the OBBs already-shifted by
    # the adapter) expect.
    shift_x = -min_x
    shift_y = -min_y
    min_x += shift_x; max_x += shift_x
    min_y += shift_y; max_y += shift_y

    floor_z = float(floor["z_plane"]) if floor else 0.0
    ceil_z = float(ceiling["z_plane"]) if ceiling else float(old_shell.get("ceiling_height", 2.4))
    ceiling_height = max(1.8, ceil_z - floor_z)

    new_floor_vertices = [
        {"x": 0.0, "y": 0.0},
        {"x": max_x, "y": 0.0},
        {"x": max_x, "y": max_y},
        {"x": 0.0, "y": max_y},
    ]
    # Update each wall surface's boundary + surface_frame. Surface IDs and
    # named_wall_ref bindings stay intact — we only rewrite the geometry.
    new_surfaces: list[dict] = []
    for surf in old_shell["surfaces"]:
        stype = surf.get("type")
        s_copy = json.loads(json.dumps(surf))  # deep clone
        if stype == "floor":
            s_copy["boundary"] = {"vertices": new_floor_vertices}
        elif stype == "ceiling":
            s_copy["boundary"] = {"vertices": new_floor_vertices}
        elif stype == "wall":
            frame = s_copy.get("surface_frame") or {}
            normal = frame.get("normal") or {}
            # Figure out which cardinal wall this is by the old normal.
            nx, ny = float(normal.get("x", 0)), float(normal.get("y", 0))
            width = max_x if abs(nx) < 0.5 else max_y
            height = ceiling_height
            s_copy["boundary"] = {"vertices": [
                {"x": 0.0, "y": 0.0},
                {"x": width, "y": 0.0},
                {"x": width, "y": height},
                {"x": 0.0, "y": height},
            ]}
            # Update origin along the cardinal axis.
            origin = dict(frame.get("origin", {"x": 0, "y": 0, "z": 0}))
            if (nx, ny) == (0, -1):           # north wall → origin at y=max
                origin = {"x": 0, "y": max_y, "z": 0}
            elif (nx, ny) == (0, 1):          # south wall → origin at y=0
                origin = {"x": max_x, "y": 0, "z": 0}
            elif (nx, ny) == (-1, 0):         # east wall → origin at x=max
                origin = {"x": max_x, "y": max_y, "z": 0}
            elif (nx, ny) == (1, 0):          # west wall → origin at x=0
                origin = {"x": 0, "y": 0, "z": 0}
            s_copy["surface_frame"] = {**frame, "origin": origin}
        new_surfaces.append(s_copy)

    return {
        "floor_polygon": {"vertices": new_floor_vertices},
        "ceiling_height": ceiling_height,
        "surfaces": new_surfaces,
        "shift_applied": {"x": shift_x, "y": shift_y, "ceiling": ceiling_height},
    }


def apply_shift_to_scene(scene: dict, shift_x: float, shift_y: float) -> None:
    """
    Re-anchor the scene's objects + captured_frame poses after the shell
    has been shifted. Keeps everything in a consistent world where the
    new floor polygon sits at (0, 0).
    """
    for obj in scene["snapshot"]["state"]["room"]["objects"]:
        obj["pose"]["position"]["x"] += shift_x
        obj["pose"]["position"]["y"] += shift_y
        obj["obb"]["center"]["x"] += shift_x
        obj["obb"]["center"]["y"] += shift_y
    for frame in scene.get("captured_frames", []):
        # column-major flat 16: tx = index 12, ty = index 13
        frame["camera_transform"][12] += shift_x
        frame["camera_transform"][13] += shift_y


def main() -> int:
    args = parse_args(sys.argv[1:])
    fixture_dir = (args["repo_root"] / "fixtures" / "roomplan" / args["fixture_id"]).resolve()
    if not fixture_dir.exists():
        raise SystemExit(f"fixture dir not found: {fixture_dir}")

    scene_path = fixture_dir / "scene.json"
    scene = json.loads(scene_path.read_text())

    positions = load_splat_positions(fixture_dir)
    print(f"[scan-to-shell] loaded {positions.shape[0]} splat positions", file=sys.stderr)

    planes = iterative_ransac_planes(positions)
    print(f"[scan-to-shell] extracted {len(planes)} planes via RANSAC", file=sys.stderr)
    floors, ceilings, walls = classify_planes(planes)
    print(
        f"[scan-to-shell] classified: {len(floors)} floor, "
        f"{len(ceilings)} ceiling, {len(walls)} wall candidates",
        file=sys.stderr,
    )
    for i, p in enumerate(planes):
        n = p["normal"]
        kind = ("horizontal" if abs(n[2]) > HORIZONTAL_NORMAL_Z_THRESHOLD
                else "wall" if abs(n[2]) < VERTICAL_NORMAL_Z_THRESHOLD
                else "tilted")
        pts = p["inlier_points"]
        snap = snap_wall_normal(n)
        print(
            f"  plane[{i}] {kind:10s} n=({n[0]:+.2f},{n[1]:+.2f},{n[2]:+.2f}) "
            f"snapped=({snap[0]:+.1f},{snap[1]:+.1f},{snap[2]:+.1f}) "
            f"offset={p['offset']:+.2f} inliers={p['inlier_count']:6d} "
            f"X[{pts[:,0].min():.2f},{pts[:,0].max():.2f}] "
            f"Y[{pts[:,1].min():.2f},{pts[:,1].max():.2f}] "
            f"Z[{pts[:,2].min():.2f},{pts[:,2].max():.2f}]",
            file=sys.stderr,
        )

    if not walls:
        raise SystemExit("no wall planes found — RANSAC failed to find vertical surfaces")

    floor = pick_dominant_horizontal_plane(floors, prefer="floor")
    ceiling = pick_dominant_horizontal_plane(ceilings, prefer="ceiling")
    if floor is None:
        print("[scan-to-shell] WARN: no floor plane detected, defaulting z=0", file=sys.stderr)
    if ceiling is None:
        print("[scan-to-shell] WARN: no ceiling plane detected, defaulting to old ceiling_height", file=sys.stderr)

    update = build_shell_update(walls, floor, ceiling, scene)
    shift = update.pop("shift_applied")
    print(
        f"[scan-to-shell] new floor polygon AABB: "
        f"X[0..{update['floor_polygon']['vertices'][1]['x']:.2f}] "
        f"Y[0..{update['floor_polygon']['vertices'][2]['y']:.2f}]",
        file=sys.stderr,
    )
    print(f"[scan-to-shell] new ceiling_height: {update['ceiling_height']:.2f}m", file=sys.stderr)
    print(f"[scan-to-shell] re-anchor shift: dx={shift['x']:.2f}, dy={shift['y']:.2f}", file=sys.stderr)

    if args["dry_run"]:
        print(json.dumps(update["floor_polygon"], indent=2))
        return 0

    # Apply the shift to objects + captured_frames so everything stays consistent.
    if abs(shift["x"]) > 1e-6 or abs(shift["y"]) > 1e-6:
        apply_shift_to_scene(scene, shift["x"], shift["y"])

    shell = scene["snapshot"]["state"]["room"]["shell"]
    shell["floor_polygon"] = update["floor_polygon"]
    shell["ceiling_height"] = update["ceiling_height"]
    shell["surfaces"] = update["surfaces"]

    scene_path.write_text(json.dumps(scene, indent=2) + "\n")
    print(f"[scan-to-shell] wrote updated scene to {scene_path}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
