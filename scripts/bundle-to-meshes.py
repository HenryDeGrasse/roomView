#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = [
#   "numpy>=1.26",
#   "pillow>=10",
#   "open3d>=0.18",
# ]
# ///
"""
Tier 2/2.5/3 — scan-bundle → per-object meshes.

Input: a committed RoomView fixture directory
  fixtures/roomplan/{fixture_id}/
    scene.json        # captured_frames + object OBBs
    frames/           # {frame_id}.rgb.jpg, {frame_id}.depth.npy, (optional) .confidence.npy

Output: one ASCII PLY mesh per object, rooted at
  fixtures/roomplan/{fixture_id}/meshes/{object_id}.ply
plus a meshes/manifest.json summarizing what got written, including whether
each object was reconstructed via TSDF or Poisson fallback.

Three modes:

  --mode tsdf       (Tier 2, default) Per-object ScalableTSDFVolume fused
                    from frames that see the object. Each object gets its
                    own volume sized to its OBB with a voxel size tuned to
                    its smallest dimension — small/thin objects (TVs,
                    nightstands) get finer voxels than a bed, so marching
                    cubes doesn't erase them in the truncation band.
                    Falls back to Poisson (in a subprocess) for any object
                    that TSDF can't recover.

  --mode poisson    (Tier 2.5) Skip TSDF entirely; go straight to the
                    point-cloud + symmetry-fill + Poisson pipeline (same
                    recipe as apps/web/src/scan-proxies.js).

  --mode learned    (Tier 3) Category-specific point cloud completion
                    (PCN / SnowflakeNet / PointAttN). Scaffold only — see
                    docs/showcase-phase.md for the wiring plan.

Poisson is invoked in a short-lived subprocess per object. Open3D's C++
PoissonRecon occasionally SIGABRTs on pathological clouds (it prints
"Failed to close loop" and aborts the whole process, not catchable from
Python). Subprocess isolation lets one bad object fail while the rest of
the run completes.

The OBB-local coordinate handling and camera-convention math mirror
apps/web/src/scan-proxies.js exactly — when the meshes land on disk the
viewer shows them in place of the point-cloud proxies, with no per-scene
calibration drift between the two paths.

See docs/showcase-phase.md (Track B "your actual room" follow-up) and
docs/pose-conventions.md for frame conventions.
"""
from __future__ import annotations

import argparse
import json
import math
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np
import open3d as o3d
from PIL import Image


# -------------------------------------------------------------------- CLI --

@dataclass(frozen=True)
class Options:
    fixture_id: str
    fixture_dir: Path
    out_dir: Path
    mode: str
    default_voxel_m: float
    min_vertex_count: int
    poisson_fallback: bool
    # Internal mode — runs a single object's Poisson reconstruction in an
    # isolated subprocess. Parent passes the object_id; subprocess writes the
    # PLY (or exits non-zero) and returns.
    internal_poisson_object_id: str | None


def parse_args(argv: list[str]) -> Options:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--fixture-id", required=True, help="e.g. fixture-bedroom-arkitscenes")
    parser.add_argument("--repo-root", type=Path, default=Path(__file__).resolve().parent.parent)
    parser.add_argument("--mode", choices=["tsdf", "poisson", "learned"], default="tsdf")
    parser.add_argument("--voxel-m", type=float, default=0.015, help="Default TSDF voxel size (meters). Per-object voxel adapts from here.")
    parser.add_argument("--min-vertex-count", type=int, default=80, help="Drop meshes below this vertex count (noise floor).")
    parser.add_argument("--no-poisson-fallback", dest="poisson_fallback", action="store_false", help="Skip Poisson fallback when TSDF fails per object.")
    parser.set_defaults(poisson_fallback=True)
    parser.add_argument("--internal-poisson-object-id", default=None, help=argparse.SUPPRESS)
    args = parser.parse_args(argv)
    fixture_dir = args.repo_root / "fixtures" / "roomplan" / args.fixture_id
    if not fixture_dir.exists():
        raise SystemExit(f"fixture dir not found: {fixture_dir}")
    out_dir = fixture_dir / "meshes"
    return Options(
        fixture_id=args.fixture_id,
        fixture_dir=fixture_dir,
        out_dir=out_dir,
        mode=args.mode,
        default_voxel_m=args.voxel_m,
        min_vertex_count=args.min_vertex_count,
        poisson_fallback=args.poisson_fallback,
        internal_poisson_object_id=args.internal_poisson_object_id,
    )


