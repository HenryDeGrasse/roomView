#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = [
#   "numpy>=1.26",
#   "pillow>=10",
# ]
# ///
"""
Convert an ARKitScenes 3DOD scene into a Milestone 1 capture bundle.

Input:  an unzipped ARKitScenes 3DOD scene directory (the layout Apple
        publishes inside `<scene_id>.zip`), e.g.
            <scene>/
              <scene_id>_3dod_annotation.json
              <scene_id>_3dod_mesh.ply
              <scene_id>_frames/
                lowres_wide/*.png           (RGB)
                lowres_depth/*.png          (uint16 depth, millimeters)
                lowres_wide_intrinsics/*.pincam
                lowres_wide.traj            (timestamp + Rodrigues rx ry rz + tx ty tz)

Output: a Milestone 1 bundle that matches what
        ios/RoomViewCapture/Sources/RoomViewCapture/CaptureBundleWriter.swift
        writes on-device, and is consumed by
        scripts/import-capture-bundle.mts and scripts/bundle-to-phase0.mts.

Key design choices
------------------
1. Coordinate convention. Both ARKitScenes and the RoomView scene
   graph use right-handed Z-up (the fixture in
   fixtures/roomplan/bedroom-primary confirms this: bed.size_z=0.6 is
   the bed's vertical height, objects at z=0 are floor-mounted). We
   keep the ARKitScenes camera transforms and OBBs in their native
   frame — no remap. Caveat: this does *not* match ARKit's runtime
   world-frame convention (Y-up) that an on-device iPhone bundle
   emits. That mismatch is documented in pose-conventions.md and is a
   deliberate RoomView choice (Z-up scenes ease future USD/DXF export,
   per apps/web/src/viewer.js).

2. Room-local anchoring. The fixture writes its floor polygon in
   local u/v coordinates starting at (0, 0) with the coordinate_frame
   origin at the room's corner. We shift all object positions and
   camera transforms so the min-x/min-y corner sits at the world
   origin; this keeps object poses and floor-polygon coords in the
   same space and makes the 2D layout renderer happy.

3. Synthetic room shell. 3DOD publishes object annotations and a mesh,
   but no canonical floor/ceiling/wall polygons. We synthesize a
   bounding-box shell with four named walls (north/east/south/west)
   and a flat floor/ceiling. Mesh-based wall fitting and opening
   inference are real research-grade work — flagged as explicit
   follow-ups, not attempted here.

4. Category aliasing. ARKitScenes labels (bed, cabinet, chair, table,
   tv_monitor, sofa, shelf, ...) map to the RoomView editable classes
   where possible, otherwise fall back to generic_obstacle so ingest
   keeps the object as an obstacle without pretending it's editable.

5. Vertical normalization. Object annotations sometimes sit below z=0
   in the raw frame; we shift the whole scene up so the lowest object
   face sits at z=0 (floor level).

6. Depth format. lowres_depth is uint16 PNG in millimeters (0 means "no
   depth"). We convert to float32 meters in NumPy .npy, mapping 0 to
   NaN. That matches what the Swift bundle writer produces on-device,
   and the Phase 0 render bench consumes .npy via --depth-source
   manifest out of the box.
"""

from __future__ import annotations

import argparse
import io
import json
import math
import re
import shutil
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

import numpy as np
from PIL import Image

REPO_ROOT = Path(__file__).resolve().parent.parent
FIXTURE_CAPTURE_REQUEST = REPO_ROOT / "fixtures/roomplan/bedroom-primary/capture-request.json"

# EDITABLE_OBJECT_CLASSES mirrors packages/contracts/src/scene.ts. Unknown
# ARKitScenes labels fall through to "generic_obstacle" (the one ObjectClass
# value outside the editable set), which the ingest path accepts.
CATEGORY_ALIASES: dict[str, str] = {
    "bed": "bed",
    "sofa": "sofa",
    "chair": "chair",
    "stool": "chair",
    "table": "table",
    "desk": "desk",
    "tv_monitor": "television",
    "cabinet": "storage",
    "shelf": "bookshelf",
    "chest_of_drawers": "dresser",
    "wardrobe": "storage",
    "refrigerator": "storage",
    "nightstand": "nightstand",
    "lamp": "lamp",
    "rug": "rug",
}



