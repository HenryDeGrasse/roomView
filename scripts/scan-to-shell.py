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


def _canonicalize_wall(wall: dict) -> dict:
    """
    Flip a wall's normal + offset so the normal sits in a canonical
    half-plane of horizontal directions. Open3D's plane normals are
    returned with arbitrary sign; canonicalizing first lets us cluster
    "the same wall" correctly regardless of which way the RANSAC fit
    happened to orient the normal.

    Canonical: n_x > 0, or if n_x ≈ 0, n_y > 0.
    """
    n = wall["normal"].copy()
    offset = wall["offset"]
    if n[0] < -1e-6 or (abs(n[0]) < 1e-6 and n[1] < 0):
        n = -n
        offset = -offset
    return {**wall, "normal": n, "offset": offset}


def _wall_azimuth(wall: dict) -> float:
    """Azimuth of a canonicalized wall normal in the XY plane, radians."""
    n = wall["normal"]
    return float(np.arctan2(n[1], n[0]))


def cluster_walls_by_direction(walls: list[dict], cluster_gap_deg: float = 15.0) -> list[list[dict]]:
    """
    Sort canonicalized walls by azimuth, split into clusters at any gap
    wider than `cluster_gap_deg`. Two parallel walls (room's front and
    back) end up in the same cluster since their normals both canonicalize
    to the same half-plane direction.
    """
    if not walls:
        return []
    sorted_walls = sorted(walls, key=_wall_azimuth)
    gap = np.radians(cluster_gap_deg)
    clusters: list[list[dict]] = [[sorted_walls[0]]]
    for w in sorted_walls[1:]:
        if _wall_azimuth(w) - _wall_azimuth(clusters[-1][-1]) < gap:
            clusters[-1].append(w)
        else:
            clusters.append([w])
    # Handle wrap-around: a wall near azimuth +π/2-ε and another near -π/2+ε
    # After canonicalization both are in [-π/2, π/2], so no wrap issue here.
    return clusters


def _cluster_direction(cluster: list[dict]) -> np.ndarray:
    """Inlier-weighted average of normals in a cluster, re-normalized."""
    weighted = np.zeros(3, dtype=np.float64)
    total = 0.0
    for w in cluster:
        weighted += w["normal"] * w["inlier_count"]
        total += w["inlier_count"]
    avg = weighted / max(total, 1.0)
    mag = np.linalg.norm(avg)
    if mag < 1e-6:
        return cluster[0]["normal"].copy()
    return avg / mag


def _cluster_extents(cluster: list[dict], direction: np.ndarray) -> tuple[float, float, list[dict]]:
    """
    Project each wall onto `direction` and return (min_d, max_d, ordered_walls).
    A wall's signed distance from origin along `direction` is the solution
    of `direction · x = signed_d` for any x on the plane. For a plane
    `n · x + offset = 0` (n the wall's canonicalized normal, |n|=1), the
    signed distance along `direction` is `-offset * sign(n · direction)`.
    """
    distances = []
    for w in cluster:
        sign = float(np.sign(np.dot(w["normal"], direction)))
        if sign == 0:
            sign = 1.0
        distances.append((float(-w["offset"]) * sign, w))
    distances.sort(key=lambda t: t[0])
    ordered_walls = [w for _, w in distances]
    d_values = [d for d, _ in distances]
    return d_values[0], d_values[-1], ordered_walls