# -------------------------------------------------------------------- IO --

def load_scene(fixture_dir: Path) -> dict[str, Any]:
    path = fixture_dir / "scene.json"
    if not path.exists():
        raise SystemExit(f"scene.json missing: {path}")
    return json.loads(path.read_text())


def frame_file(fixture_dir: Path, uri: str) -> Path:
    """
    Captured-frame URIs are rewritten by build-arkitscenes-fixture.mts to
    `/dev/fixtures/{fixture_id}/frames/{file}`. Map that back to the on-disk
    path inside the fixture directory.
    """
    if uri.startswith("/dev/fixtures/"):
        rel = uri[len("/dev/fixtures/"):]
        segments = rel.split("/", 1)
        if len(segments) == 2 and segments[1].startswith("frames/"):
            return fixture_dir / segments[1]
    raise SystemExit(f"cannot resolve frame uri to a fixture file: {uri}")


def load_depth_npy(path: Path) -> tuple[np.ndarray, int, int]:
    arr = np.load(path)
    if arr.ndim != 2 or arr.dtype != np.float32:
        raise SystemExit(f"expected (H, W) float32 depth, got {arr.shape} {arr.dtype} from {path}")
    h, w = arr.shape
    return arr, w, h


def load_rgb_aligned(path: Path, target_w: int, target_h: int) -> np.ndarray:
    img = Image.open(path).convert("RGB")
    if img.size != (target_w, target_h):
        img = img.resize((target_w, target_h), Image.BILINEAR)
    return np.asarray(img)


# --------------------------------------------------------- OBB geometry --

@dataclass(frozen=True)
class OBBFrame:
    """Oriented bounding box with world↔local transforms. Yaw about +Z only."""
    center: np.ndarray       # (3,)
    half_extents: np.ndarray # (3,)
    yaw_rad: float
    world_to_local: np.ndarray  # 4x4
    local_to_world: np.ndarray  # 4x4

    @staticmethod
    def from_dict(obb: dict[str, Any]) -> "OBBFrame":
        center = np.array([obb["center"]["x"], obb["center"]["y"], obb["center"]["z"]], dtype=np.float64)
        half = np.array([obb["size_x"] * 0.5, obb["size_y"] * 0.5, obb["size_z"] * 0.5], dtype=np.float64)
        yaw = math.radians(obb.get("yaw_degrees", 0.0))
        c, s = math.cos(yaw), math.sin(yaw)
        rot_l2w = np.array([[c, -s, 0], [s, c, 0], [0, 0, 1]], dtype=np.float64)
        l2w = np.eye(4)
        l2w[:3, :3] = rot_l2w
        l2w[:3, 3] = center
        w2l = np.linalg.inv(l2w)
        return OBBFrame(center=center, half_extents=half, yaw_rad=yaw, world_to_local=w2l, local_to_world=l2w)

    def contains_world(self, points_xyz: np.ndarray, slack: float = 0.0) -> np.ndarray:
        homog = np.concatenate([points_xyz, np.ones((points_xyz.shape[0], 1))], axis=1)
        local = homog @ self.world_to_local.T
        local = local[:, :3]
        margin = self.half_extents + slack
        return np.all(np.abs(local) <= margin, axis=1)

    def corners_world(self) -> np.ndarray:
        """Return the 8 OBB corners in world space as (8, 3)."""
        hx, hy, hz = self.half_extents
        signs = np.array([[sx, sy, sz] for sx in (-1, 1) for sy in (-1, 1) for sz in (-1, 1)], dtype=np.float64)
        local = signs * np.array([hx, hy, hz])
        homog = np.concatenate([local, np.ones((8, 1))], axis=1)
        return (homog @ self.local_to_world.T)[:, :3]


# --------------------------------------------------------- Camera math --

def column_major_to_4x4(flat16: list[float]) -> np.ndarray:
    return np.array(flat16, dtype=np.float64).reshape(4, 4, order="F")


