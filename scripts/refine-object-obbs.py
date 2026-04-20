#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = [
#   "numpy>=1.26",
# ]
# ///
"""
Refine each RoomPlan-detected object's OBB using splat density.

RoomPlan fits OBBs from a coarse 3D point cloud and tends to over-size
them — the box includes a few cm of empty space around the actual object
on every face. That loose fit is why the OBB-subtraction pass in
splat-generate has to use a 2cm inset: a tight subtract would leave a
visible seam of "mesh + splat" overlap where the box is bigger than the
object.

Pipeline:
  1. For each object in scene.objects, sample the fast RGBD-init splat's
     gaussians within OBB + SEARCH_SLACK_M on every side.
  2. Rotate into OBB-local frame (undo yaw).
  3. Drop gaussians outside the (slightly expanded) OBB's bounds so we
     don't pull the extent toward a neighbouring object that bleeds in.
  4. Compute per-axis percentile extents (PCT_LOW / PCT_HIGH) as the
     refined size.
  5. Shift center to midpoint of those extents.
  6. Yaw stays fixed (RoomPlan's orientation is usually good; only the
     size + axis-aligned shift matter).

Writes:
  fixtures/roomplan/<id>/refined-obbs/manifest.json  { object_id → OBB }

Usage:
  uv run scripts/refine-object-obbs.py --fixture-id capture-bedroom110-4-20260420-005336
"""
from __future__ import annotations

import argparse
import json
import math
import sys
from datetime import datetime, timezone
from pathlib import Path

import numpy as np


# How much to grow the OBB while searching for gaussians. Too small and
# we miss the real object's surface; too large and we pick up the
# neighbour's. 15cm is a good middle for bedroom-scale furniture.
SEARCH_SLACK_M = 0.15
# Percentile extents for the refined size. Trimmed both sides so a few
# depth-sensor flyers don't push the box past the actual object.
PCT_LOW = 2.0
PCT_HIGH = 98.0
# Minimum refined size on any axis — don't collapse the box below this
# if the cluster is weirdly thin.
MIN_SIZE_M = 0.05


def _load_fast_splat(fixture_dir: Path) -> np.ndarray:
    """Load the fixture's fast RGBD-init .splat as an (N, 3) float32
    array of positions. Skips any trained PLY and prefers the .splat
    file directly — those gaussians come from depth-pixel unprojection
    so every one lies on a real surface, which is the signal we want."""
    candidates = sorted((fixture_dir / "splats").glob("splat_*.splat"))
    if not candidates:
        raise SystemExit(f"no splat_*.splat under {fixture_dir}/splats")
    splat_path = candidates[-1]
    raw = np.frombuffer(splat_path.read_bytes(), dtype=np.uint8)
    n = raw.size // 32
    raw = raw[: n * 32].reshape(n, 32)
    positions = raw[:, :12].copy().view(np.float32).reshape(n, 3)
    return positions


