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
        choices=["fixture", "rgbd_init", "cohesive", "splatfacto"],
        default="fixture",
        help="fixture: deterministic stub (CI-safe); rgbd_init: seed gaussians from RGBD frames (CPU, no training); cohesive: rgbd_init + TSDF-mesh seeds + shell-surface inpaint for a room that reads as continuous surfaces (CPU, no training); splatfacto: real optimized backend (GPU required, not wired).",
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
    #
    # Convention note: the ARKitScenes trajectory (.traj) stores camera
    # poses in OpenCV convention (+X right, +Y DOWN in image, +Z forward
    # into scene) — verified by checking frame 24's cam_Y axis in world
    # coords (points in -Z_world, meaning phone's "up" is anti-aligned
    # with world up). Earlier code here assumed OpenGL, which rendered
    # the splat mirror-flipped through each camera (objects near floor
    # ended up on the ceiling). See docs/pose-conventions.md.
    dw, dh = frame.width, frame.height
    uu, vv = np.meshgrid(np.arange(dw), np.arange(dh))
    # Work in a full HxWx3 camera-frame grid so np.gradient behaves.
    depth_safe = np.where(valid, depth_m, np.nan).astype(np.float32)
    x_cam = (uu - frame.cx) * depth_safe / frame.fx
    y_cam = (vv - frame.cy) * depth_safe / frame.fy   # OpenCV: +Y is image-down
    z_cam = depth_safe                                  # OpenCV: +Z is forward
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

    # Normalize normals. Under OpenCV, cam +Z is forward into the scene,
    # so outward-facing normals (pointing back at the camera, which sits
    # at z=0) should have cam_z < 0. Flip any whose z is positive.
    safe_norm = np.where(norm_mag > 1e-6, norm_mag, 1.0)
    cam_normals_unit = cam_normals / safe_norm[..., None]
    flip = cam_normals_unit[..., 2] > 0
    cam_normals_unit[flip] *= -1

    # Pull out valid pixels and transform to world frame.
    d = depth_m[mask]
    u_flat = uu[mask]
    v_flat = vv[mask]
    x_c = (u_flat - frame.cx) * d / frame.fx
    y_c = (v_flat - frame.cy) * d / frame.fy   # OpenCV: +Y image-down
    z_c = d                                      # OpenCV: +Z forward
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
        # ARKitScenes OpenCV convention: cam-z is positive for in-front points.
        d = cam[:, 2]
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


# ------------------------------------------------------- Tier 2: mesh seeding --
#
# The committed fixture's bundle-to-meshes.py output gives us a set of
# per-object TSDF meshes (already RGB-baked and normal-oriented by Open3D).
# Sampling points from those triangle surfaces produces a splat seed that
# is denser *and* cleaner than per-frame RGBD unprojection on the same
# objects — the TSDF has already averaged over every observing frame.
#
# The goal of this tier is coverage on object surfaces; the output
# Gaussians carry the mesh's own vertex colors and normals (interpolated
# barycentrically), packaged as thin disks at MESH_SEED_SCALE_M scale.


MESH_SEED_SAMPLES_PER_M2 = 4000   # ≈ one gaussian per 2.5mm² of mesh — dense
                                   # enough that voxel-downsample at 1.5cm
                                   # leaves 3–4 gaussians per voxel (overlap
                                   # into a readable surface) without blowing
                                   # past the max-gaussians cap on a bedroom.
MESH_SEED_TANGENTIAL_M = 0.022    # in-plane radius (2.2cm). Matches ~1.5×
                                   # voxel size, same ratio as the RGBD
                                   # SCALE_MULTIPLIER so mesh gaussians feel
                                   # visually contiguous with unprojected ones.
MESH_SEED_NORMAL_THICKNESS_RATIO = 0.35  # disk-like


@dataclass(frozen=True)
class TsdfMesh:
    object_id: str
    vertices: np.ndarray   # (V, 3) float32
    normals: np.ndarray    # (V, 3) float32 (unit)
    colors: np.ndarray     # (V, 3) float32 in [0, 1]
    faces: np.ndarray      # (F, 3) int32