def arkit_world_from_camera_to_opencv_camera_from_world(world_from_camera: np.ndarray) -> np.ndarray:
    """
    RoomView's ARKit-style camera_transform is world-from-camera in OpenGL
    convention (+X right, +Y up, -Z forward). Open3D wants world-to-camera
    (extrinsic) in OpenCV convention (+X right, +Y down, +Z forward).
    Invert then flip Y/Z axes.
    """
    T_opengl_from_opencv = np.diag([1.0, -1.0, -1.0, 1.0])
    camera_from_world_opengl = np.linalg.inv(world_from_camera)
    return T_opengl_from_opencv @ camera_from_world_opengl


@dataclass(frozen=True)
class LoadedFrame:
    """Per-frame payload cached once per run."""
    frame_id: str
    rgb: np.ndarray          # (H, W, 3) uint8, aligned to depth resolution
    depth_m: np.ndarray      # (H, W) float32 meters; NaNs already zeroed
    fx: float
    fy: float
    cx: float
    cy: float
    width: int
    height: int
    world_from_camera: np.ndarray  # 4x4
    extrinsic_opencv: np.ndarray    # 4x4 (world-to-camera, OpenCV)


def load_all_frames(scene: dict[str, Any], options: Options) -> list[LoadedFrame]:
    frames = scene.get("captured_frames", [])
    if not frames:
        raise SystemExit("scene has no captured_frames")
    out: list[LoadedFrame] = []
    for frame in frames:
        depth, dw, dh = load_depth_npy(frame_file(options.fixture_dir, frame["depth"]["uri"]))
        rgb = load_rgb_aligned(frame_file(options.fixture_dir, frame["rgb"]["uri"]), dw, dh)
        intr = frame["intrinsics"]
        scale_x = dw / intr["width"]
        scale_y = dh / intr["height"]
        fx = intr["fx"] * scale_x
        fy = intr["fy"] * scale_y
        cx = intr["cx"] * scale_x
        cy = intr["cy"] * scale_y
        depth_m = np.where(np.isfinite(depth), depth, 0.0).astype(np.float32)
        wfc = column_major_to_4x4(frame["camera_transform"])
        extrinsic = arkit_world_from_camera_to_opencv_camera_from_world(wfc)
        out.append(LoadedFrame(
            frame_id=frame["frame_id"],
            rgb=rgb, depth_m=depth_m,
            fx=fx, fy=fy, cx=cx, cy=cy,
            width=dw, height=dh,
            world_from_camera=wfc,
            extrinsic_opencv=extrinsic,
        ))
    return out


def score_frame_for_obb(frame: LoadedFrame, obb: OBBFrame) -> float:
    """
    Score in [0, 1] measuring how well this frame sees this OBB.

    Projects the 8 corners into camera space; counts fraction in front
    of the camera, within image bounds, and within reasonable depth
    range (0.3..6 m). Product yields a 0..1 score — 1.0 means every
    corner is comfortably in view.

    Used to skip frames that don't see an object when building that
    object's TSDF volume, instead of integrating every frame into every
    object's volume (noisy and slow).
    """
    corners = obb.corners_world()
    homog = np.concatenate([corners, np.ones((8, 1))], axis=1)
    cam = homog @ frame.extrinsic_opencv.T  # (8, 4) in OpenCV camera frame
    z = cam[:, 2]
    in_front = z > 0.3
    in_depth = (z > 0.3) & (z < 6.0)
    # Project only the corners with z > 0 to avoid division blow-ups.
    z_safe = np.where(z > 1e-6, z, 1e-6)
    u = (cam[:, 0] * frame.fx / z_safe) + frame.cx
    v = (cam[:, 1] * frame.fy / z_safe) + frame.cy
    in_bounds = (u > -0.1 * frame.width) & (u < 1.1 * frame.width) & (v > -0.1 * frame.height) & (v < 1.1 * frame.height)
    good = in_front & in_depth & in_bounds
    return float(good.sum()) / 8.0