@dataclass
class FrameSample:
    stem: str
    timestamp: str  # normalized "57260.492"-style string used as traj key
    rgb_path: Path
    depth_path: Path
    intrinsics_path: Path


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Convert an ARKitScenes 3DOD scene into a RoomView Milestone 1 capture bundle."
    )
    parser.add_argument(
        "--scene-dir",
        type=Path,
        required=True,
        help="Path to an unzipped ARKitScenes 3DOD scene directory (contains <id>_frames/ and <id>_3dod_annotation.json).",
    )
    parser.add_argument(
        "--out",
        type=Path,
        required=True,
        help="Output bundle directory. Will be overwritten if it exists.",
    )
    parser.add_argument(
        "--frames",
        type=int,
        default=6,
        help="Number of frames to sample from the trajectory (evenly spaced). Default: 6.",
    )
    parser.add_argument(
        "--scene-id",
        type=str,
        default=None,
        help="Override the capture_id embedded in the bundle manifest + roomplan_request.",
    )
    parser.add_argument(
        "--room-type",
        type=str,
        default="bedroom",
        help="Room type for the RoomPlanPayload (the ingest gate only accepts 'bedroom' today).",
    )
    parser.add_argument(
        "--ceiling-height",
        type=float,
        default=None,
        help="Override ceiling height in meters. Default: inferred from tallest object + 0.4 m, minimum 2.4 m.",
    )
    parser.add_argument(
        "--obb-shrink",
        type=float,
        default=0.2,
        help=(
            "Fractional shrink applied to each OBB's horizontal size (size_x, size_y). "
            "Default 0.2 (20%%) compensates for loose ARKitScenes hand-drawn bounding "
            "boxes that often overlap their neighbors by several centimeters, and for "
            "rotated OBBs whose projected footprint is larger than size_x*size_z. "
            "size_z (vertical) is untouched. Set to 0 to emit raw annotation sizes."
        ),
    )
    return parser.parse_args(argv)


def rodrigues_to_rotation(rvec: np.ndarray) -> np.ndarray:
    """Rodrigues rotation vector (3,) -> 3x3 rotation matrix."""
    theta = float(np.linalg.norm(rvec))
    if theta < 1e-12:
        return np.eye(3)
    k = rvec / theta
    kx, ky, kz = float(k[0]), float(k[1]), float(k[2])
    c, s = math.cos(theta), math.sin(theta)
    t = 1.0 - c
    return np.array(
        [
            [t * kx * kx + c, t * kx * ky - s * kz, t * kx * kz + s * ky],
            [t * kx * ky + s * kz, t * ky * ky + c, t * ky * kz - s * kx],
            [t * kx * kz - s * ky, t * ky * kz + s * kx, t * kz * kz + c],
        ]
    )


def load_trajectory(path: Path) -> dict[str, np.ndarray]:
    """Parse lowres_wide.traj into {timestamp_str: world_from_camera 4x4}.

    Each line is "timestamp rx ry rz tx ty tz" in the ARKitScenes world
    frame (Z-up). The raw (R, t) pair is camera-from-world (extrinsics);
    we invert to produce world-from-camera, which is what downstream
    bundle consumers expect.
    """
    poses: dict[str, np.ndarray] = {}
    for line in path.read_text().splitlines():
        tokens = line.split()
        if len(tokens) < 7:
            continue
        timestamp = normalize_timestamp(tokens[0])
        rvec = np.array([float(tokens[1]), float(tokens[2]), float(tokens[3])])
        t = np.array([float(tokens[4]), float(tokens[5]), float(tokens[6])])
        R = rodrigues_to_rotation(rvec)
        R_inv = R.T
        t_inv = -R_inv @ t
        pose = np.eye(4)
        pose[:3, :3] = R_inv
        pose[:3, 3] = t_inv
        poses[timestamp] = pose
    return poses


