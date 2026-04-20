#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = [
#   "numpy>=1.26",
#   "scipy>=1.11",
#   "shapely>=2.0",
#   "open3d>=0.18",
# ]
# ///
"""
Compute per-object 2D footprint polygons from TSDF meshes.

RoomPlan's OBBs are loose (a few cm of padding per face) and the
validation engine collapses them to axis-aligned bounding boxes before
checking overlaps, which makes near-neighbors collide with large fake
areas. We now have one TSDF mesh per object — the actual reconstructed
surface at 1.5cm fidelity — so the honest footprint is the XY convex
hull of those mesh vertices.

This script reads each mesh in fixtures/roomplan/<id>/meshes/, projects
vertices to the floor plane (drop Z), fits a convex hull, simplifies it
to collapse near-collinear edges, and writes the result onto the scene
object as `footprint_polygon`. Downstream validation in
apps/api/src/overlap-policy.ts prefers this polygon over the OBB
rectangle when present.

Usage:
  uv run scripts/extract-object-footprints.py \\
      --fixture-id capture-bedroom110-4-20260420-005336
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import open3d as o3d
from scipy.spatial import ConvexHull
from shapely.geometry import Polygon


FOOTPRINT_SIMPLIFY_M = 0.01  # shapely tolerance — collapse near-collinear edges
MIN_VERTICES = 3


def _hull_vertices(xy: np.ndarray) -> list[dict[str, float]] | None:
    """Compute the convex hull of the XY projection, simplify, and
    return an ordered list of {x, y} vertices (no closing vertex)."""
    if len(xy) < MIN_VERTICES:
        return None
    try:
        hull = ConvexHull(xy)
    except Exception:
        return None
    hull_points = xy[hull.vertices]
    poly = Polygon(hull_points.tolist())
    if not poly.is_valid:
        poly = poly.buffer(0)
    if not poly.is_valid or poly.is_empty:
        return None
    simplified = poly.simplify(FOOTPRINT_SIMPLIFY_M, preserve_topology=True)
    if not simplified.is_valid or simplified.is_empty:
        simplified = poly
    coords = list(simplified.exterior.coords)
    if len(coords) > 1 and coords[0] == coords[-1]:
        coords = coords[:-1]
    if len(coords) < MIN_VERTICES:
        return None
    return [{"x": float(x), "y": float(y)} for x, y in coords]


def extract_footprint(mesh_path: Path) -> tuple[list[dict[str, float]] | None, int]:
    try:
        mesh = o3d.io.read_triangle_mesh(str(mesh_path))
    except Exception as exc:
        print(f"[footprint] failed to read {mesh_path}: {exc}", file=sys.stderr)
        return None, 0
    verts = np.asarray(mesh.vertices, dtype=np.float64)
    if len(verts) < MIN_VERTICES:
        return None, 0
    return _hull_vertices(verts[:, :2]), len(verts)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--fixture-id", required=True)
    parser.add_argument("--repo-root", type=Path, default=Path.cwd())
    args = parser.parse_args()

    fixture_dir = (args.repo_root / "fixtures" / "roomplan" / args.fixture_id).resolve()
    if not fixture_dir.exists():
        raise SystemExit(f"fixture dir not found: {fixture_dir}")

    scene_path = fixture_dir / "scene.json"
    if not scene_path.exists():
        raise SystemExit(f"scene.json not found: {scene_path}")
    scene = json.loads(scene_path.read_text())

    manifest_path = fixture_dir / "meshes" / "manifest.json"
    if not manifest_path.exists():
        raise SystemExit(
            "meshes/manifest.json not found — run bundle-to-meshes first"
        )
    manifest = json.loads(manifest_path.read_text())
    mesh_paths = manifest.get("meshes") or {}

    objects = scene.get("snapshot", {}).get("state", {}).get("room", {}).get("objects") or []
    if not objects:
        raise SystemExit("scene has no objects")

    stats = {"total": len(objects), "extracted": 0, "no_mesh": 0, "hull_failed": 0}
    per_object: list[dict] = []
    generated_at = datetime.now(timezone.utc).isoformat()

    for obj in objects:
        if not isinstance(obj, dict):
            continue
        oid = obj.get("object_id")
        rel = mesh_paths.get(oid)
        if not rel:
            stats["no_mesh"] += 1
            continue
        mp = fixture_dir / rel
        if not mp.exists():
            stats["no_mesh"] += 1
            continue
        verts2d, raw_vertex_count = extract_footprint(mp)
        if verts2d is None:
            stats["hull_failed"] += 1
            continue
        obj["footprint_polygon"] = {
            "vertices": verts2d,
            "source": "tsdf_mesh_convex_hull",
            "mesh_vertex_count": raw_vertex_count,
            "generated_at": generated_at,
        }
        stats["extracted"] += 1
        per_object.append(
            {
                "object_id": oid,
                "class": obj.get("class"),
                "vertex_count": len(verts2d),
            }
        )

    scene_path.write_text(json.dumps(scene, indent=2) + "\n")

    top_manifest = fixture_dir.parent.parent / "manifest.json"
    if top_manifest.exists():
        now = datetime.now(timezone.utc).timestamp()
        os.utime(top_manifest, (now, now))

    print(json.dumps({"stats": stats, "objects": per_object}, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