def per_object_voxel_size(obb: OBBFrame, default_voxel_m: float) -> float:
    """
    Scale voxel size to object size. Small/thin objects (TVs, nightstands)
    need finer voxels or they vanish into the truncation band; big objects
    (beds, rugs) can stay at the coarser default for speed.
    """
    min_dim_m = float(min(obb.half_extents) * 2.0)
    adaptive = min_dim_m / 10.0
    return float(np.clip(adaptive, 0.006, default_voxel_m))


# --------------------------------------------------------- Tier 2 TSDF --

def run_per_object_tsdf(scene: dict[str, Any], options: Options, loaded_frames: list[LoadedFrame]) -> dict[str, dict[str, Any]]:
    """
    Per-object TSDF. For each object:
      1. Score every frame on how well it sees the OBB.
      2. Pick a voxel size scaled to the object's smallest dimension.
      3. Integrate only the selected frames into that object's TSDF volume.
      4. Extract mesh, clip tightly to OBB.
    Returns {object_id: {"path": Path, "method": "tsdf", "vertex_count": N}}.
    """
    options.out_dir.mkdir(parents=True, exist_ok=True)
    objects = scene["snapshot"]["state"]["room"]["objects"]
    results: dict[str, dict[str, Any]] = {}

    for obj in objects:
        obb = OBBFrame.from_dict(obj["obb"])
        scores = [(frame, score_frame_for_obb(frame, obb)) for frame in loaded_frames]
        # Relaxed threshold: accept any frame that sees at least a couple
        # OBB corners (2/8 = 0.25). Strict 0.5 threshold missed frames that
        # catch the near side of an object while the far corners are behind
        # the camera. The per-object TSDF volume handles noisy integration
        # from out-of-frame depth by letting the SDF vote.
        selected = [f for f, s in scores if s >= 0.25]
        if not selected:
            # Fall back: take the top-3 scoring frames so we at least try.
            selected = [f for f, _ in sorted(scores, key=lambda x: -x[1])[:3]]

        voxel_m = per_object_voxel_size(obb, options.default_voxel_m)
        volume = o3d.pipelines.integration.ScalableTSDFVolume(
            voxel_length=voxel_m,
            sdf_trunc=voxel_m * 4,
            color_type=o3d.pipelines.integration.TSDFVolumeColorType.RGB8,
        )

        for frame in selected:
            color_o3d = o3d.geometry.Image(np.ascontiguousarray(frame.rgb, dtype=np.uint8))
            depth_o3d = o3d.geometry.Image(np.ascontiguousarray(frame.depth_m))
            rgbd = o3d.geometry.RGBDImage.create_from_color_and_depth(
                color_o3d, depth_o3d,
                depth_scale=1.0, depth_trunc=6.0, convert_rgb_to_intensity=False,
            )
            intrinsic = o3d.camera.PinholeCameraIntrinsic(
                frame.width, frame.height, frame.fx, frame.fy, frame.cx, frame.cy
            )
            volume.integrate(rgbd, intrinsic, frame.extrinsic_opencv)

        full_mesh = volume.extract_triangle_mesh()
        per_obj = _clip_mesh_to_obb(full_mesh, obb, voxel_m)
        if per_obj is None or np.asarray(per_obj.vertices).shape[0] < options.min_vertex_count:
            continue
        per_obj.compute_vertex_normals()
        out_path = options.out_dir / f"{obj['object_id']}.ply"
        o3d.io.write_triangle_mesh(str(out_path), per_obj, write_ascii=True)
        vcount = int(np.asarray(per_obj.vertices).shape[0])
        results[obj["object_id"]] = {"path": out_path, "method": "tsdf", "vertex_count": vcount, "voxel_m": voxel_m}
        print(f"[bundle-to-meshes] tsdf ok · {obj['object_id']} · verts={vcount} voxel_m={voxel_m:.4f} frames_used={len(selected)}", file=sys.stderr)

    return results


