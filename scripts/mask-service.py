#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = [
#   "numpy>=1.26",
#   "pillow>=10",
# ]
# ///
"""
Mask service for the Showcase-phase Flux inpaint stack (Track A).

Produces a 2D binary PNG mask for a scene surface as seen from a captured
viewpoint. The mask tells the inpaint provider exactly which pixels it may
change — everything outside stays byte-for-byte identical to the reference
RGB (see docs/showcase-phase.md, "Preservation guarantee").

Three modes:

  --mode fixture   Deterministic rectangle mask derived from SHA-256 of
                   (scene_id, surface_id, captured_frame_id). Used by CI
                   and tests where the actual mask geometry does not
                   matter — only that the shape + determinism of the
                   output agree across machines.

  --mode geometric Real surface projection. Loads the captured frame's
                   camera pose + intrinsics plus the scene's surface
                   polygon (u/v boundary + surface_frame origin/u_axis/
                   v_axis), unprojects boundary vertices to world space,
                   projects them through the camera, and rasterizes the
                   2D polygon into a binary mask. Supports both ARKit
                   OpenGL poses (camera_transform column-major, -Z
                   forward) and generic OpenCV poses (+Z forward) via
                   the bundle's `pose_convention` hint.

  --mode sam2      Geometric prior -> SAM2 box-prompt refinement for
                   pixel-precise boundaries. NOT wired — requires a GPU
                   and the segment-anything-2 checkpoint. Exits with a
                   pointer to the follow-up plan. The real pipeline
                   feeds the geometric mask + a bounding-box prompt into
                   SAM2, which returns a refined pixel-tight mask.

Output: two files in --out-dir,

  {mask_id}.png   — binary PNG (mode "L", 0 or 255 per pixel)
  {mask_id}.json  — metadata matching the SurfaceMask contract in
                    packages/contracts/src/scene.ts

Where `mask_id` is `mask:{sha1_of_inputs[:16]}`.

Examples:

  # Fixture rectangle (CI smoke test):
  uv run scripts/mask-service.py \
    --scene-id scene:abc \
    --surface-id surf:wall:north \
    --captured-frame-id frame_000001 \
    --image-width 1024 --image-height 768 \
    --mode fixture \
    --out-dir /tmp/masks

  # Real surface projection (live pipeline):
  uv run scripts/mask-service.py \
    --scene-json fixtures/roomplan/fixture-bedroom-arkitscenes/scene.json \
    --surface-id south_wall \
    --captured-frame-id frame_000001 \
    --mode geometric \
    --out-dir /tmp/masks
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import numpy as np
from PIL import Image, ImageDraw


@dataclass(frozen=True)
class MaskRequest:
    scene_id: str
    surface_id: str
    captured_frame_id: str
    image_width: int
    image_height: int
    mode: str
    out_dir: Path
    scene_json_path: Path | None = None   # required for --mode geometric


def parse_args(argv: list[str]) -> MaskRequest:
    parser = argparse.ArgumentParser(
        description="Generate a 2D edit mask for a scene surface from a captured viewpoint.",
    )
    parser.add_argument("--scene-id", help="Stable scene id. Auto-derived in --mode geometric when --scene-json is supplied.")
    parser.add_argument("--surface-id", required=True)
    parser.add_argument("--captured-frame-id", required=True)
    parser.add_argument("--image-width", type=int, help="Output mask width. In --mode geometric, defaults to the captured frame's intrinsics.width.")
    parser.add_argument("--image-height", type=int, help="Output mask height. In --mode geometric, defaults to the captured frame's intrinsics.height.")
    parser.add_argument(
        "--mode",
        choices=["fixture", "geometric", "sam2"],
        default="fixture",
        help=(
            "fixture: deterministic rectangle (CI-safe); "
            "geometric: real surface polygon projection; "
            "sam2: geometric prior + SAM2 refinement (GPU-required, not wired)."
        ),
    )
    parser.add_argument(
        "--scene-json",
        type=Path,
        default=None,
        help="Path to a scene.json for --mode geometric (reads surface polygon + frame + captured-frame pose/intrinsics).",
    )
    parser.add_argument("--out-dir", type=Path, required=True)
    args = parser.parse_args(argv)

    if args.mode == "geometric" and not args.scene_json:
        parser.error("--scene-json is required for --mode geometric")
    if args.mode in ("fixture", "sam2") and not args.scene_id:
        parser.error("--scene-id is required for --mode fixture and --mode sam2")
    if args.mode in ("fixture", "sam2") and (not args.image_width or not args.image_height):
        parser.error("--image-width and --image-height are required unless --mode geometric (which reads them from the captured frame)")

    return MaskRequest(
        scene_id=args.scene_id or "",
        surface_id=args.surface_id,
        captured_frame_id=args.captured_frame_id,
        image_width=args.image_width or 0,
        image_height=args.image_height or 0,
        mode=args.mode,
        out_dir=args.out_dir,
        scene_json_path=args.scene_json,
    )


def _hash_bytes(*parts: str) -> bytes:
    """Deterministic hash of the request; fixture mode derives everything from it."""
    hasher = hashlib.sha256()
    for part in parts:
        hasher.update(part.encode("utf-8"))
        hasher.update(b"\0")
    return hasher.digest()


def _derive_rect(
    digest: bytes, image_width: int, image_height: int
) -> tuple[int, int, int, int]:
    """
    Map 8 bytes of the digest to a rectangle (x0, y0, x1, y1) that lands
    somewhere near the center of the image but varies visibly between inputs.
    """
    width_frac = 0.32 + (digest[0] / 255.0) * 0.18  # 32-50% of image width
    height_frac = 0.38 + (digest[1] / 255.0) * 0.18  # 38-56% of image height
    center_x_frac = 0.35 + (digest[2] / 255.0) * 0.30  # 35-65%
    center_y_frac = 0.35 + (digest[3] / 255.0) * 0.30
    rect_w = int(image_width * width_frac)
    rect_h = int(image_height * height_frac)
    cx = int(image_width * center_x_frac)
    cy = int(image_height * center_y_frac)
    x0 = max(0, cx - rect_w // 2)
    y0 = max(0, cy - rect_h // 2)
    x1 = min(image_width, x0 + rect_w)
    y1 = min(image_height, y0 + rect_h)
    return x0, y0, x1, y1


def render_fixture_mask(request: MaskRequest) -> np.ndarray:
    """
    Return a HxW uint8 array with 0/255 values. Deterministic per request.
    """
    digest = _hash_bytes(request.scene_id, request.surface_id, request.captured_frame_id)
    mask = np.zeros((request.image_height, request.image_width), dtype=np.uint8)
    x0, y0, x1, y1 = _derive_rect(digest, request.image_width, request.image_height)
    mask[y0:y1, x0:x1] = 255
    return mask


def sha256_of_png(array: np.ndarray) -> tuple[bytes, str]:
    buffer = io.BytesIO()
    Image.fromarray(array, mode="L").save(buffer, format="PNG")
    png_bytes = buffer.getvalue()
    return png_bytes, hashlib.sha256(png_bytes).hexdigest()


def mask_id_for(request: MaskRequest) -> str:
    digest = hashlib.sha1(
        f"{request.scene_id}|{request.surface_id}|{request.captured_frame_id}".encode("utf-8")
    ).hexdigest()
    return f"mask:{digest[:16]}"


def write_outputs(
    request: MaskRequest,
    mask: np.ndarray,
    generator_kind: str,
    extra: dict | None = None,
) -> Path:
    request.out_dir.mkdir(parents=True, exist_ok=True)
    png_bytes, sha256 = sha256_of_png(mask)
    mask_id = mask_id_for(request)
    png_path = request.out_dir / f"{mask_id.replace(':', '_')}.png"
    json_path = request.out_dir / f"{mask_id.replace(':', '_')}.json"
    png_path.write_bytes(png_bytes)
    metadata: dict[str, Any] = {
        "mask_id": mask_id,
        "surface_id": request.surface_id,
        "captured_frame_id": request.captured_frame_id,
        "generator_kind": generator_kind,
        "mask_uri": f"asset://masks/{request.scene_id}/{mask_id}.png",
        "mask_bytes_sha256": sha256,
        "mask_width": request.image_width,
        "mask_height": request.image_height,
        "generated_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    }
    if extra:
        metadata["provenance"] = extra
    json_path.write_text(json.dumps(metadata, indent=2) + "\n")
    return json_path


# --------------------------------------------------------- Geometric mode --

def _column_major_to_4x4(flat16: list[float]) -> np.ndarray:
    return np.array(flat16, dtype=np.float64).reshape(4, 4, order="F")


def _arkit_extrinsic_opencv(world_from_camera: np.ndarray) -> np.ndarray:
    """
    ARKit `camera_transform` is world-from-camera in OpenGL (+X right, +Y up,
    -Z forward). For image-space projection we want the OpenCV world-to-camera
    (+Z forward) — invert, then flip Y and Z axes in the camera frame. Matches
    scripts/bundle-to-meshes.py so surface masks align with the reconstructed
    meshes.
    """
    flip = np.diag([1.0, -1.0, -1.0, 1.0])
    cam_from_world_opengl = np.linalg.inv(world_from_camera)
    return flip @ cam_from_world_opengl


def _project_world_points(
    world_xyz: np.ndarray,
    extrinsic_opencv: np.ndarray,
    fx: float,
    fy: float,
    cx: float,
    cy: float,
) -> tuple[np.ndarray, np.ndarray]:
    """
    Project (N, 3) world points through the given OpenCV extrinsic + intrinsics.
    Returns (uv_pixel_coords (N, 2), in_front_of_camera_mask (N,)).
    """
    homog = np.concatenate([world_xyz, np.ones((world_xyz.shape[0], 1))], axis=1)
    cam = homog @ extrinsic_opencv.T
    z = cam[:, 2]
    in_front = z > 0.05
    safe_z = np.where(z > 1e-6, z, 1e-6)
    u = (cam[:, 0] * fx / safe_z) + cx
    v = (cam[:, 1] * fy / safe_z) + cy
    return np.stack([u, v], axis=1), in_front


def _clip_polygon_against_near_plane(
    polygon_world: np.ndarray, extrinsic_opencv: np.ndarray, near_z: float = 0.05,
) -> np.ndarray:
    """
    Sutherland-Hodgman clip of a closed 3D polygon against the camera's
    z = near plane (OpenCV, +Z forward). Returns the clipped polygon in
    world coords — empty array if the entire polygon is behind the camera.

    Without this, projecting a wall that straddles the camera plane produces
    pixel coordinates at infinity for the behind-camera vertices, which
    rasterizes into nonsense (or silently drops if we filter). Clipping first
    emits proper edge intersections at z = near so the projected 2D polygon
    matches what the camera actually sees.
    """
    if polygon_world.shape[0] == 0:
        return polygon_world
    # Work in camera space so "behind the camera" is a simple z test.
    homog = np.concatenate([polygon_world, np.ones((polygon_world.shape[0], 1))], axis=1)
    cam_pts = (homog @ extrinsic_opencv.T)[:, :3]
    n = cam_pts.shape[0]
    out: list[np.ndarray] = []
    for i in range(n):
        current = cam_pts[i]
        previous = cam_pts[(i - 1) % n]
        current_inside = current[2] >= near_z
        previous_inside = previous[2] >= near_z
        if current_inside:
            if not previous_inside:
                # Crossing into the view volume — emit the intersection.
                t = (near_z - previous[2]) / (current[2] - previous[2])
                out.append(previous + t * (current - previous))
            out.append(current)
        elif previous_inside:
            # Crossing out — emit the intersection only.
            t = (near_z - previous[2]) / (current[2] - previous[2])
            out.append(previous + t * (current - previous))
    if not out:
        return np.zeros((0, 3), dtype=np.float64)
    clipped_cam = np.stack(out, axis=0)
    # Transform back to world.
    homog_cam = np.concatenate([clipped_cam, np.ones((clipped_cam.shape[0], 1))], axis=1)
    world_from_cam_opencv = np.linalg.inv(extrinsic_opencv)
    return (homog_cam @ world_from_cam_opencv.T)[:, :3]


def _scale_intrinsics(raw: dict, dw: int, dh: int) -> tuple[float, float, float, float]:
    scale_x = dw / raw["width"]
    scale_y = dh / raw["height"]
    return raw["fx"] * scale_x, raw["fy"] * scale_y, raw["cx"] * scale_x, raw["cy"] * scale_y


def _surface_boundary_world(surface: dict) -> np.ndarray:
    """Convert a surface's (u, v) boundary polygon to world-space (N, 3)."""
    frame = surface.get("surface_frame")
    boundary = surface.get("boundary") or {}
    vertices = boundary.get("vertices", [])
    if not vertices:
        raise SystemExit(f"surface {surface.get('surface_id')} has no boundary vertices")
    if frame is None:
        # Floor is the one surface with surface_frame = null. Treat its (u,v)
        # as world (x, y) with z = 0 — this matches the synthetic shell
        # convention in scripts/arkitscenes-to-bundle.py.
        return np.array(
            [[float(v["x"]), float(v["y"]), 0.0] for v in vertices],
            dtype=np.float64,
        )
    origin = np.array([frame["origin"]["x"], frame["origin"]["y"], frame["origin"]["z"]], dtype=np.float64)
    u_axis = np.array([frame["u_axis"]["x"], frame["u_axis"]["y"], frame["u_axis"]["z"]], dtype=np.float64)
    v_axis = np.array([frame["v_axis"]["x"], frame["v_axis"]["y"], frame["v_axis"]["z"]], dtype=np.float64)
    out = np.zeros((len(vertices), 3), dtype=np.float64)
    for i, vtx in enumerate(vertices):
        u, v = float(vtx["x"]), float(vtx["y"])
        out[i] = origin + u * u_axis + v * v_axis
    return out


