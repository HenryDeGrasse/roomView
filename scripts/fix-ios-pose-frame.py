#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = [
#   "numpy>=1.26",
# ]
# ///
"""
Post-hoc pose-frame fixer for iOS captures that shipped without the
coordinate-frame conversions newer iOS builds apply at capture time.

Symptom: scene.shell is in canonical-post-offset coordinates (floor
at z=0, positive octant), but every frame's `camera_transform` is the
raw ARKit `world_from_camera` (ARKit world frame: +Y up, no offset).
Result: splat-generate unprojects pixels and places gaussians in ARKit
world coords, offset 2-5m from where the shell lives, so splats
"cluster in a few spots" outside the room's visible bounds.

This script patches each frame's camera_transform so it aligns with
the shell:
  1. Apply `M_canonical_from_arkit = [[1,0,0,0],[0,0,-1,0],[0,1,0,0],[0,0,0,1]]`
     on the LEFT (world-frame rotation).
  2. Subtract an offset chosen so the camera path's XY midpoint lands
     at the shell's XY midpoint, and Z midpoint ≈ 1.4m above the shell
     floor (typical eye level).
  3. Re-write scene.json in place. Idempotent: re-running is safe.

After patching, re-run the pipeline against the fixture:
    uv run scripts/splat-generate.py --fixture fixtures/roomplan/<id> \\
        --capture-id <id> --mode cohesive --out-dir fixtures/roomplan/<id>/splats
    uv run scripts/bake-wall-textures.py --fixture-id <id>

Usage:
    uv run scripts/fix-ios-pose-frame.py --fixture-id capture-bedroom110-3-20260420-003637
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np


# M: canonical_world_from_arkit_world
# canonicalize(p) = (p.x, -p.z, p.y) as per iOS CapturedRoomMapping.canonicalize.
M_CANONICAL_FROM_ARKIT = np.array(
    [
        [1, 0, 0, 0],
        [0, 0, -1, 0],
        [0, 1, 0, 0],
        [0, 0, 0, 1],
    ],
    dtype=np.float64,
)


def fix_scene(fixture_dir: Path, eye_level_m: float = 1.4) -> dict:
    scene_path = fixture_dir / "scene.json"
    scene = json.loads(scene_path.read_text())
    shell = scene["snapshot"]["state"]["room"]["shell"]
    frames = scene["captured_frames"]

    # Shell XY center.
    fp = shell["floor_polygon"]["vertices"]
    shell_min_x = min(v["x"] for v in fp)
    shell_max_x = max(v["x"] for v in fp)
    shell_min_y = min(v["y"] for v in fp)
    shell_max_y = max(v["y"] for v in fp)
    shell_cx = 0.5 * (shell_min_x + shell_max_x)
    shell_cy = 0.5 * (shell_min_y + shell_max_y)

    # Canonicalize every pose, collect positions.
    canonical_positions = []
    canonical_transforms = []
    for frame in frames:
        t_raw = frame["camera_transform"]
        T = np.array(t_raw, dtype=np.float64).reshape(4, 4, order="F")
        T_can = M_CANONICAL_FROM_ARKIT @ T
        canonical_transforms.append(T_can)
        canonical_positions.append(T_can[:3, 3])
    canonical_positions = np.array(canonical_positions)

    # Derive offset so that camera path's XY midpoint sits at shell XY mid,
    # and Z midpoint is ~eye_level above the shell floor (z=0).
    cam_cx = canonical_positions[:, 0].mean()
    cam_cy = canonical_positions[:, 1].mean()
    cam_cz = canonical_positions[:, 2].mean()
    offset_x = cam_cx - shell_cx
    offset_y = cam_cy - shell_cy
    offset_z = cam_cz - eye_level_m
    offset = np.array([offset_x, offset_y, offset_z])

    # Apply offset to each canonical transform's translation column, then
    # write back in column-major order.
    for frame, T_can in zip(frames, canonical_transforms):
        T_can[:3, 3] = T_can[:3, 3] - offset
        # also patch camera_pose.position to match the new world-frame position
        pos = T_can[:3, 3]
        frame["camera_pose"]["position"] = {
            "x": float(pos[0]),
            "y": float(pos[1]),
            "z": float(pos[2]),
        }
        # serialize column-major (same as iOS CaptureBundleWriter.poseRecord)
        flat = []
        for c in range(4):
            col = T_can[:, c]
            flat.extend([float(col[0]), float(col[1]), float(col[2]), float(col[3])])
        frame["camera_transform"] = flat

    scene_path.write_text(json.dumps(scene, indent=2) + "\n")

    return {
        "offset": [float(offset_x), float(offset_y), float(offset_z)],
        "camera_canonical_range": {
            "x": [float(canonical_positions[:, 0].min()), float(canonical_positions[:, 0].max())],
            "y": [float(canonical_positions[:, 1].min()), float(canonical_positions[:, 1].max())],
            "z": [float(canonical_positions[:, 2].min()), float(canonical_positions[:, 2].max())],
        },
        "shell_xy_bbox": {
            "x": [shell_min_x, shell_max_x],
            "y": [shell_min_y, shell_max_y],
        },
        "frame_count": len(frames),
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--fixture-id", required=True, help="Fixture directory name under fixtures/roomplan/")
    parser.add_argument("--repo-root", type=Path, default=Path.cwd())
    parser.add_argument("--eye-level-m", type=float, default=1.4,
                        help="Assumed eye-level above floor for computing the Z offset.")
    args = parser.parse_args()
    fixture_dir = (args.repo_root / "fixtures" / "roomplan" / args.fixture_id).resolve()
    if not fixture_dir.exists():
        raise SystemExit(f"fixture dir not found: {fixture_dir}")
    stats = fix_scene(fixture_dir, args.eye_level_m)
    print(json.dumps(stats, indent=2))
    print(f"\nPatched {stats['frame_count']} frames in {fixture_dir}/scene.json")
    print("Next: re-run the splat + bake pipeline:")
    print(f"  uv run scripts/splat-generate.py --fixture {fixture_dir} "
          f"--capture-id {args.fixture_id} --mode cohesive --out-dir {fixture_dir}/splats")
    print(f"  uv run scripts/bake-wall-textures.py --fixture-id {args.fixture_id}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
