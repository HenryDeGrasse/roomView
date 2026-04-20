#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""
Convert a RoomView fixture (scene.json + frames/) into a nerfstudio-format
dataset that `brush_app` can train on.

Fixture convention (post-89bb4e1 iOS builds):
  - scene.captured_frames[i].camera_transform is a column-major 16-float
    4x4 world_from_camera. World is canonical (Z-up, positive octant);
    camera is OpenCV (+X right, +Y down, +Z forward).

Nerfstudio transforms.json convention:
  - transform_matrix per frame is world_from_camera in OpenGL camera
    convention (+X right, +Y up, -Z forward). We convert by multiplying
    each pose on the right by diag(1, -1, -1, 1).

Writes:
  {out_dir}/transforms.json
  {out_dir}/images/{frame_id}.jpg    (symlinks to original RGB files — no copy)

Usage:
  uv run scripts/fixture-to-brush-dataset.py \
      --fixture-id capture-bedroom110-4-20260420-005336 \
      --out-dir fixtures/roomplan/capture-bedroom110-4-20260420-005336/brush-dataset
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path


# OpenCV → OpenGL camera-frame flip: right-multiply by diag(1, -1, -1, 1).
# Equivalent to negating the 2nd and 3rd columns of the pose matrix.
_FLIP_YZ = [
    [1.0, 0.0, 0.0, 0.0],
    [0.0, -1.0, 0.0, 0.0],
    [0.0, 0.0, -1.0, 0.0],
    [0.0, 0.0, 0.0, 1.0],
]


def _mat_mul_4x4(a: list[list[float]], b: list[list[float]]) -> list[list[float]]:
    out = [[0.0] * 4 for _ in range(4)]
    for i in range(4):
        for j in range(4):
            s = 0.0
            for k in range(4):
                s += a[i][k] * b[k][j]
            out[i][j] = s
    return out


def _column_major_flat_to_matrix(flat: list[float]) -> list[list[float]]:
    # scene.captured_frames[i].camera_transform is column-major, 16 floats.
    # rows[i][j] = flat[j*4 + i]
    rows = [[0.0] * 4 for _ in range(4)]
    for j in range(4):
        for i in range(4):
            rows[i][j] = float(flat[j * 4 + i])
    return rows


def _opencv_to_opengl(pose_opencv: list[list[float]]) -> list[list[float]]:
    return _mat_mul_4x4(pose_opencv, _FLIP_YZ)


def convert(fixture_dir: Path, out_dir: Path, limit: int | None = None) -> dict:
    scene = json.loads((fixture_dir / "scene.json").read_text())
    frames = scene.get("captured_frames", [])
    if not frames:
        raise SystemExit("no captured_frames in scene.json")

    out_dir.mkdir(parents=True, exist_ok=True)
    images_dir = out_dir / "images"
    images_dir.mkdir(exist_ok=True)

    # Intrinsics — use the first frame's values. ARKit captures keep
    # intrinsics stable across a single session so this is safe.
    intr0 = frames[0]["intrinsics"]
    out_manifest: dict = {
        "camera_model": "OPENCV",
        "fl_x": float(intr0["fx"]),
        "fl_y": float(intr0["fy"]),
        "cx": float(intr0["cx"]),
        "cy": float(intr0["cy"]),
        "w": int(intr0["width"]),
        "h": int(intr0["height"]),
        "k1": 0.0, "k2": 0.0, "p1": 0.0, "p2": 0.0,
        "frames": [],
    }

    kept = 0
    skipped = 0
    for i, frame in enumerate(frames):
        if limit is not None and kept >= limit:
            break
        frame_id = frame["frame_id"]
        rgb_uri = frame["rgb"]["uri"]
        # Resolve /dev/fixtures/<id>/frames/... → fixture_dir/frames/...
        if not rgb_uri.startswith("/dev/fixtures/"):
            skipped += 1
            continue
        rel = rgb_uri[len("/dev/fixtures/"):]
        segs = rel.split("/", 1)
        if len(segs) != 2 or not segs[1].startswith("frames/"):
            skipped += 1
            continue
        source_rgb = fixture_dir / segs[1]
        if not source_rgb.exists():
            skipped += 1
            continue
        # Symlink source → dataset/images/<frame_id>.jpg so we don't duplicate data.
        dest_rgb = images_dir / f"{frame_id}.jpg"
        if dest_rgb.is_symlink() or dest_rgb.exists():
            dest_rgb.unlink()
        os.symlink(os.path.relpath(source_rgb, images_dir), dest_rgb)

        pose_opencv = _column_major_flat_to_matrix(frame["camera_transform"])
        pose_opengl = _opencv_to_opengl(pose_opencv)
        out_manifest["frames"].append({
            "file_path": f"images/{frame_id}.jpg",
            "transform_matrix": pose_opengl,
        })
        kept += 1

    (out_dir / "transforms.json").write_text(json.dumps(out_manifest, indent=2) + "\n")
    return {
        "kept": kept,
        "skipped": skipped,
        "intrinsics": {
            "fx": out_manifest["fl_x"],
            "fy": out_manifest["fl_y"],
            "cx": out_manifest["cx"],
            "cy": out_manifest["cy"],
            "w": out_manifest["w"],
            "h": out_manifest["h"],
        },
        "out_dir": str(out_dir),
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--fixture-id", required=True)
    parser.add_argument("--repo-root", type=Path, default=Path.cwd())
    parser.add_argument("--out-dir", type=Path, default=None,
                        help="Defaults to fixtures/roomplan/<id>/brush-dataset")
    parser.add_argument("--limit", type=int, default=None,
                        help="Only convert first N frames (for sanity tests).")
    args = parser.parse_args()

    fixture_dir = (args.repo_root / "fixtures" / "roomplan" / args.fixture_id).resolve()
    if not fixture_dir.exists():
        raise SystemExit(f"fixture dir not found: {fixture_dir}")
    out_dir = (args.out_dir if args.out_dir else fixture_dir / "brush-dataset").resolve()

    stats = convert(fixture_dir, out_dir, limit=args.limit)
    print(json.dumps(stats, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
