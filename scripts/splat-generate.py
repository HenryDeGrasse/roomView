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

def _unproject_frame(frame: Frame) -> tuple[np.ndarray, np.ndarray]:
    """Unproject every valid depth pixel to world XYZ + RGB (normalized [0, 1])."""
    mask = np.isfinite(frame.depth_m) & (frame.depth_m > 0.05) & (frame.depth_m < 8.0)
    if not np.any(mask):
        return np.zeros((0, 3)), np.zeros((0, 3))
    uu, vv = np.meshgrid(np.arange(frame.width), np.arange(frame.height))
    d = frame.depth_m[mask]
    u = uu[mask]
    v = vv[mask]
    # ARKit OpenGL camera frame: +X right, +Y up, -Z forward.
    # pixel (u, v) with v down; y flips to camera +Y up.
    x_c = (u - frame.cx) * d / frame.fx
    y_c = -(v - frame.cy) * d / frame.fy
    z_c = -d
    cam_pts = np.stack([x_c, y_c, z_c, np.ones_like(d)], axis=1)
    world_pts = cam_pts @ frame.world_from_camera.T
    colors = frame.rgb[mask].astype(np.float32) / 255.0
    return world_pts[:, :3].astype(np.float32), colors


def _estimate_scales(positions: np.ndarray, depth_at_pixel: np.ndarray, fx: float, fy: float) -> np.ndarray:
    """
    Estimate per-gaussian scale from projected pixel footprint at each gaussian's
    depth: one pixel at distance z covers roughly z/fx horizontally and z/fy
    vertically. We use half that so neighboring gaussians overlap slightly,
    giving a surface-like appearance.
    """
    pix_x = depth_at_pixel / fx
    pix_y = depth_at_pixel / fy
    pix = np.maximum(pix_x, pix_y)
    scale = (pix * 0.5).reshape(-1, 1)
    # Isotropic scale per gaussian — matches the "point-cloud-of-blobs" look.
    # Real 3DGS training learns anisotropic scales; rgbd_init leaves them iso.
    return np.repeat(scale, 3, axis=1).astype(np.float32)


def _subsample(positions: np.ndarray, colors: np.ndarray, scales: np.ndarray, max_count: int, seed: int = 0) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    if positions.shape[0] <= max_count:
        return positions, colors, scales
    rng = np.random.default_rng(seed=seed)
    idx = rng.choice(positions.shape[0], size=max_count, replace=False)
    return positions[idx], colors[idx], scales[idx]


def build_rgbd_init_gaussians(frames: list[Frame], max_gaussians: int) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """
    Return (positions (N,3), colors (N,3) in [0,1], scales (N,3)) for N
    gaussians, aggregated from every frame with per-pixel unprojection and
    scale estimation, capped to `max_gaussians` via uniform random subsample.
    """
    pos_list: list[np.ndarray] = []
    col_list: list[np.ndarray] = []
    scale_list: list[np.ndarray] = []
    for frame in frames:
        world_pts, colors = _unproject_frame(frame)
        if world_pts.shape[0] == 0:
            continue
        # Recompute per-pixel depth for scale estimation; we could return it
        # from _unproject_frame but the recomputation is cheap and keeps the
        # signature tight.
        mask = np.isfinite(frame.depth_m) & (frame.depth_m > 0.05) & (frame.depth_m < 8.0)
        d = frame.depth_m[mask]
        scales = _estimate_scales(world_pts, d, frame.fx, frame.fy)
        pos_list.append(world_pts)
        col_list.append(colors)
        scale_list.append(scales)
    if not pos_list:
        raise SystemExit("[splat-generate] rgbd_init: no frames produced valid depth pixels")
    positions = np.concatenate(pos_list, axis=0)
    colors = np.concatenate(col_list, axis=0)
    scales = np.concatenate(scale_list, axis=0)
    positions, colors, scales = _subsample(positions, colors, scales, max_gaussians)
    return positions, colors, scales


def pack_splat_bytes(positions: np.ndarray, colors: np.ndarray, scales: np.ndarray) -> bytes:
    """
    Pack the (positions, colors, scales) triple into the 32-byte-per-gaussian
    binary .splat format used by antimatter15's viewer and gsplat.js. Rotation
    is always identity (quaternion (0, 0, 0, 1) → bytes (128, 128, 128, 255)
    after ((q+1)/2)*255 quantization).
    """
    n = positions.shape[0]
    assert colors.shape == (n, 3) and scales.shape == (n, 3)
    buf = bytearray(n * 32)
    view = memoryview(buf)
    # positions: 12 bytes (float32 x 3)
    pos_f32 = positions.astype(np.float32, copy=False)
    # scales: 12 bytes (float32 x 3) — the .splat format stores raw scales,
    # NOT log-scales. gsplat.js expects this.
    scale_f32 = scales.astype(np.float32, copy=False)
    # colors: 4 bytes per gaussian (R, G, B, alpha)
    rgb_u8 = np.clip(np.round(colors * 255.0), 0, 255).astype(np.uint8)
    # rotation: identity quaternion → (0, 0, 0, 1) → quantized bytes.
    # The quantization is (q + 1) / 2 * 255, rounded.
    rot_identity = np.array([
        round((0.0 + 1.0) * 0.5 * 255),
        round((0.0 + 1.0) * 0.5 * 255),
        round((0.0 + 1.0) * 0.5 * 255),
        round((1.0 + 1.0) * 0.5 * 255),
    ], dtype=np.uint8)
    # Build structured interleaved layout.
    for i in range(n):
        base = i * 32
        view[base + 0:base + 12] = pos_f32[i].tobytes()
        view[base + 12:base + 24] = scale_f32[i].tobytes()
        view[base + 24] = int(rgb_u8[i, 0])
        view[base + 25] = int(rgb_u8[i, 1])
        view[base + 26] = int(rgb_u8[i, 2])
        view[base + 27] = 255  # alpha
        view[base + 28:base + 32] = rot_identity.tobytes()
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
    if request.bundle_dir is not None:
        frames = load_frames_from_bundle(request.bundle_dir)
    else:
        assert request.fixture_dir is not None
        frames = load_frames_from_fixture(request.fixture_dir)
    positions, colors, scales = build_rgbd_init_gaussians(frames, request.max_gaussians)
    splat_bytes = pack_splat_bytes(positions, colors, scales)
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
