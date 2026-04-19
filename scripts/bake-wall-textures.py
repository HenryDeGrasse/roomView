#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = [
#   "numpy>=1.26",
#   "pillow>=10",
# ]
# ///
"""
Bake a high-resolution color texture for each shell surface by reading
the captured RGB JPGs directly (not the downsampled splat colors). Each
texel goes through a 3-tier fallback:

  tier 1 (sharp)   direct RGB sampling from every captured frame that
                   sees this texel's world point — the projected pixel
                   passes a depth-match test against the ARKit depth
                   map (ensures the frame actually saw the wall, not
                   something in front of it). Colors are weighted by
                   view-angle quality (face-on > grazing) + camera
                   distance (closer > farther) and averaged.
  tier 2 (filled)  splat-color IDW from nearby gaussians — used when
                   no frame contributed enough weight for tier 1. The
                   splat is already multi-view-averaged by TSDF, so
                   this gives a smoother (blurrier) read that still
                   matches the captured palette.
  tier 3 (default) class default color from CAPTURE_INPAINT_COLORS —
                   used only when there's no observed data within
                   reach. After the bake, any tier-3 texel adjacent to
                   tier-1/2 texels gets a distance-decayed average so
                   the fallback blends into the observed region
                   instead of popping as a flat swatch.

At 1.5cm/texel this matches the JPG pixel resolution at typical wall
depths (2-3m), so tier 1 is effectively "project the JPG through the
wall." Any loss of detail from farther walls is soft-filtered by the
tier-3 blend-fill.

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


# Tuning
TEXEL_SIZE_M = 0.015                    # 1.5cm — matches JPG pixel scale at 2m depth
DEPTH_MATCH_TOLERANCE_M = 0.15          # ray-wall distance must be within this of actual depth
MIN_JPG_WEIGHT_FOR_TIER1 = 0.4          # below this, fall back to splat tier
SPLAT_PERP_BAND_M = 0.25                # tier-2: splat points within this of plane
SPLAT_SAMPLE_RADIUS_M = 0.06            # tier-2: tangential radius per texel
SPLAT_MIN_SAMPLES_FOR_TIER2 = 2
TIER3_BLEND_ITERATIONS = 2              # minimal boundary feather; more iters = smeary / blurry


DEFAULTS = {
    "floor":   (0xa3, 0x85, 0x60),
    "ceiling": (0xea, 0xe6, 0xe0),
    "wall":    (0xd8, 0xd1, 0xc4),
}


# ---------------------------------------------------------- Loading --

def load_splat_positions_and_colors(fixture_dir: Path) -> tuple[np.ndarray, np.ndarray]:
    splat_files = list((fixture_dir / "splats").glob("*.splat"))
    if not splat_files:
        raise SystemExit(f"no .splat under {fixture_dir / 'splats'}")
    data = splat_files[0].read_bytes()
    n = len(data) // 32
    positions = np.frombuffer(data, dtype=np.float32).reshape(n, 8)[:, :3].astype(np.float64)
    rgba = np.frombuffer(data, dtype=np.uint8).reshape(n, 32)[:, 24:28]
    colors = rgba[:, :3].astype(np.float64) / 255.0
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
        us = [v[0] for v in verts]; vs = [v[1] for v in verts]
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
            "surface_id": s["surface_id"], "type": stype,
            "origin": origin, "u_axis": u_axis, "v_axis": v_axis, "normal": normal,
            "u_min": min(us), "u_max": max(us), "v_min": min(vs), "v_max": max(vs),
        })
    return out


def column_major_to_4x4(flat16: list[float]) -> np.ndarray:
    return np.array(flat16, dtype=np.float64).reshape(4, 4, order="F")


def load_frame_asset(fixture_dir: Path, uri: str) -> Path:
    if not uri.startswith("/dev/fixtures/"):
        raise SystemExit(f"unexpected asset uri: {uri}")
    _, _, _, _, rel = uri.split("/", 4)
    return fixture_dir / rel


def load_captured_frames(fixture_dir: Path, scene: dict) -> list[dict]:
    frames = []
    for fr in scene.get("captured_frames", []):
        depth = np.load(load_frame_asset(fixture_dir, fr["depth"]["uri"]))
        rgb_img = Image.open(load_frame_asset(fixture_dir, fr["rgb"]["uri"])).convert("RGB")
        if rgb_img.size != (depth.shape[1], depth.shape[0]):
            rgb_img = rgb_img.resize((depth.shape[1], depth.shape[0]), Image.BILINEAR)
        rgb = np.asarray(rgb_img, dtype=np.float32) / 255.0
        intr = fr["intrinsics"]
        dh, dw = depth.shape
        sx = dw / intr["width"]; sy = dh / intr["height"]
        frames.append({
            "frame_id": fr["frame_id"],
            "rgb": rgb,        # (H, W, 3) float32 in [0, 1]
            "depth": depth,    # (H, W) float32 meters; NaNs allowed
            "fx": intr["fx"] * sx, "fy": intr["fy"] * sy,
            "cx": intr["cx"] * sx, "cy": intr["cy"] * sy,
            "width": dw, "height": dh,
            "wfc": column_major_to_4x4(fr["camera_transform"]),
        })
    return frames


# -------------------------------------------------------- Tier 1: JPG sampling --

def tier1_sample_wall(
    surface: dict,
    texel_world: np.ndarray,  # (H, W, 3) world points for each texel
    frames: list[dict],
) -> tuple[np.ndarray, np.ndarray]:
    """
    Project each texel world point into every captured frame, accept
    the projection if the frame's depth map shows a depth matching the
    ray's camera-Z (meaning the frame actually observed this point,
    not something in front), and accumulate weighted RGB samples.

    Returns (color, weight) arrays of shape (H, W, 3) and (H, W). A
    texel with weight < MIN_JPG_WEIGHT_FOR_TIER1 is ignored downstream.
    """
    H, W, _ = texel_world.shape
    accum_color = np.zeros((H, W, 3), dtype=np.float64)
    accum_weight = np.zeros((H, W), dtype=np.float64)

    n = surface["normal"]
    texel_flat = texel_world.reshape(-1, 3)

    for frame in frames:
        wfc = frame["wfc"]
        cam_from_world = np.linalg.inv(wfc)
        R_cw = cam_from_world[:3, :3]
        t_cw = cam_from_world[:3, 3]

        # Camera-frame coords of each texel world point (OpenCV convention).
        cam_pts = texel_flat @ R_cw.T + t_cw   # (N, 3)
        cam_z = cam_pts[:, 2]
        in_front = cam_z > 0.3

        px_u = cam_pts[:, 0] * frame["fx"] / np.where(np.abs(cam_z) > 1e-6, cam_z, 1e-6) + frame["cx"]
        px_v = cam_pts[:, 1] * frame["fy"] / np.where(np.abs(cam_z) > 1e-6, cam_z, 1e-6) + frame["cy"]
        in_bounds = (px_u >= 0) & (px_u < frame["width"] - 1) & (px_v >= 0) & (px_v < frame["height"] - 1)

        valid = in_front & in_bounds
        if not np.any(valid):
            continue

        # Check that this pixel actually observed the surface (not an
        # obstruction between the camera and the wall). depth_at_pixel
        # should match the ray's projected cam_z within tolerance.
        u_int = np.clip(px_u.astype(np.int32), 0, frame["width"] - 1)
        v_int = np.clip(px_v.astype(np.int32), 0, frame["height"] - 1)
        observed_depth = frame["depth"][v_int, u_int]
        depth_ok = np.isfinite(observed_depth) & (np.abs(observed_depth - cam_z) < DEPTH_MATCH_TOLERANCE_M)
        valid = valid & depth_ok
        if not np.any(valid):
            continue

        # Bilinear-ish sample — just take the nearest pixel for simplicity;
        # at 1.5cm texel the shift is small.
        rgb = frame["rgb"][v_int, u_int]  # (N, 3)

        # Weight: face-on view (ray nearly parallel to -normal) is best.
        cam_origin = wfc[:3, 3]
        ray_dirs = texel_flat - cam_origin          # (N, 3)
        mag = np.linalg.norm(ray_dirs, axis=-1, keepdims=True)
        mag_safe = np.where(mag > 1e-6, mag, 1.0)
        ray_dirs = ray_dirs / mag_safe
        face_on = np.clip(-(ray_dirs @ n), 0.0, 1.0)
        close = 1.0 / (np.squeeze(mag, axis=-1) + 0.5)
        w = face_on * close
        w = np.where(valid, w, 0.0)

        accum_color.reshape(-1, 3)[:] += rgb * w[:, None]
        accum_weight.reshape(-1)[:] += w

    return accum_color, accum_weight


# -------------------------------------------------------- Tier 2: splat IDW --

def tier2_sample_splats(
    surface: dict,
    texel_world: np.ndarray,   # (H, W, 3)
    splat_positions: np.ndarray,
    splat_colors: np.ndarray,
) -> tuple[np.ndarray, np.ndarray]:
    """Splat-color IDW fallback. Returns (color, has_any) arrays."""
    H, W, _ = texel_world.shape
    color_out = np.zeros((H, W, 3), dtype=np.float64)
    has_any = np.zeros((H, W), dtype=bool)

    disp = splat_positions - surface["origin"]
    perp = disp @ surface["normal"]
    in_band_mask = np.abs(perp) < SPLAT_PERP_BAND_M
    if not np.any(in_band_mask):
        return color_out, has_any
    loc_u = disp @ surface["u_axis"]
    loc_v = disp @ surface["v_axis"]
    in_bounds_mask = (
        in_band_mask
        & (loc_u >= surface["u_min"] - 0.3) & (loc_u <= surface["u_max"] + 0.3)
        & (loc_v >= surface["v_min"] - 0.3) & (loc_v <= surface["v_max"] + 0.3)
    )
    if not np.any(in_bounds_mask):
        return color_out, has_any
    pu = loc_u[in_bounds_mask]; pv = loc_v[in_bounds_mask]; pc = splat_colors[in_bounds_mask]

    bin_size = SPLAT_SAMPLE_RADIUS_M * 2.0
    u_bin = np.floor((pu - surface["u_min"]) / bin_size).astype(np.int64)
    v_bin = np.floor((pv - surface["v_min"]) / bin_size).astype(np.int64)
    bucket: dict[int, list[int]] = {}
    for i in range(pu.size):
        key = int(u_bin[i]) * 1_000_003 + int(v_bin[i])
        bucket.setdefault(key, []).append(i)

    for row in range(H):
        vc = surface["v_min"] + (row + 0.5) * TEXEL_SIZE_M
        base_v = int(np.floor((vc - surface["v_min"]) / bin_size))
        for col in range(W):
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
            within = d2 < SPLAT_SAMPLE_RADIUS_M * SPLAT_SAMPLE_RADIUS_M
            if within.sum() < SPLAT_MIN_SAMPLES_FOR_TIER2:
                continue
            weights = 1.0 / (np.sqrt(d2[within]) + 0.02)
            weights /= weights.sum()
            color_out[row, col] = (pc[ids[within]] * weights[:, None]).sum(axis=0)
            has_any[row, col] = True
    return color_out, has_any


# -------------------------------------------------------- Tier 3: blend-fill --

def blend_fill_defaults(
    color: np.ndarray,
    filled_mask: np.ndarray,
    default_rgb: np.ndarray,
    iterations: int,
) -> np.ndarray:
    """
    Where `filled_mask` is False, blend the default color into the
    nearby `filled_mask==True` region via iterated neighbour averaging.
    Preserves the observed regions exactly; smooths the boundary so
    unobserved walls fade toward default instead of popping as a flat
    swatch.
    """
    out = color.copy()
    out[~filled_mask] = default_rgb
    for _ in range(iterations):
        shifted = np.zeros_like(out)
        weights = np.zeros(out.shape[:2], dtype=np.float64)
        # 4-neighbour average
        for dv, du in [(1, 0), (-1, 0), (0, 1), (0, -1)]:
            sl_dst = (slice(max(0, dv), out.shape[0] + min(0, dv)),
                      slice(max(0, du), out.shape[1] + min(0, du)))
            sl_src = (slice(max(0, -dv), out.shape[0] + min(0, -dv)),
                      slice(max(0, -du), out.shape[1] + min(0, -du)))
            shifted[sl_dst] += out[sl_src]
            weights[sl_dst] += 1.0
        blurred = shifted / weights[..., None]
        # Only update the un-filled pixels — keep observed data pristine.
        out[~filled_mask] = blurred[~filled_mask]
    return out


# -------------------------------------------------------- Orchestration --

def bake_texture(
    surface: dict,
    frames: list[dict],
    splat_positions: np.ndarray,
    splat_colors: np.ndarray,
) -> np.ndarray:
    u_span = surface["u_max"] - surface["u_min"]
    v_span = surface["v_max"] - surface["v_min"]
    W = max(1, int(np.ceil(u_span / TEXEL_SIZE_M)))
    H = max(1, int(np.ceil(v_span / TEXEL_SIZE_M)))

    # Build the (H, W, 3) grid of world-space texel centres.
    u_grid = surface["u_min"] + (np.arange(W) + 0.5) * TEXEL_SIZE_M
    v_grid = surface["v_min"] + (np.arange(H) + 0.5) * TEXEL_SIZE_M
    uu, vv = np.meshgrid(u_grid, v_grid)
    texel_world = (
        surface["origin"][None, None, :]
        + uu[..., None] * surface["u_axis"][None, None, :]
        + vv[..., None] * surface["v_axis"][None, None, :]
    )

    # Tier 1: direct JPG sampling.
    accum_color, accum_weight = tier1_sample_wall(surface, texel_world, frames)
    filled_mask = accum_weight >= MIN_JPG_WEIGHT_FOR_TIER1
    color = np.zeros_like(accum_color)
    color[filled_mask] = (accum_color / accum_weight[..., None])[filled_mask]
    tier1_count = int(filled_mask.sum())

    # Tier 2: splat IDW for unfilled texels.
    unfilled = ~filled_mask
    if np.any(unfilled):
        splat_color, splat_has = tier2_sample_splats(surface, texel_world, splat_positions, splat_colors)
        promote = unfilled & splat_has
        color[promote] = splat_color[promote]
        filled_mask |= promote
    tier2_count = int(filled_mask.sum()) - tier1_count

    # Tier 3: class-default with blend-fill so the fallback is smooth.
    default_rgb = np.array(DEFAULTS.get(surface["type"], (0xbb, 0xbb, 0xbb)), dtype=np.float64) / 255.0
    color = blend_fill_defaults(color, filled_mask, default_rgb, TIER3_BLEND_ITERATIONS)

    print(
        f"[bake-wall-textures]   {surface['type']:8s} {surface['surface_id'][-8:]}: "
        f"{W}×{H}  tier1={tier1_count}  tier2={tier2_count}  "
        f"tier3={W * H - tier1_count - tier2_count}",
        file=sys.stderr,
    )

    img_u8 = np.clip(np.round(color * 255.0), 0, 255).astype(np.uint8)
    return img_u8


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

    print("[bake-wall-textures] loading splat + frames…", file=sys.stderr)
    positions, colors = load_splat_positions_and_colors(fixture_dir)
    frames = load_captured_frames(fixture_dir, scene)
    print(
        f"[bake-wall-textures]   splat={positions.shape[0]}  frames={len(frames)}  "
        f"texel_m={TEXEL_SIZE_M}",
        file=sys.stderr,
    )

    manifest: dict[str, Any] = {"fixture_id": args.fixture_id, "texel_m": TEXEL_SIZE_M, "textures": {}}
    for surface in shell_surfaces(scene):
        img = bake_texture(surface, frames, positions, colors)
        png = Image.fromarray(img[::-1], mode="RGB")
        rel = f"textures/{surface['surface_id']}.png"
        png.save(fixture_dir / rel)
        manifest["textures"][surface["surface_id"]] = {
            "path": rel,
            "width": img.shape[1], "height": img.shape[0],
            "u_min": surface["u_min"], "u_max": surface["u_max"],
            "v_min": surface["v_min"], "v_max": surface["v_max"],
            "type": surface["type"],
        }
    (textures_dir / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"[bake-wall-textures] done → {textures_dir}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
