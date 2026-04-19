#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy>=1.26", "pillow>=10"]
# ///
"""
Diagnose whether cohesive-mode splat gaussians land where they should:
  - mesh-seed gaussians should sit on the committed TSDF-mesh vertices
  - rgbd gaussians should sit inside the room shell AABB
  - shell-inpaint gaussians should sit on shell surfaces (distance ≈ 0)

Generates each tier in isolation (re-running splat-generate's tier builders),
reports per-OBB coverage, per-surface distance statistics, and any
cross-frame mismatches that would explain "splats don't line up with
objects".

Usage:
  uv run scripts/diagnose-splat.py --fixture fixtures/roomplan/fixture-bedroom-arkitscenes
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np

# Re-use pipeline pieces by importing from splat-generate.
sys.path.insert(0, str(Path(__file__).parent))
import importlib.util
_spec = importlib.util.spec_from_file_location("splatgen", Path(__file__).parent / "splat-generate.py")
_splatgen = importlib.util.module_from_spec(_spec)
sys.modules["splatgen"] = _splatgen   # dataclass needs this to resolve __module__
_spec.loader.exec_module(_splatgen)  # type: ignore


def load_scene(fixture_dir: Path) -> dict:
    return json.loads((fixture_dir / "scene.json").read_text())


def report_mesh_tier(fixture_dir: Path) -> None:
    meshes = _splatgen.load_tsdf_meshes(fixture_dir)
    print(f"\n[mesh tier]  {len(meshes)} TSDF meshes loaded")
    pos_all, _col, _scales, _norms = _splatgen.build_mesh_seed_gaussians(meshes)
    print(f"  sampled gaussians: {pos_all.shape[0]}")
    if pos_all.shape[0] == 0:
        return
    print(f"  pos X range: {pos_all[:,0].min():.3f} .. {pos_all[:,0].max():.3f}")
    print(f"  pos Y range: {pos_all[:,1].min():.3f} .. {pos_all[:,1].max():.3f}")
    print(f"  pos Z range: {pos_all[:,2].min():.3f} .. {pos_all[:,2].max():.3f}")
    # For each mesh, verify sampled pts are close to any mesh vertex (should be 0 — barycentric).
    print("  per-mesh nearest-vertex distance (should be ≈ 0 since points are ON triangles):")
    for m in meshes:
        p, _c, _n = _splatgen.barycentric_sample_mesh(m, samples_per_m2=200)
        if p.shape[0] == 0:
            print(f"    {m.object_id[-8:]}: no samples"); continue
        # Nearest-vertex distance
        verts = m.vertices
        d2 = ((p[:, None, :] - verts[None, :, :]) ** 2).sum(axis=-1)
        d_min = np.sqrt(d2.min(axis=-1))
        print(f"    {m.object_id[-8:]}: N={p.shape[0]}  d_min median={np.median(d_min)*1000:.2f}mm  max={d_min.max()*1000:.2f}mm")


def report_shell_tier(fixture_dir: Path, scene: dict) -> None:
    # Use rgbd positions for color borrowing (just a coarse seed for the test).
    frames = _splatgen.load_frames_from_fixture(fixture_dir)
    clip = _splatgen._load_room_clip_bounds(scene)
    rgbd_pos, rgbd_col, _s, _q = _splatgen.build_rgbd_init_gaussians(frames, 200_000, clip)
    pos, col, scl, nrm, alp = _splatgen.build_shell_inpaint_gaussians(scene, rgbd_pos, rgbd_col)
    surfaces = _splatgen.extract_shell_surfaces(scene)
    print(f"\n[shell tier]  {len(surfaces)} surfaces, {pos.shape[0]} lattice gaussians")
    for s in surfaces:
        # Signed distance from each lattice point to surface plane (should be ≈ 0 for lattice on that surface).
        # Classify points as belonging to this surface if their position is within the u/v bounds and
        # normal distance < 1cm.
        to_origin = pos - s.origin
        plane_d = np.abs(to_origin @ s.normal)
        # And their u/v coordinates should be within bounds
        u_coord = to_origin @ s.u_axis
        v_coord = to_origin @ s.v_axis
        own = (plane_d < 0.001) & (u_coord >= s.u_min - 0.01) & (u_coord <= s.u_max + 0.01) \
            & (v_coord >= s.v_min - 0.01) & (v_coord <= s.v_max + 0.01)
        n = int(own.sum())
        print(f"  {s.category:8s} origin=({s.origin[0]:.2f},{s.origin[1]:.2f},{s.origin[2]:.2f}) "
              f"n=(u[{s.u_min:.2f},{s.u_max:.2f}] v[{s.v_min:.2f},{s.v_max:.2f}])  "
              f"lattice_points≈{n}")
    # Color-borrow stats
    default_colors = np.array([
        _splatgen.SHELL_DEFAULT_COLORS.get(s.category, (0.7, 0.7, 0.7)) for s in surfaces
    ])
    # Rough detection of how many shell splats kept the default color vs borrowed
    matched_default = np.zeros(pos.shape[0], dtype=bool)
    for s_idx, s in enumerate(surfaces):
        to_origin = pos - s.origin
        plane_d = np.abs(to_origin @ s.normal)
        own = plane_d < 0.001
        default = default_colors[s_idx]
        matched_default |= own & (np.abs(col - default[None, :]).sum(axis=-1) < 0.005)
    print(f"  color default-vs-borrowed: default={int(matched_default.sum())}/{pos.shape[0]} "
          f"({matched_default.mean()*100:.1f}%)")


def report_rgbd_tier(fixture_dir: Path, scene: dict) -> None:
    frames = _splatgen.load_frames_from_fixture(fixture_dir)
    clip = _splatgen._load_room_clip_bounds(scene)
    pos, col, scl, q = _splatgen.build_rgbd_init_gaussians(frames, 400_000, clip)
    print(f"\n[rgbd tier]  {pos.shape[0]} gaussians")
    print(f"  X: {pos[:,0].min():.2f} .. {pos[:,0].max():.2f}  median={np.median(pos[:,0]):.2f}")
    print(f"  Y: {pos[:,1].min():.2f} .. {pos[:,1].max():.2f}  median={np.median(pos[:,1]):.2f}")
    print(f"  Z: {pos[:,2].min():.2f} .. {pos[:,2].max():.2f}  median={np.median(pos[:,2]):.2f}")
    # Per-OBB coverage
    objs = scene["snapshot"]["state"]["room"]["objects"]
    print("  per-OBB gaussian coverage (inside, near±15cm):")
    for obj in objs:
        obb = obj["obb"]
        cx, cy, cz = obb["center"]["x"], obb["center"]["y"], obb["center"]["z"]
        sx, sy, sz = obb["size_x"], obb["size_y"], obb["size_z"]
        yaw = np.radians(obb.get("yaw_degrees", 0))
        c, sn = np.cos(yaw), np.sin(yaw)
        dx, dy, dz = pos[:, 0] - cx, pos[:, 1] - cy, pos[:, 2] - cz
        lx = c * dx + sn * dy
        ly = -sn * dx + c * dy
        lz = dz
        inside = (np.abs(lx) < sx / 2) & (np.abs(ly) < sy / 2) & (np.abs(lz) < sz / 2)
        near15 = (np.abs(lx) < sx / 2 + 0.15) & (np.abs(ly) < sy / 2 + 0.15) & (np.abs(lz) < sz / 2 + 0.15)
        print(f"    {obj['class']:15s} {obj['object_id'][-8:]}  inside={int(inside.sum()):6d}  near15={int(near15.sum()):6d}")
    # How far from the nearest OBB is each rgbd splat?
    # Batch all OBBs, for each point find min distance to any OBB volume (approximate).
    print("  per-splat nearest-OBB centroid distance:")
    centers = np.array([[o["obb"]["center"][k] for k in ("x", "y", "z")] for o in objs])
    d = np.linalg.norm(pos[:, None, :] - centers[None, :, :], axis=-1)
    d_min = d.min(axis=-1)
    # Bucket distances
    buckets = [0.1, 0.3, 0.5, 1.0, 2.0, 4.0]
    prev = 0.0
    for b in buckets:
        c = int(((d_min >= prev) & (d_min < b)).sum())
        print(f"    {prev:.1f}..{b:.1f}m  {c:8d}  ({c/pos.shape[0]*100:4.1f}%)")
        prev = b
    print(f"    >{prev:.1f}m    {int((d_min >= prev).sum()):8d}")


def report_shell_distance_from_observed(fixture_dir: Path, scene: dict) -> None:
    """How close do rgbd splats actually come to the six shell surfaces?"""
    frames = _splatgen.load_frames_from_fixture(fixture_dir)
    clip = _splatgen._load_room_clip_bounds(scene)
    pos, _col, _scl, _q = _splatgen.build_rgbd_init_gaussians(frames, 200_000, clip)
    surfaces = _splatgen.extract_shell_surfaces(scene)
    print("\n[rgbd vs shell surfaces]  distance from each surface plane:")
    for s in surfaces:
        d = (pos - s.origin) @ s.normal  # signed: + is inward side (normal points inward)
        abs_d = np.abs(d)
        very_close = int((abs_d < 0.05).sum())
        moderate = int((abs_d < 0.15).sum())
        print(f"  {s.category:8s} n=({s.normal[0]:.1f},{s.normal[1]:.1f},{s.normal[2]:.1f})  "
              f"<5cm={very_close}  <15cm={moderate}  mean_inward={d.mean():+.2f}m")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--fixture", type=Path, required=True)
    args = parser.parse_args()
    fixture_dir = args.fixture.expanduser().resolve()
    scene = load_scene(fixture_dir)
    print(f"[diagnose] fixture={fixture_dir.name}  captured_frames={len(scene.get('captured_frames', []))}")
    # Room AABB
    shell = scene["snapshot"]["state"]["room"]["shell"]
    xs = [v["x"] for v in shell["floor_polygon"]["vertices"]]
    ys = [v["y"] for v in shell["floor_polygon"]["vertices"]]
    print(f"[diagnose] room AABB: X[{min(xs):.2f},{max(xs):.2f}]  "
          f"Y[{min(ys):.2f},{max(ys):.2f}]  Z[0,{shell['ceiling_height']:.2f}]")

    report_mesh_tier(fixture_dir)
    report_rgbd_tier(fixture_dir, scene)
    report_shell_tier(fixture_dir, scene)
    report_shell_distance_from_observed(fixture_dir, scene)
    return 0


if __name__ == "__main__":
    sys.exit(main())