def normalize_timestamp(raw: str) -> str:
    # ARKitScenes timestamps appear both as "57260.49170696" in .traj and
    # "57260.492" in filenames. Round to 3 decimals so both formats hash
    # to the same key.
    return f"{round(float(raw), 3):.3f}"


def parse_pincam(path: Path) -> dict[str, float]:
    values = [float(x) for x in path.read_text().split()]
    width, height, fx, fy, cx, cy = values
    return {
        "fx": fx,
        "fy": fy,
        "cx": cx,
        "cy": cy,
        "width": width,
        "height": height,
    }


def encode_npy_float32(array: np.ndarray) -> bytes:
    """Serialize a 2D float32 array to NumPy v1.0 .npy bytes (descr='<f4')."""
    assert array.dtype == np.float32 and array.ndim == 2, "expected 2D float32"
    buf = io.BytesIO()
    np.lib.format.write_array(buf, array, version=(1, 0))
    return buf.getvalue()


def yaw_about_z_axis_degrees(R: np.ndarray) -> float:
    """Extract yaw about +Z from a 3x3 rotation matrix (Z-up world).

    For a yaw-only rotation R = [[c,-s,0],[s,c,0],[0,0,1]], we have
    R[1][0] = sin(yaw), R[0][0] = cos(yaw). Off-axis rotations are
    approximated as yaw-only (pitch/roll discarded).
    """
    return math.degrees(math.atan2(R[1, 0], R[0, 0]))


def alias_category(label: str) -> str:
    key = re.sub(r"[^a-z0-9]+", "_", label.strip().lower()).strip("_")
    return CATEGORY_ALIASES.get(key, "generic_obstacle")


def load_objects(
    annotation_path: Path, obb_shrink: float = 0.0
) -> tuple[list[dict[str, Any]], float, float, float, float, float, float]:
    """Parse 3DOD annotations and produce RoomPlanObjectSeed-shaped dicts.

    Returns (objects, min_x, max_x, min_y_horiz, max_y_horiz, min_z_vert,
    max_z_vert) in the native ARKitScenes Z-up frame. Extents drive
    shell synthesis and vertical normalization.

    `obb_shrink` in [0, 0.5) shrinks each OBB's horizontal footprint
    toward its center (size_x/size_y multiplied by 1 - shrink).
    Vertical size_z is untouched. Used to compensate for loose
    hand-drawn 3DOD annotations that often have bounding boxes
    overlapping their neighbors by a few cm.
    """
    if not 0.0 <= obb_shrink < 0.5:
        raise ValueError("obb_shrink must be in [0, 0.5)")
    horizontal_scale = 1.0 - obb_shrink

    payload = json.loads(annotation_path.read_text())
    objects: list[dict[str, Any]] = []
    lower_vert: list[float] = []
    upper_vert: list[float] = []
    all_x: list[float] = []
    all_y: list[float] = []

    for entry in payload.get("data", []):
        obb = entry["segments"]["obbAligned"]
        centroid = np.array(obb["centroid"], dtype=float)
        sizes = obb["axesLengths"]
        axes = np.array(obb["normalizedAxes"], dtype=float).reshape(3, 3)
        yaw = yaw_about_z_axis_degrees(axes)
        category = alias_category(str(entry["label"]))
        # ARKitScenes OBB axesLengths are along the object's local
        # axes 0/1/2. ARKitScenes objects are typically yaw-only, so
        # local axis 2 = world Z (vertical). Passing sizes through
        # in order preserves this: size_z stays vertical, matching
        # the RoomView fixture convention (bed.size_z = bed height).
        # Horizontal shrink tightens size_x/size_y to absorb annotation
        # slop without changing the object's position or vertical extent.
        size_x = float(sizes[0]) * horizontal_scale
        size_y = float(sizes[1]) * horizontal_scale
        size_z = float(sizes[2])
        object_record = {
            "id": str(entry.get("uid", f"object-{len(objects)}"))[:64],
            "category": category,
            "pose": {
                "position": {
                    "x": float(centroid[0]),
                    "y": float(centroid[1]),
                    "z": float(centroid[2]),
                },
                "yaw_degrees": yaw,
            },
            "obb": {
                "center": {
                    "x": float(centroid[0]),
                    "y": float(centroid[1]),
                    "z": float(centroid[2]),
                },
                "size_x": size_x,
                "size_y": size_y,
                "size_z": size_z,
                "yaw_degrees": yaw,
            },
            "attributes": [],
        }
        objects.append(object_record)
        # Vertical extent (Z-up): object spans centroid.z ± size_z/2.
        lower_vert.append(float(centroid[2]) - 0.5 * size_z)
        upper_vert.append(float(centroid[2]) + 0.5 * size_z)
        # Horizontal extent for shell sizing.
        all_x.append(float(centroid[0]) - 0.5 * size_x)
        all_x.append(float(centroid[0]) + 0.5 * size_x)
        all_y.append(float(centroid[1]) - 0.5 * size_y)
        all_y.append(float(centroid[1]) + 0.5 * size_y)

    if not objects:
        raise RuntimeError(f"{annotation_path} contains no object annotations")

    min_x = min(all_x) - 0.4
    max_x = max(all_x) + 0.4
    min_y = min(all_y) - 0.4
    max_y = max(all_y) + 0.4
    return objects, min_x, max_x, min_y, max_y, min(lower_vert), max(upper_vert)