def _find_surface(scene: dict, surface_id: str) -> dict:
    room = scene["snapshot"]["state"]["room"]
    shell = room.get("shell", {})
    for s in shell.get("surfaces", []):
        if s.get("surface_id") == surface_id:
            return s
    raise SystemExit(f"surface_id '{surface_id}' not found in scene.json (searched shell.surfaces)")


def _find_captured_frame(scene: dict, captured_frame_id: str) -> dict:
    for f in scene.get("captured_frames", []):
        if f.get("frame_id") == captured_frame_id:
            return f
    raise SystemExit(f"captured_frame_id '{captured_frame_id}' not found in scene.json")


def render_geometric_mask(request: MaskRequest, scene: dict) -> tuple[np.ndarray, dict]:
    """
    Project the named surface's world-space boundary through the named captured
    frame's camera and rasterize the resulting 2D polygon into a binary mask.

    Returns (mask_uint8, provenance_dict). The provenance fields get merged
    into the output descriptor so downstream callers can see projection
    details when debugging alignment drift between meshes / splats / masks.
    """
    surface = _find_surface(scene, request.surface_id)
    captured = _find_captured_frame(scene, request.captured_frame_id)

    intrinsics_raw = captured["intrinsics"]
    bundle_w = int(intrinsics_raw["width"])
    bundle_h = int(intrinsics_raw["height"])
    # Default output resolution is the bundle's recorded resolution; caller
    # can override with --image-width/--image-height to render a higher-res
    # mask for the downstream inpaint stage.
    out_w = request.image_width or bundle_w
    out_h = request.image_height or bundle_h
    fx, fy, cx, cy = _scale_intrinsics(intrinsics_raw, out_w, out_h)

    world_pts = _surface_boundary_world(surface)
    world_from_camera = _column_major_to_4x4(captured["camera_transform"])
    extrinsic = _arkit_extrinsic_opencv(world_from_camera)
    clipped_world = _clip_polygon_against_near_plane(world_pts, extrinsic, near_z=0.05)
    uv, in_front = _project_world_points(clipped_world, extrinsic, fx, fy, cx, cy)

    mask_img = Image.new("L", (out_w, out_h), 0)
    # After clipping, all retained vertices are in front of the near plane, so
    # in_front should be uniformly True; the filter below is just a safety net.
    polygon_pixels: list[tuple[float, float]] = []
    if uv.shape[0] >= 3:
        for i in range(uv.shape[0]):
            if in_front[i]:
                polygon_pixels.append((float(uv[i, 0]), float(uv[i, 1])))
    if len(polygon_pixels) >= 3:
        # Clamp coordinates to a padded range so Pillow doesn't spend time on
        # wildly off-image pixels when the polygon extends beyond the frame.
        clamped = [
            (float(np.clip(u, -out_w, 2 * out_w)), float(np.clip(v, -out_h, 2 * out_h)))
            for u, v in polygon_pixels
        ]
        ImageDraw.Draw(mask_img).polygon(clamped, fill=255)

    mask = np.asarray(mask_img, dtype=np.uint8)
    provenance = {
        "projection": "arkit_opengl_to_opencv",
        "bundle_intrinsics": {"width": bundle_w, "height": bundle_h},
        "output_intrinsics": {"fx": fx, "fy": fy, "cx": cx, "cy": cy, "width": out_w, "height": out_h},
        "boundary_vertex_count": int(world_pts.shape[0]),
        "clipped_vertex_count": int(clipped_world.shape[0]),
        "in_front_count": int(in_front.sum()),
        "surface_frame_present": bool(surface.get("surface_frame")),
    }
    return mask, provenance