def _parse_ascii_ply(path: Path) -> TsdfMesh | None:
    """
    Minimal ASCII PLY parser for the Open3D-emitted `write_triangle_mesh`
    subset we use: `property double x/y/z, nx/ny/nz, uchar red/green/blue`
    vertex layout plus triangle-list faces. Returns None if the file is
    missing / not the format we expect.
    """
    if not path.exists():
        return None
    text = path.read_text()
    header_end = text.find("\nend_header\n")
    if header_end < 0:
        return None
    header_lines = text[:header_end].split("\n")
    if header_lines[0] != "ply" or not any(l.strip() == "format ascii 1.0" for l in header_lines):
        return None
    elements: list[dict] = []
    current: dict | None = None
    for line in header_lines:
        if line.startswith("element "):
            parts = line.split()
            current = {"name": parts[1], "count": int(parts[2]), "props": []}
            elements.append(current)
        elif line.startswith("property ") and current is not None:
            parts = line.split()
            if parts[1] == "list":
                current["props"].append({"kind": "list", "value_type": parts[3], "name": parts[4]})
            else:
                current["props"].append({"kind": "scalar", "type": parts[1], "name": parts[2]})
    vertex = next((e for e in elements if e["name"] == "vertex"), None)
    face = next((e for e in elements if e["name"] == "face"), None)
    if not vertex or not face:
        return None
    prop_names = [p["name"] for p in vertex["props"]]
    try:
        idx_x = prop_names.index("x"); idx_y = prop_names.index("y"); idx_z = prop_names.index("z")
    except ValueError:
        return None
    has_normals = all(n in prop_names for n in ("nx", "ny", "nz"))
    has_colors = all(n in prop_names for n in ("red", "green", "blue"))
    body = text[header_end + len("\nend_header\n"):].splitlines()
    positions = np.zeros((vertex["count"], 3), dtype=np.float32)
    normals = np.zeros((vertex["count"], 3), dtype=np.float32) if has_normals else None
    colors = np.zeros((vertex["count"], 3), dtype=np.float32) if has_colors else None
    cursor = 0
    for i in range(vertex["count"]):
        tokens = body[cursor].split()
        cursor += 1
        positions[i] = (float(tokens[idx_x]), float(tokens[idx_y]), float(tokens[idx_z]))
        if has_normals:
            nx = prop_names.index("nx"); ny = prop_names.index("ny"); nz = prop_names.index("nz")
            normals[i] = (float(tokens[nx]), float(tokens[ny]), float(tokens[nz]))
        if has_colors:
            r = prop_names.index("red"); g = prop_names.index("green"); b = prop_names.index("blue")
            colors[i] = (float(tokens[r]) / 255.0, float(tokens[g]) / 255.0, float(tokens[b]) / 255.0)
    # Triangles. Open3D emits a count-prefixed `3 a b c` per face; we only
    # support that subset (no quad/ngon fans).
    tri_rows: list[tuple[int, int, int]] = []
    for _ in range(face["count"]):
        tokens = body[cursor].split()
        cursor += 1
        count = int(tokens[0])
        if count < 3:
            continue
        v0 = int(tokens[1])
        for j in range(1, count - 1):
            tri_rows.append((v0, int(tokens[1 + j]), int(tokens[1 + j + 1])))
    faces = np.array(tri_rows, dtype=np.int32)
    if normals is None:
        # No vertex normals; synthesize from face geometry then average onto
        # vertices. Good enough since Open3D normally writes normals, so this
        # is a safety fallback.
        face_edges1 = positions[faces[:, 1]] - positions[faces[:, 0]]
        face_edges2 = positions[faces[:, 2]] - positions[faces[:, 0]]
        face_normals = np.cross(face_edges1, face_edges2)
        fn_mag = np.linalg.norm(face_normals, axis=-1, keepdims=True)
        face_normals = face_normals / np.where(fn_mag > 1e-8, fn_mag, 1.0)
        normals = np.zeros_like(positions)
        for face_idx, (a, b, c) in enumerate(faces):
            normals[a] += face_normals[face_idx]
            normals[b] += face_normals[face_idx]
            normals[c] += face_normals[face_idx]
        n_mag = np.linalg.norm(normals, axis=-1, keepdims=True)
        normals = normals / np.where(n_mag > 1e-8, n_mag, 1.0)
    if colors is None:
        colors = np.full_like(positions, 0.6, dtype=np.float32)
    return TsdfMesh(object_id="", vertices=positions, normals=normals.astype(np.float32),
                    colors=colors.astype(np.float32), faces=faces)