def normalize_vertical(
    objects: list[dict[str, Any]], min_vertical: float, target_floor: float = 0.0
) -> float:
    """Shift all objects so the lowest face sits at target_floor along +Z."""
    shift = target_floor - min(0.0, min_vertical)
    if shift == 0.0:
        return 0.0
    for obj in objects:
        obj["pose"]["position"]["z"] += shift
        obj["obb"]["center"]["z"] += shift
    return shift


def _aabb_footprint(obj: dict[str, Any]) -> tuple[float, float, float, float]:
    """Axis-aligned bounds of a yaw-rotated OBB footprint on the XY plane.

    Matches the overlap check in apps/api/src/roomplan-ingest.ts
    (`footprintFromObb` + `polygonBounds`).
    """
    obb = obj["obb"]
    half_x = obb["size_x"] / 2.0
    half_y = obb["size_y"] / 2.0
    rad = math.radians(obb.get("yaw_degrees", 0.0))
    cos = math.cos(rad)
    sin = math.sin(rad)
    cx = obb["center"]["x"]
    cy = obb["center"]["y"]
    corners = [(-half_x, -half_y), (half_x, -half_y), (half_x, half_y), (-half_x, half_y)]
    xs = [cx + c[0] * cos - c[1] * sin for c in corners]
    ys = [cy + c[0] * sin + c[1] * cos for c in corners]
    return (min(xs), max(xs), min(ys), max(ys))


def _aabb_overlap_magnitude(a: tuple[float, float, float, float], b: tuple[float, float, float, float]) -> float:
    """Smallest axis overlap (positive) between two AABBs, or 0 if disjoint."""
    ax_min, ax_max, ay_min, ay_max = a
    bx_min, bx_max, by_min, by_max = b
    overlap_x = min(ax_max, bx_max) - max(ax_min, bx_min)
    overlap_y = min(ay_max, by_max) - max(ay_min, by_min)
    if overlap_x <= 0 or overlap_y <= 0:
        return 0.0
    return min(overlap_x, overlap_y)