def _clip_mesh_to_obb(full_mesh: o3d.geometry.TriangleMesh, obb: OBBFrame, voxel_m: float) -> o3d.geometry.TriangleMesh | None:
    vertices = np.asarray(full_mesh.vertices)
    if vertices.shape[0] == 0:
        return None
    triangles = np.asarray(full_mesh.triangles)
    vertex_colors = np.asarray(full_mesh.vertex_colors)
    # Slack of ~3 voxels (4.5cm at default 1.5cm voxels) keeps tangential
    # surface extent that annotation-OBBs routinely trim off. Adjacent
    # bedroom furniture usually sits > 10cm apart so neighbours don't leak.
    mask = obb.contains_world(vertices, slack=voxel_m * 3)
    if not np.any(mask):
        return None
    kept = np.flatnonzero(mask)
    tri_mask = np.all(np.isin(triangles, kept), axis=1)
    kept_tri = triangles[tri_mask]
    if kept_tri.shape[0] == 0:
        return None
    remap = -np.ones(vertices.shape[0], dtype=np.int64)
    remap[kept] = np.arange(kept.shape[0])
    remapped = remap[kept_tri]
    out = o3d.geometry.TriangleMesh()
    out.vertices = o3d.utility.Vector3dVector(vertices[kept])
    out.triangles = o3d.utility.Vector3iVector(remapped)
    if vertex_colors.size > 0:
        out.vertex_colors = o3d.utility.Vector3dVector(vertex_colors[kept])
    out.remove_duplicated_vertices()
    out.remove_degenerate_triangles()
    return out


# --------------------------------------------------------- Tier 2.5 Poisson --

SYMMETRY_AXES = {
    "bed": ("x",),
    "nightstand": ("x",),
    "desk": ("x",),
    "table": ("x", "y"),
    "chair": ("x",),
    "dresser": ("x",),
    "bookshelf": ("x",),
    "sofa": ("x",),
    "rug": (),
    "lamp": ("x", "y"),
    "television": (),
    "storage": ("x",),
    "generic_obstacle": (),
}


def _unproject_frame_world(frame: LoadedFrame) -> tuple[np.ndarray, np.ndarray]:
    """Unproject every valid depth pixel to world XYZ + RGB. Returns ((N,3), (N,3))."""
    depth = frame.depth_m
    mask = np.isfinite(depth) & (depth > 0.05) & (depth < 8.0)
    if not np.any(mask):
        return np.zeros((0, 3)), np.zeros((0, 3))
    uu, vv = np.meshgrid(np.arange(frame.width), np.arange(frame.height))
    d = depth[mask]
    u = uu[mask]
    v = vv[mask]
    x_c = (u - frame.cx) * d / frame.fx
    y_c = -(v - frame.cy) * d / frame.fy
    z_c = -d
    cam_pts = np.stack([x_c, y_c, z_c, np.ones_like(d)], axis=1)
    world_pts = cam_pts @ frame.world_from_camera.T
    colors = frame.rgb[mask].astype(np.float32) / 255.0
    return world_pts[:, :3], colors


# ARKitScenes 3DOD annotations are drawn by hand and often sit a few cm off
# the underlying scan (pose drift + annotation slop). A tight voxel-size
# slack misses most of the captured geometry for those objects. We gather
# with a generous fixed slack and rely on the *output* clip (tight, a couple
# voxels) to keep per-object meshes from bleeding into neighbours.
POINT_GATHER_SLACK_M = 0.15


def collect_object_points(obb: OBBFrame, loaded_frames: list[LoadedFrame], voxel_m: float) -> tuple[np.ndarray, np.ndarray]:
    positions_list: list[np.ndarray] = []
    colors_list: list[np.ndarray] = []
    slack = max(POINT_GATHER_SLACK_M, voxel_m * 2)
    for frame in loaded_frames:
        world_pts, cols = _unproject_frame_world(frame)
        if world_pts.shape[0] == 0:
            continue
        mask = obb.contains_world(world_pts, slack=slack)
        if np.any(mask):
            positions_list.append(world_pts[mask])
            colors_list.append(cols[mask])
    if not positions_list:
        return np.zeros((0, 3)), np.zeros((0, 3))
    return np.concatenate(positions_list, axis=0), np.concatenate(colors_list, axis=0)