def _refine_one(positions: np.ndarray, obb: dict) -> dict | None:
    cx = float(obb["center"]["x"])
    cy = float(obb["center"]["y"])
    cz = float(obb["center"]["z"])
    sx = float(obb.get("size_x", 0.0))
    sy = float(obb.get("size_y", 0.0))
    sz = float(obb.get("size_z", 0.0))
    yaw = math.radians(float(obb.get("yaw_degrees", 0.0)))
    if sx <= 0 or sy <= 0 or sz <= 0:
        return None

    # Bring world-space points into OBB-local frame (center at origin,
    # axes aligned with the box's u/v/normal).
    cos_y = math.cos(-yaw)
    sin_y = math.sin(-yaw)
    dx = positions[:, 0] - cx
    dy = positions[:, 1] - cy
    dz = positions[:, 2] - cz
    local_x = cos_y * dx - sin_y * dy
    local_y = sin_y * dx + cos_y * dy
    local_z = dz

    search_hx = 0.5 * sx + SEARCH_SLACK_M
    search_hy = 0.5 * sy + SEARCH_SLACK_M
    search_hz = 0.5 * sz + SEARCH_SLACK_M
    mask = (
        (np.abs(local_x) <= search_hx)
        & (np.abs(local_y) <= search_hy)
        & (np.abs(local_z) <= search_hz)
    )
    if mask.sum() < 50:
        return None

    lx = local_x[mask]
    ly = local_y[mask]
    lz = local_z[mask]
    # Per-axis percentile extents.
    x_lo = float(np.percentile(lx, PCT_LOW))
    x_hi = float(np.percentile(lx, PCT_HIGH))
    y_lo = float(np.percentile(ly, PCT_LOW))
    y_hi = float(np.percentile(ly, PCT_HIGH))
    z_lo = float(np.percentile(lz, PCT_LOW))
    z_hi = float(np.percentile(lz, PCT_HIGH))

    new_sx = max(MIN_SIZE_M, x_hi - x_lo)
    new_sy = max(MIN_SIZE_M, y_hi - y_lo)
    new_sz = max(MIN_SIZE_M, z_hi - z_lo)

    # Shift center to the midpoint of the refined extents (still in
    # OBB-local). Rotate that offset back into world.
    off_local_x = 0.5 * (x_lo + x_hi)
    off_local_y = 0.5 * (y_lo + y_hi)
    off_local_z = 0.5 * (z_lo + z_hi)
    # Inverse of the -yaw rotation used above (so rotate by +yaw).
    cos_fwd = math.cos(yaw)
    sin_fwd = math.sin(yaw)
    new_cx = cx + cos_fwd * off_local_x - sin_fwd * off_local_y
    new_cy = cy + sin_fwd * off_local_x + cos_fwd * off_local_y
    new_cz = cz + off_local_z

    return {
        "center": {"x": new_cx, "y": new_cy, "z": new_cz},
        "size_x": new_sx,
        "size_y": new_sy,
        "size_z": new_sz,
        "yaw_degrees": float(obb.get("yaw_degrees", 0.0)),
        "sample_count": int(mask.sum()),
        "size_delta": {
            "dx": new_sx - sx,
            "dy": new_sy - sy,
            "dz": new_sz - sz,
        },
    }


def refine(fixture_dir: Path) -> dict:
    scene = json.loads((fixture_dir / "scene.json").read_text())
    objects = scene.get("snapshot", {}).get("state", {}).get("room", {}).get("objects") or []
    if not objects:
        raise SystemExit("scene has no objects to refine")

    positions = _load_fast_splat(fixture_dir)
    refined: dict[str, dict] = {}
    stats = {"total": 0, "refined": 0, "skipped": 0}
    for obj in objects:
        if not isinstance(obj, dict):
            continue
        obj_id = obj.get("object_id")
        obb = obj.get("obb")
        if not obj_id or not obb:
            continue
        stats["total"] += 1
        refinement = _refine_one(positions, obb)
        if refinement is None:
            stats["skipped"] += 1
            continue
        refined[obj_id] = {
            "class": obj.get("class"),
            "original": {
                "center": obb["center"],
                "size_x": float(obb.get("size_x", 0.0)),
                "size_y": float(obb.get("size_y", 0.0)),
                "size_z": float(obb.get("size_z", 0.0)),
                "yaw_degrees": float(obb.get("yaw_degrees", 0.0)),
            },
            "refined": {k: v for k, v in refinement.items() if k != "size_delta" and k != "sample_count"},
            "sample_count": refinement["sample_count"],
            "size_delta": refinement["size_delta"],
        }
        stats["refined"] += 1

    return {
        "fixture_id": fixture_dir.name,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "stats": stats,
        "refined_obbs": refined,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--fixture-id", required=True)
    parser.add_argument("--repo-root", type=Path, default=Path.cwd())
    args = parser.parse_args()

    fixture_dir = (args.repo_root / "fixtures" / "roomplan" / args.fixture_id).resolve()
    if not fixture_dir.exists():
        raise SystemExit(f"fixture dir not found: {fixture_dir}")

    result = refine(fixture_dir)
    out_path = fixture_dir / "refined-obbs" / "manifest.json"
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result["stats"], indent=2), file=sys.stderr)
    # Human-readable diff per object.
    for obj_id, record in result["refined_obbs"].items():
        d = record["size_delta"]
        orig_size = (record["original"]["size_x"], record["original"]["size_y"], record["original"]["size_z"])
        new_size = (record["refined"]["size_x"], record["refined"]["size_y"], record["refined"]["size_z"])
        print(
            f"{record['class']:10s} {obj_id[-8:]}: "
            f"({orig_size[0]:.2f}×{orig_size[1]:.2f}×{orig_size[2]:.2f}) "
            f"→ ({new_size[0]:.2f}×{new_size[1]:.2f}×{new_size[2]:.2f}) "
            f"[Δ {d['dx']:+.2f}, {d['dy']:+.2f}, {d['dz']:+.2f}] "
            f"{record['sample_count']} samples",
            file=sys.stderr,
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())
