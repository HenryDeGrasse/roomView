#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = [
#   "numpy>=1.26",
#   "pillow>=10",
# ]
# ///
"""
Bake a gradient color texture for each shell surface (floor, ceiling,
walls) by sampling the splat point cloud near the surface plane.

For every texel in each surface's local (u, v) grid:
  1. Project it to world coords via the surface frame.
  2. Find splat points within the nearby column (perpendicular distance
     < band threshold, tangential within `sample_radius` of the texel
     center).
  3. Inverse-distance-weight their colors; store to the texel.
  4. Empty texels are filled with the surface's class-default color.

Writes one PNG per surface into `fixtures/.../textures/` and emits a
manifest so the viewer can pair them to surfaces by surface_id.

Usage:
    uv run scripts/bake-wall-textures.py --fixture-id fixture-bedroom-arkitscenes
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

import numpy as np
from PIL import Image


TEXEL_SIZE_M = 0.04           # 4cm per texel — coarse but fast, PNGs stay small
PERP_BAND_M = 0.25            # accept splat points within 25cm of surface plane
SAMPLE_RADIUS_M = 0.15        # 15cm in-plane lookup radius per texel
MIN_SAMPLES_PER_TEXEL = 2     # below this → fallback to class default

# Class defaults — should match viewer.js's CAPTURE_INPAINT_COLORS so
# regions with no borrowed color blend with the mesh-only fallback.
DEFAULTS = {
    "floor":   (0xa3, 0x85, 0x60),   # medium oak
    "ceiling": (0xea, 0xe6, 0xe0),   # warm off-white
    "wall":    (0xd8, 0xd1, 0xc4),   # soft beige
}


def load_splat_positions_and_colors(fixture_dir: Path) -> tuple[np.ndarray, np.ndarray]:
    splat_files = list((fixture_dir / "splats").glob("*.splat"))
    if not splat_files:
        raise SystemExit(f"no .splat under {fixture_dir / 'splats'}")
    data = splat_files[0].read_bytes()
    n = len(data) // 32
    # Positions: floats at offset 0 (12 bytes)
    positions = np.frombuffer(data, dtype=np.float32).reshape(n, 8)[:, :3].astype(np.float64)
    # RGB: uint8 at offset 24, 25, 26
    rgba = np.frombuffer(data, dtype=np.uint8).reshape(n, 32)[:, 24:28]
    colors = rgba[:, :3].astype(np.float64) / 255.0  # (N, 3) in [0, 1]
    return positions, colors


def shell_surfaces(scene: dict) -> list[dict]:
    shell = scene["snapshot"]["state"]["room"]["shell"]
    ceiling_h = float(shell.get("ceiling_height", 2.4))
    out: list[dict] = []
    for s in shell.get("surfaces", []):
        stype = s.get("type")
        boundary = s.get("boundary")
        if not boundary:
            continue
        verts = [(float(v["x"]), float(v["y"])) for v in boundary["vertices"]]
        if len(verts) < 3:
            continue
        us = [v[0] for v in verts]
        vs = [v[1] for v in verts]
        frame = s.get("surface_frame")
        if frame:
            origin = np.array([frame["origin"]["x"], frame["origin"]["y"], frame["origin"]["z"]], dtype=np.float64)
            u_axis = np.array([frame["u_axis"]["x"], frame["u_axis"]["y"], frame["u_axis"]["z"]], dtype=np.float64)
            v_axis = np.array([frame["v_axis"]["x"], frame["v_axis"]["y"], frame["v_axis"]["z"]], dtype=np.float64)
            normal = np.array([frame["normal"]["x"], frame["normal"]["y"], frame["normal"]["z"]], dtype=np.float64)
        elif stype == "floor":
            origin = np.array([0.0, 0.0, 0.0]); u_axis = np.array([1.0, 0.0, 0.0])
            v_axis = np.array([0.0, 1.0, 0.0]); normal = np.array([0.0, 0.0, 1.0])
        elif stype == "ceiling":
            origin = np.array([0.0, 0.0, ceiling_h]); u_axis = np.array([1.0, 0.0, 0.0])
            v_axis = np.array([0.0, 1.0, 0.0]); normal = np.array([0.0, 0.0, 1.0])
        else:
            continue
        out.append({
            "surface_id": s["surface_id"],
            "type": stype,
            "origin": origin, "u_axis": u_axis, "v_axis": v_axis, "normal": normal,
            "u_min": min(us), "u_max": max(us),
            "v_min": min(vs), "v_max": max(vs),
        })
    return out


def bake_texture(
    surface: dict,
    positions: np.ndarray,
    colors: np.ndarray,
) -> np.ndarray:
    """
    Return an (H, W, 3) uint8 image with H rows × W cols of texels,
    where texel (row=v_index, col=u_index) corresponds to the wall's
    local (u, v) = (u_min + col·texel, v_min + row·texel).
    """
    u_span = surface["u_max"] - surface["u_min"]
    v_span = surface["v_max"] - surface["v_min"]
    width = max(1, int(np.ceil(u_span / TEXEL_SIZE_M)))
    height = max(1, int(np.ceil(v_span / TEXEL_SIZE_M)))
    default = DEFAULTS.get(surface["type"], (0xbb, 0xbb, 0xbb))
    img = np.tile(np.array(default, dtype=np.uint8), (height, width, 1))

    # Pre-filter splat points to the surface's slab (within band of plane
    # AND within u/v bounds). That avoids per-texel lookup over all 300k+
    # gaussians.
    disp = positions - surface["origin"]
    perp = disp @ surface["normal"]
    in_band = np.abs(perp) < PERP_BAND_M
    if not np.any(in_band):
        return img
    loc_u = disp @ surface["u_axis"]
    loc_v = disp @ surface["v_axis"]
    in_bounds = (
        in_band
        & (loc_u >= surface["u_min"] - 0.3)
        & (loc_u <= surface["u_max"] + 0.3)
        & (loc_v >= surface["v_min"] - 0.3)
        & (loc_v <= surface["v_max"] + 0.3)
    )
    if not np.any(in_bounds):
        return img
    pu = loc_u[in_bounds]
    pv = loc_v[in_bounds]
    pc = colors[in_bounds]

    # Voxel-bin the remaining points by (u_cell, v_cell) with 2×texel
    # cell size — queries at a given texel check the 5×5 surrounding
    # cells (≈10cm radius).
    bin_size = TEXEL_SIZE_M * 2.0
    u_bin = np.floor((pu - surface["u_min"]) / bin_size).astype(np.int64)
    v_bin = np.floor((pv - surface["v_min"]) / bin_size).astype(np.int64)
    bucket: dict[int, list[int]] = {}
    for i in range(pu.size):
        key = int(u_bin[i]) * 1_000_003 + int(v_bin[i])
        bucket.setdefault(key, []).append(i)

    # For each texel, query its neighbourhood and average.
    for row in range(height):
        vc = surface["v_min"] + (row + 0.5) * TEXEL_SIZE_M
        base_v = int(np.floor((vc - surface["v_min"]) / bin_size))
        for col in range(width):
            uc = surface["u_min"] + (col + 0.5) * TEXEL_SIZE_M
            base_u = int(np.floor((uc - surface["u_min"]) / bin_size))
            idx_list: list[int] = []
            for du in range(-1, 2):
                for dv in range(-1, 2):
                    key = int(base_u + du) * 1_000_003 + int(base_v + dv)
                    if key in bucket:
                        idx_list.extend(bucket[key])
            if not idx_list:
                continue
            ids = np.asarray(idx_list, dtype=np.int64)
            d2 = (pu[ids] - uc) ** 2 + (pv[ids] - vc) ** 2
            within = d2 < SAMPLE_RADIUS_M * SAMPLE_RADIUS_M
            if within.sum() < MIN_SAMPLES_PER_TEXEL:
                continue
            weights = 1.0 / (np.sqrt(d2[within]) + 0.02)
            weights /= weights.sum()
            col_sum = (pc[ids[within]] * weights[:, None]).sum(axis=0)
            img[row, col] = np.clip(np.round(col_sum * 255.0), 0, 255).astype(np.uint8)
    return img


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--fixture-id", required=True)
    parser.add_argument("--repo-root", type=Path, default=Path.cwd())
    args = parser.parse_args()
    fixture_dir = (args.repo_root / "fixtures" / "roomplan" / args.fixture_id).resolve()
    if not fixture_dir.exists():
        raise SystemExit(f"fixture dir not found: {fixture_dir}")
    scene_path = fixture_dir / "scene.json"
    scene = json.loads(scene_path.read_text())

    textures_dir = fixture_dir / "textures"
    textures_dir.mkdir(parents=True, exist_ok=True)

    positions, colors = load_splat_positions_and_colors(fixture_dir)
    print(f"[bake-wall-textures] loaded {positions.shape[0]} splat samples", file=sys.stderr)

    manifest: dict[str, Any] = {"fixture_id": args.fixture_id, "texel_m": TEXEL_SIZE_M, "textures": {}}
    for surface in shell_surfaces(scene):
        img = bake_texture(surface, positions, colors)
        # Image is (H, W, 3). Flip vertically so the PNG reads "v=0 at
        # bottom, v=max at top" — matching how the wall texture will be
        # mapped with default UV orientation.
        png = Image.fromarray(img[::-1], mode="RGB")
        rel = f"textures/{surface['surface_id']}.png"
        png.save(fixture_dir / rel)
        manifest["textures"][surface["surface_id"]] = {
            "path": rel,
            "width": img.shape[1],
            "height": img.shape[0],
            "u_min": surface["u_min"], "u_max": surface["u_max"],
            "v_min": surface["v_min"], "v_max": surface["v_max"],
            "type": surface["type"],
        }
        print(
            f"[bake-wall-textures] {surface['type']:8s} {surface['surface_id'][-8:]}: "
            f"{img.shape[1]}×{img.shape[0]} → {rel}",
            file=sys.stderr,
        )
    manifest_path = textures_dir / "manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"[bake-wall-textures] wrote manifest to {manifest_path}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