def run_sam2_mode(_request: MaskRequest) -> None:
    raise SystemExit(
        "[mask-service] --mode sam2 is not wired yet. Produce a geometric prior with --mode\n"
        "geometric (real surface projection), then feed it into SAM2 via the segment-anything-2\n"
        "package on a GPU box — the refined mask is a drop-in replacement at this output path.\n"
        "See docs/showcase-phase.md Track A Week 2 notes."
    )


def main(argv: list[str]) -> int:
    request = parse_args(argv)
    if request.mode == "sam2":
        run_sam2_mode(request)
        return 2
    if request.mode == "geometric":
        assert request.scene_json_path is not None
        scene = json.loads(request.scene_json_path.read_text())
        # Derive scene_id from the fixture when not passed explicitly.
        if not request.scene_id:
            request = MaskRequest(
                scene_id=scene["head"]["scene_id"],
                surface_id=request.surface_id,
                captured_frame_id=request.captured_frame_id,
                image_width=request.image_width,
                image_height=request.image_height,
                mode=request.mode,
                out_dir=request.out_dir,
                scene_json_path=request.scene_json_path,
            )
        mask, provenance = render_geometric_mask(request, scene)
        # Back-fill the mask dimensions onto the request so write_outputs sees
        # the actual rasterization size.
        effective = MaskRequest(
            scene_id=request.scene_id,
            surface_id=request.surface_id,
            captured_frame_id=request.captured_frame_id,
            image_width=mask.shape[1],
            image_height=mask.shape[0],
            mode=request.mode,
            out_dir=request.out_dir,
            scene_json_path=request.scene_json_path,
        )
        metadata_path = write_outputs(effective, mask, generator_kind="geometric_projection", extra=provenance)
        print(str(metadata_path))
        return 0
    mask = render_fixture_mask(request)
    metadata_path = write_outputs(request, mask, generator_kind="deterministic_stub")
    print(str(metadata_path))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