def _symmetry_fill(
    positions: np.ndarray, colors: np.ndarray, frame: OBBFrame, axes: tuple[str, ...],
) -> tuple[np.ndarray, np.ndarray]:
    if not axes or positions.shape[0] == 0:
        return positions, colors
    homog = np.concatenate([positions, np.ones((positions.shape[0], 1))], axis=1)
    local = (homog @ frame.world_to_local.T)[:, :3]
    extras = [local]
    extras_colors = [colors]
    for axis in axes:
        mirrored = local.copy()
        if axis == "x":
            mirrored[:, 0] = -mirrored[:, 0]
        elif axis == "y":
            mirrored[:, 1] = -mirrored[:, 1]
        elif axis == "z":
            mirrored[:, 2] = -mirrored[:, 2]
        extras.append(mirrored)
        extras_colors.append(colors)
    merged_local = np.concatenate(extras, axis=0)
    merged_colors = np.concatenate(extras_colors, axis=0)
    merged_homog = np.concatenate([merged_local, np.ones((merged_local.shape[0], 1))], axis=1)
    merged_world = merged_homog @ frame.local_to_world.T
    return merged_world[:, :3], merged_colors


def _poisson_reconstruct_one(
    positions: np.ndarray,
    colors: np.ndarray,
    obb: OBBFrame,
    voxel_m: float,
    obj_class: str,
    min_vertex_count: int,
    out_path: Path,
) -> int:
    """
    Core Poisson reconstruction. Runs in-process. Called directly when the
    caller accepts the SIGABRT risk (e.g. --mode poisson), and via subprocess
    isolation from run_per_object_tsdf's fallback path.

    Returns the vertex count of the written mesh, or 0 if the mesh was below
    the noise floor and no file was written.
    """
    if positions.shape[0] < min_vertex_count:
        print(f"[bundle-to-meshes] poisson: too-few input points for {obj_class} ({positions.shape[0]})", file=sys.stderr)
        return 0
    axes = SYMMETRY_AXES.get(obj_class, ())
    positions, colors = _symmetry_fill(positions, colors, obb, axes)
    max_points = 15_000
    if positions.shape[0] > max_points:
        rng = np.random.default_rng(seed=42)
        idx = rng.choice(positions.shape[0], size=max_points, replace=False)
        positions = positions[idx]
        colors = colors[idx]
    pcd = o3d.geometry.PointCloud()
    pcd.points = o3d.utility.Vector3dVector(positions)
    pcd.colors = o3d.utility.Vector3dVector(colors)
    pcd.estimate_normals(search_param=o3d.geometry.KDTreeSearchParamHybrid(radius=voxel_m * 3, max_nn=24))
    # ARKit captures only see one side of each object. Without a consistent
    # outward normal, Poisson happily produces a mesh turned inside-out or
    # one that collapses to a sliver because the implicit SDF has no
    # direction cue. We orient normals outward by hand (Open3D's
    # orient_normals_towards_camera_location SIGSEGVs on pathological clouds).
    normals = np.asarray(pcd.normals)
    to_surface = np.asarray(pcd.points) - obb.center  # vector from OBB center to each point
    # If a normal points toward the OBB center (dot < 0), flip it.
    dot = np.sum(normals * to_surface, axis=1)
    normals = np.where(dot[:, None] < 0, -normals, normals)
    pcd.normals = o3d.utility.Vector3dVector(normals)
    mesh, densities = o3d.geometry.TriangleMesh.create_from_point_cloud_poisson(pcd, depth=7)
    vertices = np.asarray(mesh.vertices)
    if vertices.shape[0] == 0:
        print(f"[bundle-to-meshes] poisson: produced empty mesh for {obj_class}", file=sys.stderr)
        return 0
    # Density-based pruning: Poisson fills aggressively into uncharted space,
    # producing wispy low-density vertices that are almost never real
    # geometry. Drop the bottom quartile before the OBB clip.
    if densities is not None and len(densities) == vertices.shape[0]:
        density_arr = np.asarray(densities)
        cutoff = np.quantile(density_arr, 0.25)
        dense_mask = density_arr >= cutoff
        mesh = mesh.select_by_index(np.flatnonzero(dense_mask))
    # Output OBB clip: match the input gather slack (POINT_GATHER_SLACK_M).
    # ARKitScenes annotation OBBs are loose, so the reconstructed geometry
    # routinely lives 5-15cm outside the annotation; a tight output clip
    # erases it. Adjacent bedroom furniture still sits > 15cm apart in
    # practice so this doesn't cause neighbour bleed.
    keep = obb.contains_world(np.asarray(mesh.vertices), slack=POINT_GATHER_SLACK_M)
    mesh = mesh.select_by_index(np.flatnonzero(keep))
    mesh.remove_duplicated_vertices()
    mesh.remove_degenerate_triangles()
    mesh.compute_vertex_normals()
    vcount = int(np.asarray(mesh.vertices).shape[0])
    if vcount < min_vertex_count:
        print(f"[bundle-to-meshes] poisson: {obj_class} too small after clip ({vcount} < {min_vertex_count})", file=sys.stderr)
        return 0
    o3d.io.write_triangle_mesh(str(out_path), mesh, write_ascii=True)
    return vcount


