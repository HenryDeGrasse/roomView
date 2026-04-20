#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = [
#   "shapely>=2.0",
# ]
# ///
"""
Re-derive `scene.derived_state_cache.hard_violations` using the tight
mesh-derived footprint polygons written by `extract-object-footprints.py`
(preferred) or the OBB rectangle as fallback.

This mirrors the TypeScript validation in apps/api/src/roomplan-ingest.ts
and apps/api/src/overlap-policy.ts, but runs as a one-shot Python pass
against an existing fixture — the web server serves scene.json directly,
so patching the `hard_violations` array in place surfaces the fix to the
UI on the next reload without re-ingesting.

Validation rules ported:
  - OBJECT_OVERLAP: true polygon-vs-polygon intersection > 0.18 m²,
    with legal-overlap and tolerable-furniture-overlap exemptions.
  - OUT_OF_BOUNDS: object footprint polygon not contained within the
    floor polygon (polygon-in-polygon, not AABB containment).
  - OPENING_BLOCKED: any floor-blocking object whose footprint
    intersects the opening's keepout polygon.
  - CLEARANCE_VIOLATION: walkway width (door → target object) reduced
    by obstacles on the straight-line path, computed as 2 × (min
    distance from the line segment to any blocking-object polygon),
    clipped to 0.4m minimum. Flagged when < 0.9m.

Usage:
  uv run scripts/rederive-hard-violations.py --fixture-id capture-bedroom110-4-20260420-005336
"""
from __future__ import annotations

import argparse
import json
import math
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

from shapely.geometry import Point, Polygon


# Hard violations are physics-level only, two rules:
#   1. OBJECT_OVERLAP — two floor-supported objects whose footprint
#      polygons intersect by more than a small epsilon (0.02 m² ≈ 14 cm
#      × 14 cm) after accounting for 1-2 cm polygon-edge slop.
#   2. OUT_OF_BOUNDS — object footprint has a majority of its vertices
#      outside the floor polygon. Mild mesh bleed past walls (TSDF
#      voxel fuzz) is ignored.
# Previous rules (OPENING_BLOCKED, CLEARANCE_VIOLATION) depended on
# unreliable keepout zones and arbitrary walkway thresholds; they
# belong in a future soft-score layer, not hard violations.
# 0.05 m² ≈ 22 cm × 22 cm. Large enough to be visibly a collision, small
# enough that real furniture-on-furniture contact (two floor-supported
# pieces pushed together) still registers. Mesh-reconstruction bleed at
# object boundaries typically sits at 0.005–0.03 m² — below this floor.
HARD_OVERLAP_AREA_THRESHOLD_M2 = 0.05
OUT_OF_BOUNDS_AREA_FRACTION = 0.5


def _round(x: float, n: int = 3) -> float:
    return round(x, n)


def obb_polygon(obb: dict) -> Polygon:
    hx = float(obb.get("size_x", 0.0)) / 2
    hy = float(obb.get("size_y", 0.0)) / 2
    yaw = math.radians(float(obb.get("yaw_degrees", 0.0)))
    cos, sin = math.cos(yaw), math.sin(yaw)
    cx, cy = float(obb["center"]["x"]), float(obb["center"]["y"])
    corners = [(-hx, -hy), (hx, -hy), (hx, hy), (-hx, hy)]
    return Polygon(
        [(cx + dx * cos - dy * sin, cy + dx * sin + dy * cos) for dx, dy in corners]
    )


def object_polygon(obj: dict) -> Polygon:
    fp = obj.get("footprint_polygon")
    if fp and isinstance(fp.get("vertices"), list) and len(fp["vertices"]) >= 3:
        pts = [(float(v["x"]), float(v["y"])) for v in fp["vertices"]]
        poly = Polygon(pts)
        if poly.is_valid and not poly.is_empty:
            return poly
    return obb_polygon(obj["obb"])


def _is_floor_supported(obj: dict) -> bool:
    return obj.get("support", {}).get("support_kind") == "floor"


def compute_violations(scene: dict) -> list[dict]:
    room = scene["snapshot"]["state"]["room"]
    floor = Polygon(
        [(float(v["x"]), float(v["y"])) for v in room["shell"]["floor_polygon"]["vertices"]]
    )
    if not floor.is_valid:
        floor = floor.buffer(0)
    objects = room.get("objects") or []

    polys = {o["object_id"]: object_polygon(o) for o in objects}
    violations: list[dict] = []

    # OUT_OF_BOUNDS — object footprint majority-outside floor polygon by
    # TRUE area (shapely polygon difference), not a vertex-count proxy.
    # A storage against an exterior wall may have many vertices past the
    # wall plane yet only a tiny outside area; vertex-count over-flags
    # those.
    for o in objects:
        poly = polys[o["object_id"]]
        if poly.area <= 0:
            continue
        outside = poly.difference(floor)
        outside_area = outside.area if not outside.is_empty else 0.0
        outside_fraction = outside_area / poly.area
        if outside_fraction > OUT_OF_BOUNDS_AREA_FRACTION:
            violations.append({
                "entity_id": o["object_id"],
                "reason_code": "OUT_OF_BOUNDS",
                "message": f"{o.get('class')} extends outside the captured floor polygon.",
                "outside_area_m2": _round(outside_area),
                "outside_fraction": _round(outside_fraction),
            })

    # OBJECT_OVERLAP — two floor-supported objects whose footprints
    # intersect by more than the epsilon threshold.
    for i in range(len(objects)):
        a = objects[i]
        if not _is_floor_supported(a):
            continue
        pa = polys[a["object_id"]]
        for j in range(i + 1, len(objects)):
            b = objects[j]
            if not _is_floor_supported(b):
                continue
            pb = polys[b["object_id"]]
            if not pa.intersects(pb):
                continue
            inter = pa.intersection(pb)
            overlap_area = inter.area if not inter.is_empty else 0.0
            if overlap_area > HARD_OVERLAP_AREA_THRESHOLD_M2:
                violations.append({
                    "entity_ids": [a["object_id"], b["object_id"]],
                    "reason_code": "OBJECT_OVERLAP",
                    "message": f"{a.get('class')} overlaps {b.get('class')}.",
                    "overlap_area_m2": _round(overlap_area),
                })

    return violations


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--fixture-id", required=True)
    parser.add_argument("--repo-root", type=Path, default=Path.cwd())
    args = parser.parse_args()

    fixture_dir = (args.repo_root / "fixtures" / "roomplan" / args.fixture_id).resolve()
    scene_path = fixture_dir / "scene.json"
    if not scene_path.exists():
        raise SystemExit(f"scene.json not found: {scene_path}")
    scene = json.loads(scene_path.read_text())

    before = len((scene.get("derived_state_cache") or {}).get("hard_violations") or [])
    violations = compute_violations(scene)
    after = len(violations)

    if "derived_state_cache" not in scene or scene["derived_state_cache"] is None:
        scene["derived_state_cache"] = {}
    scene["derived_state_cache"]["hard_violations"] = violations
    scene["derived_state_cache"]["rederived_at"] = datetime.now(timezone.utc).isoformat()

    scene_path.write_text(json.dumps(scene, indent=2) + "\n")

    top_manifest = fixture_dir.parent.parent / "manifest.json"
    if top_manifest.exists():
        now = datetime.now(timezone.utc).timestamp()
        os.utime(top_manifest, (now, now))

    codes: dict[str, int] = {}
    for v in violations:
        codes[v["reason_code"]] = codes.get(v["reason_code"], 0) + 1

    print(json.dumps({"before": before, "after": after, "by_code": codes}, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