def resolve_horizontal_overlaps(
    objects: list[dict[str, Any]],
    max_iterations: int = 40,
    step: float = 0.03,
) -> tuple[bool, int]:
    """Nudge overlapping objects apart along their center-to-center axis.

    Mirrors the ingest validator's overlap check (axis-aligned bounds of
    the rotated footprint), so once this converges the layout pane has
    zero OBJECT_OVERLAP violations. Returns (converged, iterations_run).
    Each iteration moves each member of an overlapping pair by `step`
    meters along the separation axis — a small value keeps scene
    geometry close to the original annotation.
    """
    n = len(objects)
    if n < 2:
        return True, 0
    for iteration in range(max_iterations):
        any_overlap = False
        for i in range(n):
            a = _aabb_footprint(objects[i])
            for j in range(i + 1, n):
                b = _aabb_footprint(objects[j])
                if _aabb_overlap_magnitude(a, b) <= 0:
                    continue
                any_overlap = True
                dx = objects[j]["pose"]["position"]["x"] - objects[i]["pose"]["position"]["x"]
                dy = objects[j]["pose"]["position"]["y"] - objects[i]["pose"]["position"]["y"]
                norm = math.hypot(dx, dy)
                if norm < 1e-6:
                    # Degenerate: coincident centers. Push along +X arbitrarily.
                    ux, uy = 1.0, 0.0
                else:
                    ux, uy = dx / norm, dy / norm
                for obj, sign in ((objects[i], -1.0), (objects[j], +1.0)):
                    obj["pose"]["position"]["x"] += sign * ux * step
                    obj["pose"]["position"]["y"] += sign * uy * step
                    obj["obb"]["center"]["x"] += sign * ux * step
                    obj["obb"]["center"]["y"] += sign * uy * step
        if not any_overlap:
            return True, iteration + 1
    return False, max_iterations