def load_tsdf_meshes(fixture_dir: Path) -> list[TsdfMesh]:
    """Parse every PLY listed in meshes/manifest.json. Returns [] if absent."""
    manifest_path = fixture_dir / "meshes" / "manifest.json"
    if not manifest_path.exists():
        return []
    manifest = json.loads(manifest_path.read_text())
    out: list[TsdfMesh] = []
    for object_id, rel in (manifest.get("meshes") or {}).items():
        mesh = _parse_ascii_ply(fixture_dir / rel)
        if mesh is None:
            continue
        out.append(TsdfMesh(
            object_id=object_id,
            vertices=mesh.vertices, normals=mesh.normals,
            colors=mesh.colors, faces=mesh.faces,
        ))
    return out


def barycentric_sample_mesh(
    mesh: TsdfMesh,
    samples_per_m2: int = MESH_SEED_SAMPLES_PER_M2,
    rng: np.random.Generator | None = None,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """
    Area-weighted uniform sampling on a triangle mesh. Returns
    (positions, colors, normals) in world coordinates, barycentric-
    interpolated from vertex attributes.
    """
    if rng is None:
        rng = np.random.default_rng(seed=hash(mesh.object_id) & 0xFFFFFFFF)
    if mesh.faces.size == 0:
        empty = np.zeros((0, 3), dtype=np.float32)
        return empty, empty, empty
    tri_v = mesh.vertices[mesh.faces]        # (F, 3, 3)
    tri_n = mesh.normals[mesh.faces]         # (F, 3, 3)
    tri_c = mesh.colors[mesh.faces]          # (F, 3, 3)
    edge1 = tri_v[:, 1] - tri_v[:, 0]
    edge2 = tri_v[:, 2] - tri_v[:, 0]
    areas = 0.5 * np.linalg.norm(np.cross(edge1, edge2), axis=-1)
    total = float(areas.sum())
    if total <= 0:
        empty = np.zeros((0, 3), dtype=np.float32)
        return empty, empty, empty
    n_samples = max(1, int(round(total * samples_per_m2)))
    probs = areas / total
    tri_idx = rng.choice(areas.size, size=n_samples, p=probs)
    r1 = rng.random(n_samples); r2 = rng.random(n_samples)
    flip = (r1 + r2) > 1.0
    r1 = np.where(flip, 1.0 - r1, r1)
    r2 = np.where(flip, 1.0 - r2, r2)
    b = np.stack([1.0 - r1 - r2, r1, r2], axis=-1).astype(np.float32)  # (N, 3)
    picked_v = tri_v[tri_idx]
    picked_n = tri_n[tri_idx]
    picked_c = tri_c[tri_idx]
    positions = np.einsum("ij,ijk->ik", b, picked_v)
    normals = np.einsum("ij,ijk->ik", b, picked_n)
    colors = np.einsum("ij,ijk->ik", b, picked_c)
    n_mag = np.linalg.norm(normals, axis=-1, keepdims=True)
    normals = normals / np.where(n_mag > 1e-6, n_mag, 1.0)
    return positions.astype(np.float32), colors.astype(np.float32), normals.astype(np.float32)


def build_mesh_seed_gaussians(
    meshes: list[TsdfMesh],
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """
    Concatenate barycentric-sampled gaussians across all object meshes.
    Returns (positions, colors, scales, normals) — scales are anisotropic
    disks (tangential × 2, thin normal thickness), ready for quaternion
    conversion by _normals_to_quaternions in the caller.
    """
    pos_list: list[np.ndarray] = []
    col_list: list[np.ndarray] = []
    norm_list: list[np.ndarray] = []
    for mesh in meshes:
        p, c, n = barycentric_sample_mesh(mesh)
        if p.shape[0] == 0:
            continue
        pos_list.append(p); col_list.append(c); norm_list.append(n)
    if not pos_list:
        empty = np.zeros((0, 3), dtype=np.float32)
        return empty, empty, empty, empty
    positions = np.concatenate(pos_list, axis=0)
    colors = np.concatenate(col_list, axis=0)
    normals = np.concatenate(norm_list, axis=0)
    tangential = np.full(positions.shape[0], MESH_SEED_TANGENTIAL_M, dtype=np.float32)
    scales = np.stack([tangential, tangential, tangential * MESH_SEED_NORMAL_THICKNESS_RATIO], axis=1)
    return positions, colors, scales, normals


# ------------------------------------------------------- Tier 3: shell inpaint --
#
# Walls/floor/ceiling that the camera trajectory never imaged leave the
# scan pane looking like a bunch of floating dots. Even a crude flat
# color on those surfaces helps the eye read the room as a room. We
# lattice-sample each surface polygon at SHELL_LATTICE_SPACING_M, borrow
# colors from nearby observed splats (so the inpainted color blends with
# what we did capture), and render the resulting gaussians at
# SHELL_INPAINT_ALPHA so the viewer reads them as placeholder rather
# than reality.


SHELL_LATTICE_SPACING_M = 0.05     # 5cm grid — ~8k gaussians per 4m wall,
                                    # fine enough to look like a continuous
                                    # surface after anisotropic disks overlap.
SHELL_INPAINT_TANGENTIAL_M = 0.04   # disk radius ~80% of lattice spacing,
                                    # so neighbours overlap slightly.
SHELL_INPAINT_NORMAL_THICKNESS_RATIO = 0.15  # thinner than mesh-seed disks
                                              # so grazing angles don't bloom.
SHELL_INPAINT_ALPHA = 0.6           # synthesized, not captured — visually
                                    # distinguishable from observed splats.

COLOR_BORROW_RADIUS_M = 0.5         # how far to look for observed colors
COLOR_BORROW_MIN_SAMPLES = 4         # if fewer neighbours than this, use the
                                    # class default instead of a noisy mean.

SHELL_DEFAULT_COLORS: dict[str, tuple[float, float, float]] = {
    # Neutral warm palette; safe across typical bedroom / living-room scenes.
    "floor":   (0.64, 0.52, 0.38),   # medium oak
    "ceiling": (0.92, 0.90, 0.88),   # warm off-white
    "wall":    (0.85, 0.82, 0.77),   # soft beige
}


@dataclass(frozen=True)
class ShellSurface:
    category: str          # "floor" | "ceiling" | "wall"
    origin: np.ndarray     # (3,) world
    u_axis: np.ndarray     # (3,) unit
    v_axis: np.ndarray     # (3,) unit
    normal: np.ndarray     # (3,) unit (inward-facing)
    u_min: float; u_max: float
    v_min: float; v_max: float


def extract_shell_surfaces(scene: dict) -> list[ShellSurface]:
    """
    Pull floor/ceiling/wall surface frames out of the scene shell. Floor
    and ceiling have implicit frames (scene's Z-up world); walls carry
    `surface_frame` explicitly from roomplan-ingest.
    """
    shell = (scene.get("snapshot", {}).get("state", {}).get("room", {}).get("shell")) or {}
    ceiling_height = float(shell.get("ceiling_height", 2.4))
    out: list[ShellSurface] = []
    for surf in shell.get("surfaces", []):
        stype = surf.get("type")
        verts = (surf.get("boundary") or {}).get("vertices") or []
        if not verts:
            continue
        us = [float(v.get("x", 0.0)) for v in verts]
        vs = [float(v.get("y", 0.0)) for v in verts]
        frame = surf.get("surface_frame")
        if frame:
            origin = np.array([frame["origin"]["x"], frame["origin"]["y"], frame["origin"]["z"]], dtype=np.float64)
            u_axis = np.array([frame["u_axis"]["x"], frame["u_axis"]["y"], frame["u_axis"]["z"]], dtype=np.float64)
            v_axis = np.array([frame["v_axis"]["x"], frame["v_axis"]["y"], frame["v_axis"]["z"]], dtype=np.float64)
            normal = np.array([frame["normal"]["x"], frame["normal"]["y"], frame["normal"]["z"]], dtype=np.float64)
        elif stype == "floor":
            origin = np.array([0.0, 0.0, 0.0])
            u_axis = np.array([1.0, 0.0, 0.0])
            v_axis = np.array([0.0, 1.0, 0.0])
            normal = np.array([0.0, 0.0, 1.0])
        elif stype == "ceiling":
            origin = np.array([0.0, 0.0, ceiling_height])
            u_axis = np.array([1.0, 0.0, 0.0])
            v_axis = np.array([0.0, 1.0, 0.0])
            normal = np.array([0.0, 0.0, -1.0])
        else:
            # Walls without an explicit frame — skip rather than fabricate.
            continue
        out.append(ShellSurface(
            category=stype if stype in ("floor", "ceiling") else "wall",
            origin=origin, u_axis=u_axis, v_axis=v_axis, normal=normal,
            u_min=min(us), u_max=max(us), v_min=min(vs), v_max=max(vs),
        ))
    return out


class VoxelColorIndex:
    """
    Cheap spatial hash for the observed point cloud: given a query point
    and a radius, return the observed colors within that radius. Used by
    the shell-inpaint color-borrow step so the synthesized wall gaussians
    inherit captured palette variation instead of a single flat color.
    """

    def __init__(self, positions: np.ndarray, colors: np.ndarray, cell_m: float):
        self.cell = cell_m
        self.positions = positions
        self.colors = colors
        if positions.size == 0:
            self.bucket: dict[int, list[int]] = {}
            return
        idx = np.floor(positions / cell_m).astype(np.int64)
        keys = (idx[:, 0] * 1_000_003 + idx[:, 1]) * 1_000_003 + idx[:, 2]
        # Group indices by key without sort-allocating O(N²) memory.
        order = np.argsort(keys, kind="stable")
        keys_sorted = keys[order]
        self.bucket = {}
        start = 0
        for end in range(1, len(keys_sorted) + 1):
            if end == len(keys_sorted) or keys_sorted[end] != keys_sorted[start]:
                k_val = int(keys_sorted[start])
                self.bucket[k_val] = order[start:end].tolist()
                start = end

    def _key(self, cx: int, cy: int, cz: int) -> int:
        return int(((cx) * 1_000_003 + cy) * 1_000_003 + cz)

    def query(self, pt: np.ndarray, radius: float) -> tuple[np.ndarray, np.ndarray] | None:
        if not self.bucket:
            return None
        span = int(np.ceil(radius / self.cell))
        base = np.floor(pt / self.cell).astype(np.int64)
        cand: list[int] = []
        for dx in range(-span, span + 1):
            for dy in range(-span, span + 1):
                for dz in range(-span, span + 1):
                    found = self.bucket.get(self._key(int(base[0]) + dx, int(base[1]) + dy, int(base[2]) + dz))
                    if found:
                        cand.extend(found)
        if not cand:
            return None
        idx = np.asarray(cand, dtype=np.int64)
        d2 = np.sum((self.positions[idx] - pt) ** 2, axis=-1)
        within = d2 <= radius * radius
        if not within.any():
            return None
        return self.colors[idx[within]], d2[within]


def build_shell_inpaint_gaussians(
    scene: dict,
    observed_positions: np.ndarray,
    observed_colors: np.ndarray,
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """
    Lattice-sample each shell surface and produce flat gaussians oriented
    along the surface normal. Colors are borrowed from observed splats
    within COLOR_BORROW_RADIUS_M (falls back to a class default if the
    surface has no observations nearby). Returns (positions, colors,
    scales, normals, alphas) — alphas encode the `SHELL_INPAINT_ALPHA`
    fade that marks these gaussians as synthesized.
    """
    surfaces = extract_shell_surfaces(scene)
    if not surfaces:
        empty = np.zeros((0, 3), dtype=np.float32)
        return empty, empty, empty, empty, np.zeros((0,), dtype=np.float32)
    color_index = VoxelColorIndex(observed_positions, observed_colors, cell_m=COLOR_BORROW_RADIUS_M)
    pos_list: list[np.ndarray] = []
    col_list: list[np.ndarray] = []
    norm_list: list[np.ndarray] = []
    for surf in surfaces:
        u_count = max(2, int(round((surf.u_max - surf.u_min) / SHELL_LATTICE_SPACING_M)) + 1)
        v_count = max(2, int(round((surf.v_max - surf.v_min) / SHELL_LATTICE_SPACING_M)) + 1)
        u_grid = np.linspace(surf.u_min, surf.u_max, u_count)
        v_grid = np.linspace(surf.v_min, surf.v_max, v_count)
        uu, vv = np.meshgrid(u_grid, v_grid)
        # Lift to world: origin + u*u_axis + v*v_axis.
        pts = (surf.origin[None, None, :] +
               uu[..., None] * surf.u_axis[None, None, :] +
               vv[..., None] * surf.v_axis[None, None, :]).reshape(-1, 3).astype(np.float32)
        # Borrow colors.
        default_color = np.asarray(SHELL_DEFAULT_COLORS.get(surf.category, (0.7, 0.7, 0.7)), dtype=np.float32)
        colors = np.tile(default_color, (pts.shape[0], 1))
        for i, p in enumerate(pts):
            result = color_index.query(p.astype(np.float64), radius=COLOR_BORROW_RADIUS_M)
            if result is None:
                continue
            nearby_cols, nearby_d2 = result
            if nearby_cols.shape[0] < COLOR_BORROW_MIN_SAMPLES:
                continue
            # Inverse-distance weighted mean (clip distance to avoid div by zero).
            w = 1.0 / (np.sqrt(np.maximum(nearby_d2, 1e-6)) + 0.05)
            colors[i] = (nearby_cols * w[:, None]).sum(axis=0) / w.sum()
        normals = np.tile(surf.normal.astype(np.float32), (pts.shape[0], 1))
        pos_list.append(pts); col_list.append(colors); norm_list.append(normals)
    positions = np.concatenate(pos_list, axis=0)
    colors = np.concatenate(col_list, axis=0)
    normals = np.concatenate(norm_list, axis=0)
    tangential = np.full(positions.shape[0], SHELL_INPAINT_TANGENTIAL_M, dtype=np.float32)
    scales = np.stack([tangential, tangential, tangential * SHELL_INPAINT_NORMAL_THICKNESS_RATIO], axis=1)
    alphas = np.full(positions.shape[0], SHELL_INPAINT_ALPHA, dtype=np.float32)
    return positions, colors, scales, normals, alphas


# ---------------------------------------------------- Tier merge + dedup --


# Source-priority enum. LOWER NUMBER = HIGHER PRIORITY when two tiers
# claim the same 1.5cm voxel during dedup. mesh wins over rgbd because
# TSDF already averaged over every frame that saw the object; rgbd wins
# over shell because captured pixels beat synthesized fill.
SOURCE_MESH = 0
SOURCE_RGBD = 1
SOURCE_SHELL = 2


def merge_tiers_by_voxel_priority(
    tiers: list[dict],
    voxel_size_m: float,
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """
    Concatenate tier arrays (each a dict with positions/colors/scales/
    normals/alphas/source) then keep exactly one gaussian per voxel, the
    one with the lowest source enum. Returns the merged
    (positions, colors, scales, normals, alphas, source) tuple.
    """
    if not tiers:
        empty = np.zeros((0, 3), dtype=np.float32)
        return empty, empty, empty, empty, np.zeros((0,), np.float32), np.zeros((0,), np.int8)
    positions = np.concatenate([t["positions"] for t in tiers], axis=0)
    colors = np.concatenate([t["colors"] for t in tiers], axis=0)
    scales = np.concatenate([t["scales"] for t in tiers], axis=0)
    normals = np.concatenate([t["normals"] for t in tiers], axis=0)
    alphas = np.concatenate([t["alphas"] for t in tiers], axis=0)
    sources = np.concatenate([
        np.full(t["positions"].shape[0], t["source"], dtype=np.int8) for t in tiers
    ], axis=0)
    if positions.shape[0] == 0:
        return positions, colors, scales, normals, alphas, sources
    idx = np.floor(positions / voxel_size_m).astype(np.int64)
    keys = (idx[:, 0] * 1_000_003 + idx[:, 1]) * 1_000_003 + idx[:, 2]
    # Sort by (key, source) — stable sort so within a voxel the lowest
    # source enum lands first. np.unique then keeps that first index.
    order = np.lexsort((sources, keys))
    sorted_keys = keys[order]
    _, first_in_group = np.unique(sorted_keys, return_index=True)
    keep = order[first_in_group]
    return (positions[keep], colors[keep], scales[keep],
            normals[keep], alphas[keep], sources[keep])


def pack_splat_bytes(
    positions: np.ndarray,
    colors: np.ndarray,
    scales: np.ndarray,
    quaternions: np.ndarray,
    alphas: np.ndarray | None = None,
) -> bytes:
    """
    Pack the (positions, colors, scales, quaternions) quad into the 32-byte-
    per-gaussian binary .splat format used by antimatter15's viewer and
    gsplat.js. The antimatter15 quaternion encoding is ((q + 1) / 2) * 255
    per component in WXYZ order (see antimatter15/splat README).

    `alphas` is optional, defaults to fully opaque. Pass a per-gaussian alpha
    array in [0, 1] to fade individual gaussians (used by the cohesive-mode
    shell inpaint tier to render synthesized fill at ~0.6 so the eye reads
    it as placeholder, not captured reality).
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
    if alphas is None:
        alpha_u8 = np.full(n, 255, dtype=np.uint8)
    else:
        alpha_u8 = np.clip(np.round(alphas * 255.0), 0, 255).astype(np.uint8)
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
        view[base + 27] = int(alpha_u8[i])
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


def render_cohesive(request: SplatRequest) -> tuple[dict, bytes, str]:
    """
    Combined pipeline: RGBD unprojection + TSDF-mesh seeds + shell-surface
    inpaint, merged by voxel priority (mesh > rgbd > shell). Produces a
    splat that reads as a cohesive room rather than a thin layer of
    observed pixels. Only usable when a fixture dir with meshes/manifest
    is available (the raw-bundle path lacks both mesh and shell data).
    """
    if request.fixture_dir is None:
        raise SystemExit(
            "[splat-generate] --mode cohesive requires --fixture FIXTURE_DIR "
            "(needs meshes/manifest.json + scene.json shell surfaces)."
        )
    frames = load_frames_from_fixture(request.fixture_dir)
    scene = json.loads((request.fixture_dir / "scene.json").read_text())
    clip_bounds = _load_room_clip_bounds(scene)

    # Tier 2 + 3 go first so the RGBD tier's budget (below) can absorb
    # whatever's left of max_gaussians — preserving full mesh + shell
    # coverage. Otherwise a final random cap could carve holes in the
    # synthesized surfaces and undo most of this tier's point.
    meshes = load_tsdf_meshes(request.fixture_dir)
    mesh_positions, mesh_colors, mesh_scales, mesh_normals = build_mesh_seed_gaussians(meshes)

    # Tier 1 — RGBD unprojection (reuse the rgbd_init pipeline).
    rgbd_budget = max(10_000, request.max_gaussians - mesh_positions.shape[0])
    rgbd_positions, rgbd_colors, rgbd_scales, rgbd_quaternions = build_rgbd_init_gaussians(
        frames, rgbd_budget, clip_bounds,
    )
    # Convert quaternions back to normals. _voxel_downsample already
    # returned world normals in build_rgbd_init_gaussians — but the
    # public return is quaternions. Recompute normals from the xyzw quat
    # by applying the rotation to local +Z (which is exactly the
    # normal that _normals_to_quaternions encoded).
    rgbd_normals = _quaternions_to_normals(rgbd_quaternions)
    rgbd_alphas = np.full(rgbd_positions.shape[0], 1.0, dtype=np.float32)
    print(
        f"[splat-generate] tier1 rgbd: {rgbd_positions.shape[0]} gaussians",
        file=sys.stderr,
    )

    mesh_alphas = np.full(mesh_positions.shape[0], 1.0, dtype=np.float32)
    print(
        f"[splat-generate] tier2 mesh: {mesh_positions.shape[0]} gaussians "
        f"from {len(meshes)} TSDF meshes",
        file=sys.stderr,
    )

    # Tier 3 — shell inpaint is NOT emitted into the .splat anymore. The
    # viewer renders shell surfaces as FrontSide Three.js meshes (so they
    # auto-disappear when the camera is outside, giving a dollhouse view
    # on outside orbits). Leaving shell gaussians in the splat blocked
    # that view and produced a 60%-flat-color "box" effect. See viewer.js
    # `buildCaptureInpaintShell` for the replacement.

    tiers = [
        {"positions": mesh_positions, "colors": mesh_colors, "scales": mesh_scales,
         "normals": mesh_normals, "alphas": mesh_alphas, "source": SOURCE_MESH},
        {"positions": rgbd_positions, "colors": rgbd_colors, "scales": rgbd_scales,
         "normals": rgbd_normals, "alphas": rgbd_alphas, "source": SOURCE_RGBD},
    ]
    merged_positions, merged_colors, merged_scales, merged_normals, merged_alphas, merged_sources = (
        merge_tiers_by_voxel_priority(tiers, voxel_size_m=VOXEL_DOWNSAMPLE_SIZE_M)
    )
    print(
        f"[splat-generate] merged: {merged_positions.shape[0]} gaussians "
        f"(mesh={int((merged_sources == SOURCE_MESH).sum())}, "
        f"rgbd={int((merged_sources == SOURCE_RGBD).sum())})",
        file=sys.stderr,
    )

    # Final cap — preserve mesh + shell (synthesized tiers fill coverage
    # gaps by design; subsampling them tears the room apart), and only
    # trim the rgbd tier if we're over budget.
    if merged_positions.shape[0] > request.max_gaussians:
        keep_mask = merged_sources != SOURCE_RGBD
        preserved = int(keep_mask.sum())
        rgbd_room = max(0, request.max_gaussians - preserved)
        rgbd_mask = merged_sources == SOURCE_RGBD
        rgbd_idx = np.flatnonzero(rgbd_mask)
        if rgbd_idx.size > rgbd_room:
            rng = np.random.default_rng(seed=0)
            keep_rgbd = rng.choice(rgbd_idx, size=rgbd_room, replace=False)
            keep_mask[keep_rgbd] = True
        else:
            keep_mask[rgbd_idx] = True
        merged_positions = merged_positions[keep_mask]
        merged_colors = merged_colors[keep_mask]
        merged_scales = merged_scales[keep_mask]
        merged_normals = merged_normals[keep_mask]
        merged_alphas = merged_alphas[keep_mask]
        merged_sources = merged_sources[keep_mask]
        print(
            f"[splat-generate] capped to {merged_positions.shape[0]} gaussians "
            f"(mesh+shell preserved, rgbd trimmed)",
            file=sys.stderr,
        )

    quaternions = _normals_to_quaternions(merged_normals)
    splat_bytes = pack_splat_bytes(
        merged_positions, merged_colors, merged_scales, quaternions, alphas=merged_alphas,
    )
    sha = hashlib.sha256(splat_bytes).hexdigest()
    splat_id = f"splat:{sha[:16]}"
    filename = splat_id.replace(":", "_") + ".splat"
    if request.ply_uri_template:
        ply_uri = request.ply_uri_template.replace("__FILENAME__", filename)
    else:
        ply_uri = f"/dev/fixtures/{request.fixture_dir.name}/splats/{filename}"
    descriptor = {
        "splat_id": splat_id,
        "capture_id": request.capture_id,
        "generator_kind": "cohesive",
        "ply_uri": ply_uri,
        "ply_bytes_sha256": sha,
        "gaussian_count": int(merged_positions.shape[0]),
        "generated_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    }
    return descriptor, splat_bytes, filename


def _quaternions_to_normals(quaternions_xyzw: np.ndarray) -> np.ndarray:
    """
    Recover the unit normal each quaternion rotates local +Z to (i.e. the
    inverse of _normals_to_quaternions). Rotation of (0, 0, 1) by a
    quaternion q = (x, y, z, w) is
        n = (2 (xz + wy), 2 (yz - wx), 1 - 2 (x² + y²))
    Numerically stable for unit quaternions.
    """
    x = quaternions_xyzw[:, 0]; y = quaternions_xyzw[:, 1]
    z = quaternions_xyzw[:, 2]; w = quaternions_xyzw[:, 3]
    nx = 2.0 * (x * z + w * y)
    ny = 2.0 * (y * z - w * x)
    nz = 1.0 - 2.0 * (x * x + y * y)
    n = np.stack([nx, ny, nz], axis=1).astype(np.float32)
    mag = np.linalg.norm(n, axis=-1, keepdims=True)
    return (n / np.where(mag > 1e-6, mag, 1.0)).astype(np.float32)


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
    if request.mode in ("rgbd_init", "cohesive"):
        if request.mode == "rgbd_init":
            descriptor, splat_bytes, filename = render_rgbd_init(request)
        else:
            descriptor, splat_bytes, filename = render_cohesive(request)
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