def fit_rectangular_polygon(
    walls: list[dict],
    positions: np.ndarray,
) -> tuple[list[tuple[float, float]], tuple[np.ndarray, np.ndarray]] | None:
    """
    Two-step fit:
      1. Use detected wall planes to determine the room's rotation
         (primary wall direction + perpendicular).
      2. Use percentiles of the splat point cloud along those
         directions to determine room EXTENT — more robust than relying
         on RANSAC to find the exact back-wall plane, which often has
         fewer inliers than front walls in one-sided captures.

    Returns (corners_ccw, (dir_a, dir_b)) where corners are 2D (x, y)
    tuples in the scene frame (no translation applied). Returns None if
    we can't form a rectangular room (fewer than 2 near-perpendicular
    wall clusters).
    """
    if not walls:
        return None
    canon = [_canonicalize_wall(w) for w in walls]
    clusters = cluster_walls_by_direction(canon)
    if not clusters:
        return None
    # Rank clusters by total inlier count — biggest wall sets first.
    ranked = sorted(
        clusters,
        key=lambda c: -sum(w["inlier_count"] for w in c),
    )
    primary = ranked[0]
    primary_dir = _cluster_direction(primary)
    # Find the cluster most perpendicular to primary (dot product closest to 0).
    best_perp = None
    best_score = 1.0  # smaller |dot| is more perpendicular
    for c in ranked[1:]:
        d = _cluster_direction(c)
        dot = abs(float(np.dot(primary_dir, d)))
        if dot < best_score:
            best_score = dot
            best_perp = c
    if best_perp is None or best_score > 0.3:
        return None
    perp_dir = _cluster_direction(best_perp)
    # Orthogonalize perp_dir against primary_dir so the 2x2 intersection
    # solve is cleanly perpendicular even when the perpendicular cluster's
    # members are a couple of degrees off.
    perp_dir = perp_dir - primary_dir * float(np.dot(perp_dir, primary_dir))
    perp_mag = float(np.linalg.norm(perp_dir))
    if perp_mag < 1e-6:
        return None
    perp_dir = perp_dir / perp_mag

    # Step 2: project splat points onto each direction, use 2nd/98th
    # percentiles as extents. Percentiles (not min/max) tolerate outlier
    # splats that landed just outside the real room from depth noise.
    EXTENT_PERCENTILES = (2.0, 98.0)
    dir_a_xy = primary_dir[:2]
    dir_b_xy = perp_dir[:2]
    xy = positions[:, :2].astype(np.float64)
    proj_a = xy @ dir_a_xy
    proj_b = xy @ dir_b_xy
    min_a = float(np.percentile(proj_a, EXTENT_PERCENTILES[0]))
    max_a = float(np.percentile(proj_a, EXTENT_PERCENTILES[1]))
    min_b = float(np.percentile(proj_b, EXTENT_PERCENTILES[0]))
    max_b = float(np.percentile(proj_b, EXTENT_PERCENTILES[1]))

    # Solve intersection in XY for each corner.
    def intersect_xy(d_a: float, d_b: float) -> tuple[float, float]:
        M = np.array([
            [primary_dir[0], primary_dir[1]],
            [perp_dir[0], perp_dir[1]],
        ], dtype=np.float64)
        rhs = np.array([d_a, d_b], dtype=np.float64)
        xy = np.linalg.solve(M, rhs)
        return float(xy[0]), float(xy[1])

    raw_corners = [
        intersect_xy(min_a, min_b),
        intersect_xy(max_a, min_b),
        intersect_xy(max_a, max_b),
        intersect_xy(min_a, max_b),
    ]
    centroid = (sum(c[0] for c in raw_corners) / 4.0, sum(c[1] for c in raw_corners) / 4.0)
    corners_ccw = sorted(
        raw_corners,
        key=lambda p: np.arctan2(p[1] - centroid[1], p[0] - centroid[0]),
    )
    return corners_ccw, (primary_dir, perp_dir)


def pick_dominant_horizontal_plane(planes: list[dict], prefer: str) -> dict | None:
    """Pick the floor (lowest z_plane) or ceiling (highest z_plane), ranked by inlier count."""
    if not planes:
        return None
    if prefer == "floor":
        planes_sorted = sorted(planes, key=lambda p: (p["z_plane"], -p["inlier_count"]))
    else:
        planes_sorted = sorted(planes, key=lambda p: (-p["z_plane"], -p["inlier_count"]))
    return planes_sorted[0]


def _edge_length(p0: tuple[float, float], p1: tuple[float, float]) -> float:
    return float(np.hypot(p1[0] - p0[0], p1[1] - p0[1]))


