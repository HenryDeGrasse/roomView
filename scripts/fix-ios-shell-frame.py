#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""
Post-hoc shell-frame fixer for iOS captures that shipped with the pre-fix
`roomOffset()` logic (before commit b03cf13 landed on 2026-04-19). In that
build, `polygonCorners` from the detected floor could poison the Z offset,
leaving wall `surface_frame.origin.z > 0` instead of sitting on the floor.

Symptom: in the viewer the walls float one-room-height above the splats /
camera path (typical gap: 2–4m). Splats and camera Zs are correct; only the
shell's Z origin is off.

This script subtracts `min(wall.surface_frame.origin.z)` from:
  - every wall's surface_frame.origin.z
  - every object's obb.center.z
so the shell lines up with splats (which live in the frame where the floor
is at Z=0). Openings live in wall-local UV coords and are unaffected.
Floor polygon is 2D; ceiling_height is relative; both are unaffected.

Idempotent: re-running on an already-aligned shell is a no-op.

Usage:
    uv run scripts/fix-ios-shell-frame.py --fixture-id capture-bedroom110-3-20260420-003637
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


def fix_shell(fixture_dir: Path, threshold: float = 0.25) -> dict:
    scene_path = fixture_dir / "scene.json"
    scene = json.loads(scene_path.read_text())
    shell = scene["snapshot"]["state"]["room"]["shell"]
    walls = [s for s in shell.get("surfaces", []) if s.get("type") == "wall"]
    if not walls:
        raise SystemExit("no walls found in shell")

    wall_z_values = [w["surface_frame"]["origin"]["z"] for w in walls]
    offset_z = min(wall_z_values)
    if offset_z < threshold:
        return {
            "status": "skipped",
            "reason": f"min wall origin.z = {offset_z:.4f} is already ~0",
            "wall_count": len(walls),
        }

    for w in walls:
        w["surface_frame"]["origin"]["z"] -= offset_z

    objects = scene["snapshot"]["state"]["room"].get("objects", [])
    for o in objects:
        obb = o.get("obb") or {}
        ctr = obb.get("center") or {}
        if "z" in ctr:
            ctr["z"] -= offset_z

    scene_path.write_text(json.dumps(scene, indent=2) + "\n")

    return {
        "status": "patched",
        "offset_z": offset_z,
        "wall_count": len(walls),
        "object_count": len(objects),
        "wall_z_before": [min(wall_z_values), max(wall_z_values)],
        "wall_z_after": [0.0, max(wall_z_values) - offset_z],
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--fixture-id", required=True)
    parser.add_argument("--repo-root", type=Path, default=Path.cwd())
    parser.add_argument("--threshold", type=float, default=0.25,
                        help="Skip fix when min wall Z is below this (already aligned).")
    args = parser.parse_args()
    fixture_dir = (args.repo_root / "fixtures" / "roomplan" / args.fixture_id).resolve()
    if not fixture_dir.exists():
        raise SystemExit(f"fixture dir not found: {fixture_dir}")
    result = fix_shell(fixture_dir, args.threshold)
    print(json.dumps(result, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