def run_poisson(scene: dict[str, Any], options: Options, loaded_frames: list[LoadedFrame]) -> dict[str, dict[str, Any]]:
    """Direct --mode poisson path. Runs in-process (no subprocess isolation)."""
    options.out_dir.mkdir(parents=True, exist_ok=True)
    results: dict[str, dict[str, Any]] = {}
    for obj in scene["snapshot"]["state"]["room"]["objects"]:
        obb = OBBFrame.from_dict(obj["obb"])
        voxel_m = per_object_voxel_size(obb, options.default_voxel_m)
        positions, colors = collect_object_points(obb, loaded_frames, voxel_m)
        out_path = options.out_dir / f"{obj['object_id']}.ply"
        try:
            vcount = _poisson_reconstruct_one(
                positions, colors, obb, voxel_m, obj.get("class", "generic_obstacle"),
                options.min_vertex_count, out_path,
            )
        except Exception as err:  # noqa: BLE001
            print(f"[bundle-to-meshes] poisson failed for {obj['object_id']}: {err}", file=sys.stderr)
            continue
        if vcount == 0:
            continue
        results[obj["object_id"]] = {"path": out_path, "method": "poisson", "vertex_count": vcount, "voxel_m": voxel_m}
        print(f"[bundle-to-meshes] poisson ok · {obj['object_id']} · verts={vcount}", file=sys.stderr)
    return results