def synthesize_shell(
    width: float,
    length: float,
    ceiling_height: float,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Build floor/ceiling + four named walls in room-local coordinates.

    Z-up world; the floor polygon's 2D (x, y) maps to world (x, y) with
    world z = 0. `width` spans along +X, `length` spans along +Y, both
    anchored at the coordinate_frame origin. Callers pre-shift the
    scene so that corner sits at world (0, 0, 0).

    Walls are named via `WALL_NAME_TO_AZIMUTH` in roomplan-ingest.ts:
      north: wall at y = length, inward normal -Y
      south: wall at y = 0,      inward normal +Y
      east:  wall at x = width,  inward normal -X
      west:  wall at x = 0,      inward normal +X
    """
    floor_polygon = {
        "vertices": [
            {"x": 0.0, "y": 0.0},
            {"x": width, "y": 0.0},
            {"x": width, "y": length},
            {"x": 0.0, "y": length},
        ]
    }
    surfaces = [
        {
            "id": "floor",
            "category": "floor",
            "polygon": floor_polygon,
            "frame": None,
        },
        {
            "id": "ceiling",
            "category": "ceiling",
            "polygon": floor_polygon,
            "frame": {
                "origin": {"x": 0.0, "y": 0.0, "z": ceiling_height},
                "u_axis": {"x": 1, "y": 0, "z": 0},
                "v_axis": {"x": 0, "y": 1, "z": 0},
                "normal": {"x": 0, "y": 0, "z": -1},
            },
        },
    ]

    def wall(
        surface_id: str,
        span: float,
        height: float,
        origin: dict[str, float],
        u_axis: dict[str, float],
        v_axis: dict[str, float],
        normal: dict[str, float],
    ) -> dict[str, Any]:
        polygon = {
            "vertices": [
                {"x": 0.0, "y": 0.0},
                {"x": span, "y": 0.0},
                {"x": span, "y": height},
                {"x": 0.0, "y": height},
            ]
        }
        return {
            "id": surface_id,
            "category": "wall",
            "polygon": polygon,
            "frame": {
                "origin": origin,
                "u_axis": u_axis,
                "v_axis": v_axis,
                "normal": normal,
            },
        }

    walls = [
        wall(
            "north_wall",
            width,
            ceiling_height,
            {"x": 0.0, "y": length, "z": 0.0},
            {"x": 1, "y": 0, "z": 0},
            {"x": 0, "y": 0, "z": 1},
            {"x": 0, "y": -1, "z": 0},
        ),
        wall(
            "south_wall",
            width,
            ceiling_height,
            {"x": width, "y": 0.0, "z": 0.0},
            {"x": -1, "y": 0, "z": 0},
            {"x": 0, "y": 0, "z": 1},
            {"x": 0, "y": 1, "z": 0},
        ),
        wall(
            "east_wall",
            length,
            ceiling_height,
            {"x": width, "y": length, "z": 0.0},
            {"x": 0, "y": -1, "z": 0},
            {"x": 0, "y": 0, "z": 1},
            {"x": -1, "y": 0, "z": 0},
        ),
        wall(
            "west_wall",
            length,
            ceiling_height,
            {"x": 0.0, "y": 0.0, "z": 0.0},
            {"x": 0, "y": 1, "z": 0},
            {"x": 0, "y": 0, "z": 1},
            {"x": 1, "y": 0, "z": 0},
        ),
    ]
    return surfaces + walls, []  # openings intentionally empty — see module docstring


def select_frame_samples(
    frames_root: Path, requested: int, traj: dict[str, np.ndarray]
) -> list[FrameSample]:
    rgb_dir = frames_root / f"{frames_root.parent.name.split('_')[0]}_frames" / "lowres_wide"
    # The scene directory naming above is brittle — safer to walk the known layout directly.
    rgb_dir = frames_root / "lowres_wide"
    depth_dir = frames_root / "lowres_depth"
    intrinsics_dir = frames_root / "lowres_wide_intrinsics"
    rgb_files = sorted(rgb_dir.glob("*.png"))
    if not rgb_files:
        raise RuntimeError(f"No RGB frames found under {rgb_dir}")

    matched: list[FrameSample] = []
    for rgb in rgb_files:
        stem = rgb.stem
        depth = depth_dir / f"{stem}.png"
        intrinsics = intrinsics_dir / f"{stem}.pincam"
        if not (depth.exists() and intrinsics.exists()):
            continue
        parts = stem.split("_", 1)
        if len(parts) != 2:
            continue
        ts = normalize_timestamp(parts[1])
        if ts not in traj:
            continue
        matched.append(
            FrameSample(
                stem=stem,
                timestamp=ts,
                rgb_path=rgb,
                depth_path=depth,
                intrinsics_path=intrinsics,
            )
        )

    if not matched:
        raise RuntimeError(
            f"No frames with matching depth + intrinsics + trajectory found in {frames_root}"
        )

    if requested >= len(matched):
        return matched
    if requested <= 1:
        return [matched[len(matched) // 2]]
    stride = (len(matched) - 1) / (requested - 1)
    return [matched[int(round(i * stride))] for i in range(requested)]


def convert_depth_png(source: Path) -> tuple[np.ndarray, int, int]:
    """Read an ARKitScenes depth PNG (uint16 mm) and return float32 meters.

    Zeros (no-depth) are mapped to NaN per the pose-conventions doc.
    """
    img = Image.open(source)
    array = np.array(img)
    if array.dtype != np.uint16:
        raise RuntimeError(f"{source}: expected uint16 depth PNG, got {array.dtype}")
    meters = array.astype(np.float32) / 1000.0
    meters[array == 0] = float("nan")
    height, width = meters.shape
    return meters, width, height


def column_major_flat(pose_4x4: np.ndarray) -> list[float]:
    return [float(pose_4x4[row, col]) for col in range(4) for row in range(4)]


def load_base_roomplan_request() -> dict[str, Any]:
    return json.loads(FIXTURE_CAPTURE_REQUEST.read_text())


def write_bundle(args: argparse.Namespace) -> Path:
    scene_dir: Path = args.scene_dir.resolve()
    out_dir: Path = args.out.resolve()
    scene_id = args.scene_id or f"arkitscenes-{scene_dir.name}"

    if out_dir.exists():
        shutil.rmtree(out_dir)
    (out_dir / "frames").mkdir(parents=True, exist_ok=True)

    # Locate the scene-specific filenames by inspecting the directory.
    annotation_candidates = list(scene_dir.glob("*_3dod_annotation.json"))
    if not annotation_candidates:
        raise RuntimeError(f"No *_3dod_annotation.json under {scene_dir}")
    annotation_path = annotation_candidates[0]

    frames_root_candidates = [p for p in scene_dir.iterdir() if p.is_dir() and p.name.endswith("_frames")]
    if not frames_root_candidates:
        raise RuntimeError(f"No *_frames directory under {scene_dir}")
    frames_root = frames_root_candidates[0]

    traj_files = list(frames_root.glob("*.traj"))
    if not traj_files:
        raise RuntimeError(f"No .traj file under {frames_root}")
    traj_path = traj_files[0]

    traj = load_trajectory(traj_path)

    objects, _, _, _, _, min_vertical, max_vertical = load_objects(
        annotation_path, obb_shrink=args.obb_shrink
    )
    vertical_shift = normalize_vertical(objects, min_vertical)
    converged, overlap_iterations = resolve_horizontal_overlaps(objects)
    if not converged:
        print(
            f"[arkitscenes-to-bundle] warning: overlap relaxation did not converge "
            f"after {overlap_iterations} iterations; the editor may still show "
            f"OBJECT_OVERLAP violations.",
            flush=True,
        )
    # Recompute horizontal bounds from the (possibly nudged) positions.
    xs: list[float] = []
    ys: list[float] = []
    for obj in objects:
        obb = obj["obb"]
        xs.extend([obb["center"]["x"] - 0.5 * obb["size_x"], obb["center"]["x"] + 0.5 * obb["size_x"]])
        ys.extend([obb["center"]["y"] - 0.5 * obb["size_y"], obb["center"]["y"] + 0.5 * obb["size_y"]])
    min_x = min(xs) - 0.4
    max_x = max(xs) + 0.4
    min_y = min(ys) - 0.4
    max_y = max(ys) + 0.4
    # Anchor the room to local origin (0, 0, 0) so the synthesized floor
    # polygon in local u/v coords matches object positions in world
    # space. The fixture-format convention is: floor_polygon starts at
    # (0, 0); object poses share the same space.
    horizontal_shift_x = -min_x
    horizontal_shift_y = -min_y
    for obj in objects:
        obj["pose"]["position"]["x"] += horizontal_shift_x
        obj["pose"]["position"]["y"] += horizontal_shift_y
        obj["obb"]["center"]["x"] += horizontal_shift_x
        obj["obb"]["center"]["y"] += horizontal_shift_y
    for pose in traj.values():
        pose[0, 3] += horizontal_shift_x
        pose[1, 3] += horizontal_shift_y
        pose[2, 3] += vertical_shift

    width = max_x - min_x
    length = max_y - min_y
    ceiling_height_m = (
        args.ceiling_height
        if args.ceiling_height is not None
        else max(2.4, max_vertical + vertical_shift + 0.4)
    )
    shell_surfaces, openings = synthesize_shell(
        width,
        length,
        ceiling_height_m,
    )

    # Build RoomPlanCaptureRequest using the existing fixture as a shape
    # reference, then replace payload fields with adapted data. Keeping
    # schema_version identifies the capture_request as adapter-sourced.
    base = load_base_roomplan_request()
    base["request_id"] = f"arkitscenes-{scene_id}"
    base["client_capture_id"] = f"arkitscenes-{scene_id}"
    base["capture_metadata"]["device_model"] = "ARKitScenes 3DOD"
    base["capture_metadata"]["video_expected"] = True
    base["roomplan_payload"] = {
        "schema_version": "arkitscenes-adapter-v1",
        "room_type": args.room_type,
        "coordinate_frame": {
            "origin": {"x": 0.0, "y": 0.0, "z": 0.0},
            "x_axis": {"x": 1, "y": 0, "z": 0},
            "y_axis": {"x": 0, "y": 1, "z": 0},
            "z_axis": {"x": 0, "y": 0, "z": 1},
            "north_source": "scan_forward",
        },
        "dimensions": {
            "width_m": width,
            "length_m": length,
            "ceiling_height_m": ceiling_height_m,
        },
        "surfaces": shell_surfaces,
        "openings": openings,
        "objects": objects,
        "fixed_elements": [],
        "room_count": 1,
    }

    (out_dir / "roomplan_request.json").write_text(json.dumps(base, indent=2) + "\n")

    frame_samples = select_frame_samples(frames_root, args.frames, traj)
    manifest_frames: list[dict[str, Any]] = []
    for index, sample in enumerate(frame_samples, start=1):
        frame_id = f"frame_{index:06d}"
        rgb_rel = f"frames/{frame_id}.jpg"
        depth_rel = f"frames/{frame_id}.depth.npy"
        pose_rel = f"frames/{frame_id}.pose.json"
        intr_rel = f"frames/{frame_id}.intrinsics.json"

        # ARKitScenes lowres_wide is PNG; we transcode to JPEG so the
        # bundle mirrors the iOS CaptureBundleWriter output (RGB as JPEG
        # for upload-size reasons).
        Image.open(sample.rgb_path).convert("RGB").save(out_dir / rgb_rel, "JPEG", quality=92)

        depth_array, depth_width, depth_height = convert_depth_png(sample.depth_path)
        (out_dir / depth_rel).write_bytes(encode_npy_float32(depth_array))

        pose_matrix = traj[sample.timestamp]
        yaw = yaw_about_z_axis_degrees(pose_matrix[:3, :3])
        pose_record = {
            "camera_transform": column_major_flat(pose_matrix),
            "camera_pose": {
                "position": {
                    "x": float(pose_matrix[0, 3]),
                    "y": float(pose_matrix[1, 3]),
                    "z": float(pose_matrix[2, 3]),
                },
                "yaw_degrees": yaw,
            },
        }
        (out_dir / pose_rel).write_text(json.dumps(pose_record, indent=2) + "\n")

        intrinsics = parse_pincam(sample.intrinsics_path)
        (out_dir / intr_rel).write_text(json.dumps(intrinsics, indent=2) + "\n")

        manifest_frames.append(
            {
                "frame_id": frame_id,
                "captured_at": f"2026-04-19T00:00:{index:02d}.000Z",
                "rgb_path": rgb_rel,
                "depth_path": depth_rel,
                "confidence_path": None,
                "pose_path": pose_rel,
                "intrinsics_path": intr_rel,
            }
        )

    manifest = {
        "capture_id": scene_id,
        "roomplan_request_path": "roomplan_request.json",
        "frames": manifest_frames,
    }
    (out_dir / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")

    return out_dir


def summarize(output_dir: Path, objects: Iterable[dict[str, Any]], frame_count: int) -> None:
    by_category: dict[str, int] = {}
    for obj in objects:
        by_category[obj["category"]] = by_category.get(obj["category"], 0) + 1
    summary = ", ".join(f"{category}:{count}" for category, count in sorted(by_category.items()))
    print(
        f"[arkitscenes-to-bundle] wrote {frame_count} frame(s) to {output_dir} "
        f"(objects: {summary or 'none'})"
    )


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    if not args.scene_dir.exists():
        print(f"scene-dir not found: {args.scene_dir}")
        return 1

    output_dir = write_bundle(args)

    manifest = json.loads((output_dir / "manifest.json").read_text())
    roomplan = json.loads((output_dir / "roomplan_request.json").read_text())
    summarize(output_dir, roomplan["roomplan_payload"]["objects"], len(manifest["frames"]))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