def build_shell_update_from_polygon(
    corners_ccw: list[tuple[float, float]],
    floor: dict | None,
    ceiling: dict | None,
    existing_scene: dict,
) -> dict:
    """
    Build the new shell given 4 CCW corners of a (possibly rotated)
    floor polygon. Each wall's `surface_frame` is derived from its
    corner pair: u_axis along the edge, v_axis = +Z up, normal rotated
    90° CCW from u_axis (pointing inward since corners are CCW).
    """
    old_shell = existing_scene["snapshot"]["state"]["room"]["shell"]
    floor_z = float(floor["z_plane"]) if floor else 0.0
    ceil_z = float(ceiling["z_plane"]) if ceiling else floor_z + float(old_shell.get("ceiling_height", 2.4))
    ceiling_height = max(1.8, ceil_z - floor_z)

    new_floor_vertices = [{"x": float(x), "y": float(y)} for x, y in corners_ccw]

    # Match each detected wall edge to one of the existing 4 wall surfaces
    # by orientation. Existing surfaces carry the old `surface_frame.normal`
    # — we pick the new wall whose inward normal is closest to it. This
    # preserves IDs + named_wall_ref bindings through the geometry swap.
    old_surfaces = old_shell["surfaces"]
    old_walls = [s for s in old_surfaces if s["type"] == "wall"]
    used_old_wall_ids: set[str] = set()

    def match_old_wall(new_normal: np.ndarray) -> dict | None:
        best = None
        best_dot = -2.0
        for s in old_walls:
            if s["surface_id"] in used_old_wall_ids:
                continue
            frame = s.get("surface_frame") or {}
            n = frame.get("normal") or {"x": 0, "y": 0, "z": 0}
            old_n = np.array([float(n["x"]), float(n["y"]), float(n["z"])])
            mag = float(np.linalg.norm(old_n))
            if mag < 1e-6:
                continue
            old_n = old_n / mag
            dot = float(np.dot(new_normal, old_n))
            if dot > best_dot:
                best_dot = dot
                best = s
        if best is not None:
            used_old_wall_ids.add(best["surface_id"])
        return best

    new_surfaces: list[dict] = []
    # Re-emit floor + ceiling with the new polygon vertices.
    for surf in old_surfaces:
        stype = surf.get("type")
        if stype in ("floor", "ceiling"):
            s_copy = json.loads(json.dumps(surf))
            s_copy["boundary"] = {"vertices": new_floor_vertices}
            new_surfaces.append(s_copy)
    # Four wall surfaces, one per polygon edge.
    for i in range(4):
        p0 = corners_ccw[i]
        p1 = corners_ccw[(i + 1) % 4]
        edge = np.array([p1[0] - p0[0], p1[1] - p0[1], 0.0])
        length = float(np.linalg.norm(edge))
        if length < 1e-6:
            continue
        u_axis = edge / length
        v_axis = np.array([0.0, 0.0, 1.0])
        # Inward normal is u_axis rotated +90° about +Z since corners are CCW.
        inward_normal = np.array([-u_axis[1], u_axis[0], 0.0])
        # Sanity check: point from midpoint toward polygon centroid.
        mid = 0.5 * (np.array([p0[0], p0[1]]) + np.array([p1[0], p1[1]]))
        centroid = np.mean(np.array(corners_ccw), axis=0)
        if np.dot(inward_normal[:2], centroid - mid) < 0:
            inward_normal = -inward_normal
        old_match = match_old_wall(inward_normal)
        if old_match is None:
            # Shouldn't happen for 4-walls ↔ 4-old-walls, but be defensive.
            surface_id = f"surface-wall-fit-{i}"
            named_ref = None
        else:
            surface_id = old_match["surface_id"]
            named_ref = old_match.get("named_wall_ref_id")
        wall_record = {
            "surface_id": surface_id,
            "type": "wall",
            "named_wall_ref_id": named_ref,
            "boundary": {"vertices": [
                {"x": 0.0, "y": 0.0},
                {"x": length, "y": 0.0},
                {"x": length, "y": ceiling_height},
                {"x": 0.0, "y": ceiling_height},
            ]},
            "surface_frame": {
                "origin": {"x": float(p0[0]), "y": float(p0[1]), "z": floor_z},
                "u_axis": {"x": float(u_axis[0]), "y": float(u_axis[1]), "z": float(u_axis[2])},
                "v_axis": {"x": float(v_axis[0]), "y": float(v_axis[1]), "z": float(v_axis[2])},
                "normal": {"x": float(inward_normal[0]), "y": float(inward_normal[1]), "z": float(inward_normal[2])},
            },
            # Carry over the material state / provenance from the matched
            # old wall if present, so rendered colors + confidence survive.
            "material_state": (old_match or {}).get("material_state"),
            "provenance": (old_match or {}).get("provenance"),
            "user_locked": (old_match or {}).get("user_locked", False),
        }
        new_surfaces.append(wall_record)

    return {
        "floor_polygon": {"vertices": new_floor_vertices},
        "ceiling_height": ceiling_height,
        "surfaces": new_surfaces,
    }