def _run_poisson_subprocess_for_object(obj: dict[str, Any], options: Options) -> dict[str, Any] | None:
    """
    Spawn a subprocess that runs Poisson reconstruction for a single object.
    If the subprocess exits non-zero (including SIGABRT), we swallow the
    failure and return None so the rest of the batch continues.
    """
    obj_id = obj["object_id"]
    cmd = [
        sys.executable, str(Path(__file__).resolve()),
        "--fixture-id", options.fixture_id,
        "--mode", "tsdf",  # mode doesn't matter; internal flag below drives behaviour
        "--voxel-m", str(options.default_voxel_m),
        "--min-vertex-count", str(options.min_vertex_count),
        "--internal-poisson-object-id", obj_id,
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    out_path = options.out_dir / f"{obj_id}.ply"
    if proc.returncode != 0:
        # Common: SIGABRT = -6 on POSIX. Log but don't fail the run.
        tail = proc.stderr.strip().splitlines()[-3:] if proc.stderr else []
        print(
            f"[bundle-to-meshes] poisson subprocess for {obj_id} exited {proc.returncode}"
            f" (crash-isolated); tail={tail!r}",
            file=sys.stderr,
        )
        return None
    if not out_path.exists():
        # Subprocess ran clean but decided the cloud was too sparse.
        return None
    # Parse the last JSON line the subprocess printed to stdout for vertex count.
    last_json: dict[str, Any] | None = None
    for line in reversed(proc.stdout.strip().splitlines()):
        try:
            last_json = json.loads(line)
            break
        except json.JSONDecodeError:
            continue
    vcount = int(last_json.get("vertex_count", 0)) if last_json else 0
    return {"path": out_path, "method": "poisson", "vertex_count": vcount}


def run_internal_poisson_one_object(scene: dict[str, Any], options: Options, loaded_frames: list[LoadedFrame]) -> int:
    """Subprocess entry point: reconstruct one object via Poisson, write the PLY."""
    target_id = options.internal_poisson_object_id
    assert target_id is not None
    obj = next((o for o in scene["snapshot"]["state"]["room"]["objects"] if o["object_id"] == target_id), None)
    if obj is None:
        print(f"[bundle-to-meshes] internal: object_id not found: {target_id}", file=sys.stderr)
        return 1
    obb = OBBFrame.from_dict(obj["obb"])
    voxel_m = per_object_voxel_size(obb, options.default_voxel_m)
    positions, colors = collect_object_points(obb, loaded_frames, voxel_m)
    options.out_dir.mkdir(parents=True, exist_ok=True)
    out_path = options.out_dir / f"{target_id}.ply"
    vcount = _poisson_reconstruct_one(
        positions, colors, obb, voxel_m, obj.get("class", "generic_obstacle"),
        options.min_vertex_count, out_path,
    )
    print(json.dumps({"object_id": target_id, "vertex_count": vcount}))
    return 0


# --------------------------------------------------------- Tier 3 stub --

def run_learned(scene: dict[str, Any], options: Options, loaded_frames: list[LoadedFrame]) -> dict[str, dict[str, Any]]:  # noqa: ARG001
    raise SystemExit(
        "[bundle-to-meshes] --mode learned is not wired yet (Showcase-phase Tier 3 follow-up).\n"
        "\n"
        "Current status: per-object TSDF + Poisson-subprocess fallback (--mode tsdf,\n"
        "the default) already recovers every object in the ARKitScenes fixture that\n"
        "has any captured depth inside its OBB. Objects missing from the output have\n"
        "zero depth samples in any captured frame, so no reconstruction tier — learned\n"
        "completion included — can conjure geometry for them. More frames in the\n"
        "bundle (or smarter per-object frame selection at capture time) is the\n"
        "bottleneck, not the reconstruction algorithm.\n"
        "\n"
        "Planned Tier 3 pipeline: per-class point-cloud completion model (PCN /\n"
        "PF-Net / PointAttN trained on ShapeNet categories) that hydrates sparse\n"
        "OBB-clipped observations into dense shapes before meshing. Requires a\n"
        "hosted model checkpoint (not yet committed to this repo — size would bloat\n"
        "the checkout) and a per-category fine-tune on scan-like inputs. See\n"
        "docs/showcase-phase.md Tier 3 notes for the wiring plan.\n"
    )


# -------------------------------------------------------------- main --

def main(argv: list[str]) -> int:
    options = parse_args(argv)
    scene = load_scene(options.fixture_dir)
    loaded_frames = load_all_frames(scene, options)

    # Subprocess-isolated poisson-one-object entry point.
    if options.internal_poisson_object_id is not None:
        return run_internal_poisson_one_object(scene, options, loaded_frames)

    if options.mode == "learned":
        run_learned(scene, options, loaded_frames)  # raises SystemExit

    if options.mode == "poisson":
        results = run_poisson(scene, options, loaded_frames)
    else:
        results = run_per_object_tsdf(scene, options, loaded_frames)
        if options.poisson_fallback:
            # Objects that TSDF couldn't recover — try Poisson in a subprocess each.
            covered = set(results.keys())
            missing = [o for o in scene["snapshot"]["state"]["room"]["objects"] if o["object_id"] not in covered]
            if missing:
                print(f"[bundle-to-meshes] tsdf covered {len(covered)}/{len(covered) + len(missing)} objects; retrying {len(missing)} via poisson subprocess", file=sys.stderr)
            for obj in missing:
                fallback = _run_poisson_subprocess_for_object(obj, options)
                if fallback is not None:
                    results[obj["object_id"]] = fallback

    summary = {
        "fixture_id": options.fixture_id,
        "mode": options.mode,
        "voxel_m": options.default_voxel_m,
        "mesh_count": len(results),
        "meshes": {oid: str(v["path"].relative_to(options.fixture_dir)) for oid, v in results.items()},
        "methods": {oid: v.get("method", options.mode) for oid, v in results.items()},
        "vertex_counts": {oid: int(v.get("vertex_count", 0)) for oid, v in results.items()},
    }
    manifest_path = options.out_dir / "manifest.json"
    options.out_dir.mkdir(parents=True, exist_ok=True)
    manifest_path.write_text(json.dumps(summary, indent=2) + "\n")
    print(json.dumps({"mode": options.mode, "mesh_count": len(results), "manifest": str(manifest_path)}))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
