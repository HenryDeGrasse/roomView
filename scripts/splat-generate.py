#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = [
#   "numpy>=1.26",
#   "pillow>=10",
# ]
# ///
"""
Splat generation orchestrator for the Showcase-phase scan pane (Track B).

Given a capture bundle (RGB + depth + pose per keyframe), produces a
Gaussian Splatting asset ready to load in the web viewer at LAYER_SPLAT.

Modes:

  --mode fixture      Deterministic stub splat metadata derived from
                      SHA-256 of the bundle. No .splat is written — the
                      descriptor points at a placeholder URI the viewer
                      substitutes with the RoomPlan shell preview. CI
                      uses this to validate the control flow without a
                      GPU.

  --mode rgbd_init    Seed Gaussians directly from the captured RGBD
                      frames. Each valid depth pixel becomes one
                      Gaussian with world-space position (unprojected
                      via intrinsics + camera pose), color (from RGB),
                      scale (from local pixel footprint at depth),
                      identity rotation, and full opacity. No training
                      — this is the init stage of any real 3DGS
                      pipeline, already photoreal because the Gaussians
                      carry captured RGB. Runs on CPU in ~10s for a
                      bedroom-scale bundle. Emits both:
                        - the binary `.splat` (32 bytes/gaussian,
                          antimatter15-splat / gsplat.js compatible)
                        - the JSON descriptor pointing at it.

  --mode splatfacto   Real optimized pipeline: Nerfstudio / Splatfacto
                      on the captured frames with depth supervision.
                      NOT wired without a GPU; exits with a pointer to
                      the Showcase plan. Hooks are in place so the same
                      descriptor shape slots into the `splat.status =
                      "ready"` path when wired.

Binary .splat format (antimatter15 / gsplat.js — 32 bytes/gaussian):
    float32 x, y, z               // position (12 bytes)
    float32 sx, sy, sz            // scale    (12 bytes)
    uint8   r, g, b, alpha        // color   (4 bytes)
    uint8   rot_x,y,z,w           // quantized quaternion, each
                                  //   byte = round(((q + 1)/2) * 255)

Descriptor JSON shape (fields match SplatAssetRecord contract):

    {
      "splat_id": "splat:...",
      "capture_id": "...",
      "generator_kind": "rgbd_init" | "deterministic_stub" | "splatfacto",
      "ply_uri": "/dev/fixtures/{fixture_id}/splats/{splat_id}.splat"
                  (or "asset://splats/..." for non-fixture runs),
      "ply_bytes_sha256": "<hex>"  // null in fixture mode
      "gaussian_count": <int>,
      "generated_at": "<ISO8601 Z>"
    }
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import numpy as np
from PIL import Image


@dataclass(frozen=True)
class SplatRequest:
    bundle_dir: Path | None          # raw bundle dir (manifest.json style)
    fixture_dir: Path | None         # or a fixture dir (scene.json style)
    capture_id: str
    mode: str
    out_dir: Path
    max_gaussians: int
    ply_uri_template: str | None     # optional override for the URI embedded in the descriptor


def parse_args(argv: list[str]) -> SplatRequest:
    parser = argparse.ArgumentParser(
        description="Generate a Gaussian Splatting asset from a capture bundle.",
    )
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--bundle", type=Path, help="Path to a capture bundle directory (manifest.json + frames/).")
    source.add_argument("--fixture", type=Path, help="Path to a fixture dir (scene.json + frames/); used by the committed scan fixtures.")
    parser.add_argument(
        "--capture-id",
        required=True,
        help="Stable id (bundle's capture_id) — used for deterministic splat_id.",
    )
    parser.add_argument(
        "--mode",
        choices=["fixture", "rgbd_init", "splatfacto"],
        default="fixture",
        help="fixture: deterministic stub (CI-safe); rgbd_init: seed gaussians from RGBD frames (CPU, no training); splatfacto: real optimized backend (GPU required, not wired).",
    )
    parser.add_argument("--out-dir", type=Path, required=True)
    parser.add_argument(
        "--max-gaussians",
        type=int,
        default=400_000,
        help="Cap on gaussian count in rgbd_init mode (subsampled from per-pixel unprojection). Default 400k.",
    )
    parser.add_argument(
        "--ply-uri",
        type=str,
        default=None,
        help="Optional URI embedded in the descriptor's ply_uri field (overrides the default asset:// scheme).",
    )
    args = parser.parse_args(argv)
    return SplatRequest(
        bundle_dir=args.bundle.expanduser().resolve() if args.bundle else None,
        fixture_dir=args.fixture.expanduser().resolve() if args.fixture else None,
        capture_id=args.capture_id,
        mode=args.mode,
        out_dir=args.out_dir,
        max_gaussians=args.max_gaussians,
        ply_uri_template=args.ply_uri,
    )


# ---------------------------------------------------------- Frame loading --

@dataclass(frozen=True)
class Frame:
    rgb: np.ndarray           # (H, W, 3) uint8, aligned to depth resolution
    depth_m: np.ndarray       # (H, W) float32 meters, NaNs for missing depth
    fx: float; fy: float; cx: float; cy: float
    width: int; height: int
    world_from_camera: np.ndarray  # (4, 4) float64, OpenGL ARKit convention


def _column_major_to_4x4(flat16: list[float]) -> np.ndarray:
    return np.array(flat16, dtype=np.float64).reshape(4, 4, order="F")


def _load_depth_npy(path: Path) -> tuple[np.ndarray, int, int]:
    arr = np.load(path)
    if arr.ndim != 2 or arr.dtype != np.float32:
        raise SystemExit(f"expected (H, W) float32 depth, got {arr.shape} {arr.dtype} from {path}")
    h, w = arr.shape
    return arr, w, h


def _load_rgb_aligned(path: Path, target_w: int, target_h: int) -> np.ndarray:
    img = Image.open(path).convert("RGB")
    if img.size != (target_w, target_h):
        img = img.resize((target_w, target_h), Image.BILINEAR)
    return np.asarray(img)


def _scaled_intrinsics(raw: dict[str, float], dw: int, dh: int) -> tuple[float, float, float, float]:
    scale_x = dw / raw["width"]
    scale_y = dh / raw["height"]
    return (
        raw["fx"] * scale_x, raw["fy"] * scale_y,
        raw["cx"] * scale_x, raw["cy"] * scale_y,
    )


def load_frames_from_bundle(bundle_dir: Path) -> list[Frame]:
    manifest = json.loads((bundle_dir / "manifest.json").read_text())
    frames: list[Frame] = []
    for entry in manifest["frames"]:
        depth, dw, dh = _load_depth_npy(bundle_dir / entry["depth_path"])
        rgb = _load_rgb_aligned(bundle_dir / entry["rgb_path"], dw, dh)
        pose = json.loads((bundle_dir / entry["pose_path"]).read_text())
        intr = json.loads((bundle_dir / entry["intrinsics_path"]).read_text())
        fx, fy, cx, cy = _scaled_intrinsics(intr, dw, dh)
        frames.append(Frame(
            rgb=rgb, depth_m=depth,
            fx=fx, fy=fy, cx=cx, cy=cy, width=dw, height=dh,
            world_from_camera=_column_major_to_4x4(pose["camera_transform"]),
        ))
    return frames


def load_frames_from_fixture(fixture_dir: Path) -> list[Frame]:
    scene = json.loads((fixture_dir / "scene.json").read_text())
    frames: list[Frame] = []
    for entry in scene.get("captured_frames", []):
        def resolve(uri: str) -> Path:
            if uri.startswith("/dev/fixtures/"):
                rel = uri[len("/dev/fixtures/"):]
                segs = rel.split("/", 1)
                if len(segs) == 2 and segs[1].startswith("frames/"):
                    return fixture_dir / segs[1]
            raise SystemExit(f"cannot resolve frame uri to fixture file: {uri}")
        depth, dw, dh = _load_depth_npy(resolve(entry["depth"]["uri"]))
        rgb = _load_rgb_aligned(resolve(entry["rgb"]["uri"]), dw, dh)
        fx, fy, cx, cy = _scaled_intrinsics(entry["intrinsics"], dw, dh)
        frames.append(Frame(
            rgb=rgb, depth_m=depth,
            fx=fx, fy=fy, cx=cx, cy=cy, width=dw, height=dh,
            world_from_camera=_column_major_to_4x4(entry["camera_transform"]),
        ))
    return frames


# ---------------------------------------------------------- RGBD → gaussians --

# Depth cap for RGBD-init. The original 8m default was kept for tests with
# synthetic bundles, but real indoor scans rarely have valid depth past 5m
# and the ARKit sensor returns plenty of outliers at longer ranges that show
# up as floating-in-space Gaussians outside the room wireframe. 5m is a
# comfortable ceiling for bedroom / living-room capture.
DEPTH_CAP_M = 5.0

# Scale multiplier applied on top of the per-pixel footprint at depth. With
# the 0.5× starting value the Gaussians rendered as isolated dots; 1.5×
# makes neighbouring splats overlap enough to read as surfaces while still
# preserving visible detail on furniture edges.
SCALE_MULTIPLIER = 1.5

# Extra slack (metres) applied to the room's floor-polygon AABB + ceiling
# before clipping the RGBD point cloud against it. 20cm accommodates
# scanner noise near walls without letting adjacent-room leakage through.
ROOM_CLIP_SLACK_M = 0.20


def _unproject_frame(frame: Frame) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """
    Unproject every valid depth pixel to world XYZ + RGB + surface-normal
    estimated from local depth gradients. The normal is essential for
    orienting each Gaussian as a disk aligned with the underlying surface
    rather than a sphere; that alone is most of the "fuzzy → sharp" delta
    on flat walls + the bed top.

    Returns (world_xyz (N,3), rgb_01 (N,3), world_normals (N,3)).
    """
    depth_m = frame.depth_m
    valid = np.isfinite(depth_m) & (depth_m > 0.05) & (depth_m < DEPTH_CAP_M)
    if not np.any(valid):
        return np.zeros((0, 3)), np.zeros((0, 3)), np.zeros((0, 3))

    # Camera-space normals from depth gradients. We compute ∂/∂u, ∂/∂v of
    # the unprojected camera-frame XYZ and cross them. Edge pixels where
    # the gradient spans a depth discontinuity end up with long tangent
    # vectors → we drop those via a max-gradient-length cutoff so we don't
    # smear gaussians across occlusion boundaries.
    dw, dh = frame.width, frame.height
    uu, vv = np.meshgrid(np.arange(dw), np.arange(dh))
    # Work in a full HxWx3 camera-frame grid so np.gradient behaves.
    depth_safe = np.where(valid, depth_m, np.nan).astype(np.float32)
    x_cam = (uu - frame.cx) * depth_safe / frame.fx
    y_cam = -(vv - frame.cy) * depth_safe / frame.fy
    z_cam = -depth_safe
    cam_grid = np.stack([x_cam, y_cam, z_cam], axis=-1)  # (H, W, 3)
    # np.gradient returns arrays ordered (∂/∂v, ∂/∂u). Any NaN → NaN here
    # which carries through to the cross product and the final normal,
    # which gets filtered below.
    dvs, dus = np.gradient(cam_grid, axis=(0, 1))
    cam_normals = np.cross(dus, dvs)  # right-hand: du × dv → outward
    norm_mag = np.linalg.norm(cam_normals, axis=-1)
    # Drop pixels whose normals are ill-conditioned (NaN, zero, or one of
    # the neighbours straddled an occlusion edge → giant gradient).
    valid_normal = np.isfinite(norm_mag) & (norm_mag > 1e-6) & (norm_mag < 0.5)
    # Combine with the depth-validity mask.
    mask = valid & valid_normal
    if not np.any(mask):
        return np.zeros((0, 3)), np.zeros((0, 3)), np.zeros((0, 3))

    # Normalize normals, flip toward the camera origin (in camera frame,
    # outward-facing means pointing at +Z: our cam frame has -Z forward).
    safe_norm = np.where(norm_mag > 1e-6, norm_mag, 1.0)
    cam_normals_unit = cam_normals / safe_norm[..., None]
    # Flip so normals face toward the camera (z component > 0 ⇒ already
    # pointing at the camera when camera looks down -Z; otherwise flip).
    # Our camera frame has -Z forward, so a pixel's cam-space z is negative
    # (z_cam = -depth). The outward surface normal should have cam_z > 0
    # (point back toward the camera, which sits at z=0).
    # Flip normals whose z is negative.
    flip = cam_normals_unit[..., 2] < 0
    cam_normals_unit[flip] *= -1

    # Pull out valid pixels and transform to world frame.
    d = depth_m[mask]
    u_flat = uu[mask]
    v_flat = vv[mask]
    x_c = (u_flat - frame.cx) * d / frame.fx
    y_c = -(v_flat - frame.cy) * d / frame.fy
    z_c = -d
    cam_pts = np.stack([x_c, y_c, z_c, np.ones_like(d)], axis=1)
    world_pts = cam_pts @ frame.world_from_camera.T
    # Normals are directions, so the translation column of the pose
    # doesn't matter; use only the rotation part.
    rotation = frame.world_from_camera[:3, :3]
    cam_n_valid = cam_normals_unit[mask]
    world_normals = cam_n_valid @ rotation.T
    # Renormalize (rotation should preserve length but float noise).
    wn_mag = np.linalg.norm(world_normals, axis=-1, keepdims=True)
    world_normals = world_normals / np.where(wn_mag > 1e-6, wn_mag, 1.0)
    colors = frame.rgb[mask].astype(np.float32) / 255.0
    return (
        world_pts[:, :3].astype(np.float32),
        colors,
        world_normals.astype(np.float32),
    )


def _estimate_scales(depth_at_pixel: np.ndarray, fx: float, fy: float) -> np.ndarray:
    """
    Estimate per-gaussian scale from projected pixel footprint at each gaussian's
    depth: one pixel at distance z covers roughly z/fx horizontally and z/fy
    vertically. SCALE_MULTIPLIER inflates that so neighbouring Gaussians
    overlap into visible surfaces rather than rendering as isolated dots.

    Returns an (N, 3) array of anisotropic scales — the first two columns
    are the in-plane (tangential) extent, the third is a thin out-of-plane
    thickness. Combined with normal-aligned rotations this turns each
    Gaussian into a small oriented disk that sits on the surface, which is
    what makes flat walls + the bed top actually read as flat instead of
    fuzzy volume.
    """
    pix_x = depth_at_pixel / fx
    pix_y = depth_at_pixel / fy
    pix = np.maximum(pix_x, pix_y) * SCALE_MULTIPLIER
    tangential = pix.astype(np.float32)
    # Out-of-plane thickness ≈ 35% of the tangential extent — thin enough
    # to look like a disk edge-on, thick enough to survive tiny alignment
    # errors in the normal estimate.
    normal_thickness = tangential * 0.35
    return np.stack([tangential, tangential, normal_thickness], axis=1).astype(np.float32)


def _normals_to_quaternions(normals: np.ndarray) -> np.ndarray:
    """
    Build per-Gaussian rotation quaternions (x, y, z, w) that orient the
    Gaussian's local +Z axis along the world-space surface normal. The
    in-plane (X, Y) basis is picked to be stable but arbitrary rotation
    around the normal — Gaussians are symmetric in-plane since
    _estimate_scales returns the same X and Y magnitudes, so any in-plane
    rotation is visually equivalent.

    Uses the "shortest rotation between two unit vectors" formula:
        q = (axis=sin(θ/2)*(a×b), scalar=cos(θ/2)) where cos θ = a·b.
    Reference frame: local +Z → world normal.
    """
    n = normals.shape[0]
    out = np.zeros((n, 4), dtype=np.float32)  # (x, y, z, w)
    z_axis = np.array([0.0, 0.0, 1.0], dtype=np.float32)
    for i in range(n):
        v = normals[i]
        # Dot with local +Z
        dot = float(np.clip(z_axis @ v, -1.0, 1.0))
        if dot > 0.99999:
            # Already aligned — identity quaternion.
            out[i] = (0.0, 0.0, 0.0, 1.0)
            continue
        if dot < -0.99999:
            # 180° flip — choose any in-plane axis.
            out[i] = (1.0, 0.0, 0.0, 0.0)
            continue
        axis = np.cross(z_axis, v)
        axis_norm = float(np.linalg.norm(axis))
        if axis_norm < 1e-8:
            out[i] = (0.0, 0.0, 0.0, 1.0)
            continue
        axis = axis / axis_norm
        half_theta = np.arccos(dot) * 0.5
        s = float(np.sin(half_theta))
        c = float(np.cos(half_theta))
        out[i, 0] = axis[0] * s
        out[i, 1] = axis[1] * s
        out[i, 2] = axis[2] * s
        out[i, 3] = c
    return out


def _voxel_downsample(
    positions: np.ndarray,
    colors: np.ndarray,
    scales: np.ndarray,
    normals: np.ndarray,
    voxel_size_m: float,
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """
    Collapse points to one representative per voxel. Random subsampling
    across the raw 2M+ unprojected points tends to clump Gaussians where
    the capture path dwelled and leaves gaps in briefly-imaged regions;
    voxel downsampling spreads coverage evenly.

    Representative = mean of (positions, colors, scales); the normal is
    taken as the normalised mean as well, which averages out noisy
    gradient estimates on the same underlying surface.
    """
    if positions.shape[0] == 0:
        return positions, colors, scales, normals
    # Quantise to voxel indices (int32 is plenty for a room).
    voxel_idx = np.floor(positions / voxel_size_m).astype(np.int64)
    # Pack 3D index into a single int64 key: (x * P + y) * P + z with a big prime P.
    P = 1_000_003
    keys = (voxel_idx[:, 0] * P + voxel_idx[:, 1]) * P + voxel_idx[:, 2]
    unique_keys, inverse = np.unique(keys, return_inverse=True)
    count = np.bincount(inverse, minlength=unique_keys.size)
    def mean_cols(array: np.ndarray) -> np.ndarray:
        # Per-column bincount to accumulate → divide by count.
        cols = []
        for c in range(array.shape[1]):
            sums = np.bincount(inverse, weights=array[:, c], minlength=unique_keys.size)
            cols.append(sums / count)
        return np.stack(cols, axis=1)
    pos_out = mean_cols(positions)
    col_out = mean_cols(colors)
    scale_out = mean_cols(scales)
    norm_out = mean_cols(normals)
    # Renormalize the averaged normals so the quaternion construction
    # downstream gets unit vectors.
    mag = np.linalg.norm(norm_out, axis=-1, keepdims=True)
    norm_out = norm_out / np.where(mag > 1e-6, mag, 1.0)
    return (
        pos_out.astype(np.float32),
        col_out.astype(np.float32),
        scale_out.astype(np.float32),
        norm_out.astype(np.float32),
    )


def _load_room_clip_bounds(scene: dict) -> dict | None:
    """
    Extract an axis-aligned room clip box from the scene's shell. Returns
    None when the scene lacks a floor polygon + ceiling height (non-fixture
    bundles). The box is the AABB of the floor polygon in XY, union-ed with
    [0, ceiling_height] in Z, inflated uniformly by ROOM_CLIP_SLACK_M.
    """
    try:
        shell = scene["snapshot"]["state"]["room"]["shell"]
        vertices = shell["floor_polygon"]["vertices"]
        ceiling_z = float(shell["ceiling_height"])
    except (KeyError, TypeError):
        return None
    if not vertices:
        return None
    xs = [float(v["x"]) for v in vertices]
    ys = [float(v["y"]) for v in vertices]
    slack = ROOM_CLIP_SLACK_M
    return {
        "min_x": min(xs) - slack,
        "max_x": max(xs) + slack,
        "min_y": min(ys) - slack,
        "max_y": max(ys) + slack,
        "min_z": -slack,
        "max_z": ceiling_z + slack,
    }


def _apply_room_clip(
    positions: np.ndarray, colors: np.ndarray, scales: np.ndarray, bounds: dict,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """
    Keep only gaussians whose world position is inside the inflated room AABB.
    Real indoor scans place the floor at z=0; depth sensor noise, reflective
    surfaces, and outliers past the walls all produce points outside this box
    which render as a haze surrounding the room if not filtered.
    """
    mask = (
        (positions[:, 0] >= bounds["min_x"]) & (positions[:, 0] <= bounds["max_x"]) &
        (positions[:, 1] >= bounds["min_y"]) & (positions[:, 1] <= bounds["max_y"]) &
        (positions[:, 2] >= bounds["min_z"]) & (positions[:, 2] <= bounds["max_z"])
    )
    return positions[mask], colors[mask], scales[mask]


def _subsample(positions: np.ndarray, colors: np.ndarray, scales: np.ndarray, max_count: int, seed: int = 0) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    if positions.shape[0] <= max_count:
        return positions, colors, scales
    rng = np.random.default_rng(seed=seed)
    idx = rng.choice(positions.shape[0], size=max_count, replace=False)
    return positions[idx], colors[idx], scales[idx]


VOXEL_DOWNSAMPLE_SIZE_M = 0.015  # 1.5cm per Gaussian after downsampling


def build_rgbd_init_gaussians(
    frames: list[Frame],
    max_gaussians: int,
    clip_bounds: dict | None = None,
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """
    Return (positions (N,3), colors (N,3) in [0,1], scales (N,3) anisotropic,
    quaternions (N,4) xyzw) for N Gaussians aggregated from every frame.

    Pipeline:
      1. Unproject each frame into world-space points + per-pixel normals
         (from local depth gradients, dropping occlusion-edge pixels).
      2. Concatenate across frames.
      3. Room-clip to the scene's floor-polygon AABB + ceiling (when
         available), cutting the depth-sensor haze that falls outside the
         room wireframe.
      4. Voxel-downsample to VOXEL_DOWNSAMPLE_SIZE_M — one representative
         Gaussian per voxel averages out the clumps that random subsample
         leaves in over-scanned regions.
      5. Random-subsample to max_gaussians as a final ceiling.
      6. Convert each world normal into a rotation quaternion that orients
         the Gaussian's local +Z along the normal (disk lying on surface).
    """
    pos_list: list[np.ndarray] = []
    col_list: list[np.ndarray] = []
    scale_list: list[np.ndarray] = []
    norm_list: list[np.ndarray] = []
    for frame in frames:
        world_pts, colors, world_normals = _unproject_frame(frame)
        if world_pts.shape[0] == 0:
            continue
        # The mask inside _unproject_frame already combined depth-validity
        # with normal-gradient-validity; recompute the same-shaped depth
        # array here so scales line up with the returned points.
        mask = np.isfinite(frame.depth_m) & (frame.depth_m > 0.05) & (frame.depth_m < DEPTH_CAP_M)
        # We need the same subset the function returned. The normal mask
        # drops some extra pixels so the cardinalities won't match a plain
        # depth mask. Instead, re-derive depth directly from the returned
        # camera-space Z (world_pts' depth in camera frame).
        # Simpler + correct: project world_pts back into the camera and
        # read depth.
        homog = np.concatenate([world_pts, np.ones((world_pts.shape[0], 1))], axis=1)
        cam = homog @ np.linalg.inv(frame.world_from_camera).T
        # In ARKit OpenGL, cam-z is negative for in-front points; depth = -z.
        d = -cam[:, 2]
        scales = _estimate_scales(d, frame.fx, frame.fy)
        pos_list.append(world_pts)
        col_list.append(colors)
        scale_list.append(scales)
        norm_list.append(world_normals)
    if not pos_list:
        raise SystemExit("[splat-generate] rgbd_init: no frames produced valid depth pixels")
    positions = np.concatenate(pos_list, axis=0)
    colors = np.concatenate(col_list, axis=0)
    scales = np.concatenate(scale_list, axis=0)
    normals = np.concatenate(norm_list, axis=0)

    if clip_bounds is not None:
        pre_clip = positions.shape[0]
        mask = (
            (positions[:, 0] >= clip_bounds["min_x"]) & (positions[:, 0] <= clip_bounds["max_x"]) &
            (positions[:, 1] >= clip_bounds["min_y"]) & (positions[:, 1] <= clip_bounds["max_y"]) &
            (positions[:, 2] >= clip_bounds["min_z"]) & (positions[:, 2] <= clip_bounds["max_z"])
        )
        positions = positions[mask]
        colors = colors[mask]
        scales = scales[mask]
        normals = normals[mask]
        kept = positions.shape[0]
        print(
            f"[splat-generate] room-clip kept {kept}/{pre_clip} points ({kept/max(pre_clip,1)*100:.1f}%)",
            file=sys.stderr,
        )

    pre_voxel = positions.shape[0]
    positions, colors, scales, normals = _voxel_downsample(
        positions, colors, scales, normals, VOXEL_DOWNSAMPLE_SIZE_M,
    )
    print(
        f"[splat-generate] voxel-downsample {pre_voxel} → {positions.shape[0]} "
        f"(voxel={VOXEL_DOWNSAMPLE_SIZE_M}m)",
        file=sys.stderr,
    )

    if positions.shape[0] > max_gaussians:
        rng = np.random.default_rng(seed=0)
        idx = rng.choice(positions.shape[0], size=max_gaussians, replace=False)
        positions = positions[idx]
        colors = colors[idx]
        scales = scales[idx]
        normals = normals[idx]

    quaternions = _normals_to_quaternions(normals)
    return positions, colors, scales, quaternions


def pack_splat_bytes(
    positions: np.ndarray,
    colors: np.ndarray,
    scales: np.ndarray,
    quaternions: np.ndarray,
) -> bytes:
    """
    Pack the (positions, colors, scales, quaternions) quad into the 32-byte-
    per-gaussian binary .splat format used by antimatter15's viewer and
    gsplat.js. The antimatter15 quaternion encoding is ((q + 1) / 2) * 255
    per component in WXYZ order (see antimatter15/splat README).
    """
    n = positions.shape[0]
    assert colors.shape == (n, 3) and scales.shape == (n, 3) and quaternions.shape == (n, 4)
    buf = bytearray(n * 32)
    view = memoryview(buf)
    # positions: 12 bytes (float32 x 3)
    pos_f32 = positions.astype(np.float32, copy=False)
    # scales: 12 bytes (float32 x 3) — the .splat format stores raw scales,
    # NOT log-scales. gsplat.js expects this.
    scale_f32 = scales.astype(np.float32, copy=False)
    # colors: 4 bytes per gaussian (R, G, B, alpha)
    rgb_u8 = np.clip(np.round(colors * 255.0), 0, 255).astype(np.uint8)
    # Quantize quaternions. The .splat format orders bytes as (w, x, y, z);
    # our quaternions array is (x, y, z, w), so rearrange.
    q_xyzw = quaternions.astype(np.float32, copy=False)
    q_wxyz = np.stack([q_xyzw[:, 3], q_xyzw[:, 0], q_xyzw[:, 1], q_xyzw[:, 2]], axis=1)
    quat_u8 = np.clip(np.round((q_wxyz + 1.0) * 0.5 * 255.0), 0, 255).astype(np.uint8)
    # Build structured interleaved layout.
    for i in range(n):
        base = i * 32
        view[base + 0:base + 12] = pos_f32[i].tobytes()
        view[base + 12:base + 24] = scale_f32[i].tobytes()
        view[base + 24] = int(rgb_u8[i, 0])
        view[base + 25] = int(rgb_u8[i, 1])
        view[base + 26] = int(rgb_u8[i, 2])
        view[base + 27] = 255  # alpha
        view[base + 28] = int(quat_u8[i, 0])
        view[base + 29] = int(quat_u8[i, 1])
        view[base + 30] = int(quat_u8[i, 2])
        view[base + 31] = int(quat_u8[i, 3])
    return bytes(buf)


def _bundle_signature(bundle_dir: Path) -> bytes:
    """
    Sum of file sizes + filenames under the bundle — enough to perturb the
    deterministic stub when the bundle actually changes, without reading
    every byte. Good enough for a fixture mode; the real backend will
    compute its own signature from the trained model.
    """
    hasher = hashlib.sha256()
    if bundle_dir.exists() and bundle_dir.is_dir():
        for entry in sorted(bundle_dir.rglob("*")):
            if entry.is_file():
                rel = entry.relative_to(bundle_dir).as_posix()
                hasher.update(rel.encode("utf-8"))
                hasher.update(b"\0")
                hasher.update(entry.stat().st_size.to_bytes(8, "little"))
    return hasher.digest()


def _source_dir(request: SplatRequest) -> Path:
    if request.bundle_dir is not None:
        return request.bundle_dir
    assert request.fixture_dir is not None
    return request.fixture_dir


def render_fixture_descriptor(request: SplatRequest) -> dict:
    signature = _bundle_signature(_source_dir(request))
    digest_hex = hashlib.sha1(
        request.capture_id.encode("utf-8") + b"|" + signature
    ).hexdigest()
    splat_id = f"splat:{digest_hex[:16]}"
    # Synthesize a plausible gaussian count so observability dashboards have
    # a non-zero value; derived from the signature so it is deterministic.
    gaussian_count = 50_000 + int.from_bytes(signature[:2], "big") * 10
    return {
        "splat_id": splat_id,
        "capture_id": request.capture_id,
        "generator_kind": "deterministic_stub",
        "ply_uri": request.ply_uri_template or f"asset://splats/{request.capture_id}/{splat_id}.ply",
        "ply_bytes_sha256": None,
        "gaussian_count": gaussian_count,
        "generated_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    }


def render_rgbd_init(request: SplatRequest) -> tuple[dict, bytes, str]:
    """
    Load the capture frames (bundle-style or fixture-style), seed one Gaussian
    per valid depth pixel, pack into the binary .splat format, and return the
    (descriptor, splat_bytes, splat_filename) triple.

    When `--fixture FIXTURE_DIR` is used, the default ply_uri is the dev-route
    path `/dev/fixtures/{fixture_id}/splats/{filename}` so the committed scene.json
    can carry a browser-loadable URI out of the box. Override via --ply-uri (the
    template supports the literal `__FILENAME__` token).
    """
    clip_bounds: dict | None = None
    if request.bundle_dir is not None:
        frames = load_frames_from_bundle(request.bundle_dir)
        # Bundles don't carry a shell polygon yet — skip room clipping.
    else:
        assert request.fixture_dir is not None
        frames = load_frames_from_fixture(request.fixture_dir)
        scene = json.loads((request.fixture_dir / "scene.json").read_text())
        clip_bounds = _load_room_clip_bounds(scene)
    positions, colors, scales, quaternions = build_rgbd_init_gaussians(
        frames, request.max_gaussians, clip_bounds,
    )
    splat_bytes = pack_splat_bytes(positions, colors, scales, quaternions)
    sha = hashlib.sha256(splat_bytes).hexdigest()
    # Deterministic splat_id from the content hash keeps re-runs stable.
    splat_id = f"splat:{sha[:16]}"
    filename = splat_id.replace(":", "_") + ".splat"
    if request.ply_uri_template:
        ply_uri = request.ply_uri_template.replace("__FILENAME__", filename)
    elif request.fixture_dir is not None:
        ply_uri = f"/dev/fixtures/{request.fixture_dir.name}/splats/{filename}"
    else:
        ply_uri = f"asset://splats/{request.capture_id}/{filename}"
    descriptor = {
        "splat_id": splat_id,
        "capture_id": request.capture_id,
        "generator_kind": "rgbd_init",
        "ply_uri": ply_uri,
        "ply_bytes_sha256": sha,
        "gaussian_count": int(positions.shape[0]),
        "generated_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    }
    return descriptor, splat_bytes, filename


def write_descriptor(request: SplatRequest, descriptor: dict) -> Path:
    request.out_dir.mkdir(parents=True, exist_ok=True)
    json_name = descriptor["splat_id"].replace(":", "_") + ".json"
    json_path = request.out_dir / json_name
    json_path.write_text(json.dumps(descriptor, indent=2) + "\n")
    return json_path


def write_splat_binary(request: SplatRequest, filename: str, data: bytes) -> Path:
    request.out_dir.mkdir(parents=True, exist_ok=True)
    out = request.out_dir / filename
    out.write_bytes(data)
    return out


def run_splatfacto_mode(_request: SplatRequest) -> None:
    raise SystemExit(
        "[splat-generate] --mode splatfacto is not wired yet (Showcase Week 4 follow-up).\n"
        "\n"
        "Current state: --mode rgbd_init seeds Gaussians directly from the captured\n"
        "RGBD frames. Output is photoreal (RGB baked into each splat) but unoptimized —\n"
        "this is the init stage of any 3DGS pipeline. For the final quality pass, run\n"
        "Nerfstudio's Splatfacto against the bundle with depth supervision on a GPU box\n"
        "and ingest the resulting .ply via this same descriptor shape. See\n"
        "docs/showcase-phase.md Track B notes.\n"
    )


def main(argv: list[str]) -> int:
    request = parse_args(argv)
    if request.mode == "splatfacto":
        run_splatfacto_mode(request)
        return 2
    if request.mode == "rgbd_init":
        descriptor, splat_bytes, filename = render_rgbd_init(request)
        splat_path = write_splat_binary(request, filename, splat_bytes)
        descriptor_path = write_descriptor(request, descriptor)
        print(json.dumps({
            "descriptor": str(descriptor_path),
            "splat": str(splat_path),
            "gaussian_count": descriptor["gaussian_count"],
            "bytes": len(splat_bytes),
        }))
        return 0
    descriptor = render_fixture_descriptor(request)
    path = write_descriptor(request, descriptor)
    print(str(path))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