def _unused_compute_wall_aabb(
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


def _legacy_build_shell_update(
    walls: list[dict],
    floor: dict | None,
    ceiling: dict | None,
    existing_scene: dict,
) -> dict:
    """Construct the replacement shell block (preserving surface IDs)."""
    old_shell = existing_scene["snapshot"]["state"]["room"]["shell"]
    min_x, max_x, min_y, max_y = _unused_compute_wall_aabb(walls, floor)
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
        azimuth_deg = float(np.degrees(np.arctan2(n[1], n[0])))
        print(
            f"  plane[{i}] {kind:10s} n=({n[0]:+.2f},{n[1]:+.2f},{n[2]:+.2f}) "
            f"az={azimuth_deg:+6.1f}° "
            f"offset={p['offset']:+.2f} inliers={p['inlier_count']:6d} "
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

    fit = fit_rectangular_polygon(walls, positions)
    if fit is None:
        raise SystemExit(
            "failed to fit a rectangular polygon from the detected walls — "
            "need at least two near-perpendicular wall clusters"
        )
    corners_ccw, (dir_a, dir_b) = fit
    edge_lengths = [
        _edge_length(corners_ccw[i], corners_ccw[(i + 1) % 4]) for i in range(4)
    ]
    angle_ab_deg = float(np.degrees(np.arccos(abs(float(np.dot(dir_a, dir_b))))))
    print(
        f"[scan-to-shell] fitted polygon: "
        f"edges={edge_lengths[0]:.2f}×{edge_lengths[1]:.2f}m "
        f"wall-pair angle={angle_ab_deg:.1f}° "
        f"dir_a=({dir_a[0]:+.2f},{dir_a[1]:+.2f}) "
        f"dir_b=({dir_b[0]:+.2f},{dir_b[1]:+.2f})",
        file=sys.stderr,
    )
    for i, (x, y) in enumerate(corners_ccw):
        print(f"    corner[{i}] = ({x:+.2f}, {y:+.2f})", file=sys.stderr)

    update = build_shell_update_from_polygon(corners_ccw, floor, ceiling, scene)
    print(
        f"[scan-to-shell] new ceiling_height: {update['ceiling_height']:.2f}m",
        file=sys.stderr,
    )

    if args["dry_run"]:
        print(json.dumps(update["floor_polygon"], indent=2))
        return 0

    shell = scene["snapshot"]["state"]["room"]["shell"]
    shell["floor_polygon"] = update["floor_polygon"]
    shell["ceiling_height"] = update["ceiling_height"]
    shell["surfaces"] = update["surfaces"]

    scene_path.write_text(json.dumps(scene, indent=2) + "\n")
    print(f"[scan-to-shell] wrote updated scene to {scene_path}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
