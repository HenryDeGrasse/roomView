#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""
Tier "HQ splat" — train a higher-quality gaussian splat on a fixture with
Brush (Rust + WebGPU, Mac Metal compatible). Runs AFTER the fast
RGBD-init splat + TSDF meshes have already landed, so the room is
viewable the entire time.

Pipeline:
  1. Build a nerfstudio-format dataset under <fixture>/brush-dataset/
     by calling scripts/fixture-to-brush-dataset.py.
  2. Invoke `tools/brush/brush-app-.../brush_app` with the dataset,
     writing PLY exports to <fixture>/splats/brush-train/.
  3. Rename the final export to splat_brush_<hash>.ply + write a sibling
     .json descriptor following the same conventions as
     scripts/splat-generate.py.
  4. Patch <fixture>/scene.json so scene.splat points at the new PLY
     (viewer loads .ply via sceneFormatFromPath).

Idempotent: re-running re-trains from scratch, overwriting the previous
brush-train outputs. The fast RGBD-init splat stays untouched alongside.

Failure recovery: if the Brush binary is missing, errors, or times out,
this script exits non-zero and the caller (capture-pipeline runner) logs
the failure. The existing scene.splat (fast RGBD init) is never modified
on failure, so the viewer falls back seamlessly.

Usage:
    uv run scripts/brush-train.py \\
        --fixture-id capture-bedroom110-4-20260420-005336 \\
        --total-steps 30000 \\
        --max-resolution 960
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path


def _find_brush_binary(repo_root: Path) -> Path:
    candidates = [
        repo_root / "tools/brush/brush-app-aarch64-apple-darwin/brush_app",
        repo_root / "tools/brush/brush_app",
    ]
    for path in candidates:
        if path.exists() and os.access(path, os.X_OK):
            return path
    raise SystemExit(
        "brush_app binary not found. Download from "
        "https://github.com/ArthurBrussee/brush/releases and extract to "
        "tools/brush/ inside the repo."
    )


def _run_converter(repo_root: Path, fixture_id: str) -> Path:
    """Call fixture-to-brush-dataset.py to produce brush-dataset/."""
    script = repo_root / "scripts/fixture-to-brush-dataset.py"
    fixture_dir = repo_root / "fixtures/roomplan" / fixture_id
    out_dir = fixture_dir / "brush-dataset"
    cmd = [
        "uv", "run", str(script),
        "--fixture-id", fixture_id,
        "--repo-root", str(repo_root),
        "--out-dir", str(out_dir),
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        raise SystemExit(f"fixture-to-brush-dataset failed:\n{result.stderr}")
    return out_dir


def _run_brush(
    brush_bin: Path, dataset_dir: Path, out_dir: Path,
    total_steps: int, max_resolution: int,
) -> Path:
    """Run Brush training. Returns the final export PLY path."""
    out_dir.mkdir(parents=True, exist_ok=True)
    export_name = f"splat_brush_{total_steps:04d}.ply"
    cmd = [
        str(brush_bin), str(dataset_dir),
        "--total-steps", str(total_steps),
        "--max-resolution", str(max_resolution),
        # Export once at the end — intermediate exports cost I/O and we
        # only serve the final result to the viewer.
        "--export-every", str(total_steps),
        "--export-path", str(out_dir),
        "--export-name", f"splat_brush_{{iter}}.ply",
    ]
    # Stream logs to stdout so the capture-pipeline runner's on_log can
    # surface them in the API observability stream.
    env = os.environ.copy()
    result = subprocess.run(cmd, env=env)
    if result.returncode != 0:
        raise SystemExit(f"brush_app exited with code {result.returncode}")
    final = out_dir / export_name
    if not final.exists():
        # Brush may have padded iter differently; find the largest one.
        candidates = sorted(out_dir.glob("splat_brush_*.ply"))
        if not candidates:
            raise SystemExit(f"no splat_brush_*.ply under {out_dir}")
        final = candidates[-1]
    return final


def _write_descriptor(ply_path: Path, fixture_id: str, total_steps: int) -> dict:
    """Mirror the descriptor format splat-generate.py emits alongside .splat."""
    size_bytes = ply_path.stat().st_size
    sha = hashlib.sha256(ply_path.read_bytes()).hexdigest()
    splat_id = f"splat:brush-{sha[:16]}"
    rel_uri = f"/dev/fixtures/{fixture_id}/splats/brush-train/{ply_path.name}"
    descriptor = {
        "splat_id": splat_id,
        "capture_id": fixture_id,
        "generator_kind": "brush",
        "ply_uri": rel_uri,
        "ply_bytes_sha256": sha,
        "ply_bytes": size_bytes,
        "total_steps": total_steps,
        "generated_at": datetime.now(timezone.utc).isoformat(),
    }
    descriptor_path = ply_path.with_suffix(".json")
    descriptor_path.write_text(json.dumps(descriptor, indent=2) + "\n")
    return descriptor


def _patch_scene(fixture_dir: Path, descriptor: dict) -> None:
    """Point scene.splat at the new PLY so the viewer loads the HQ one."""
    scene_path = fixture_dir / "scene.json"
    scene = json.loads(scene_path.read_text())
    splat = scene.get("splat") or {}
    splat["status"] = "ready"
    splat["asset_id"] = descriptor["splat_id"]
    splat["uri"] = descriptor["ply_uri"]
    splat["updated_at"] = descriptor["generated_at"]
    scene["splat"] = splat
    scene_path.write_text(json.dumps(scene, indent=2) + "\n")
    # Bump fixtures/manifest.json mtime so the web server's per-request
    # scene cache refreshes on the next fetch (it keys invalidation off
    # manifest.json mtime, not scene.json).
    manifest_path = fixture_dir.parent.parent / "manifest.json"
    if manifest_path.exists():
        now = datetime.now(timezone.utc).timestamp()
        os.utime(manifest_path, (now, now))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--fixture-id", required=True)
    parser.add_argument("--repo-root", type=Path, default=Path.cwd())
    parser.add_argument("--total-steps", type=int, default=30_000)
    parser.add_argument("--max-resolution", type=int, default=960)
    parser.add_argument("--skip-scene-patch", action="store_true",
                        help="Write descriptor but don't modify scene.json (for A/B testing).")
    args = parser.parse_args()

    repo_root = args.repo_root.resolve()
    fixture_dir = (repo_root / "fixtures/roomplan" / args.fixture_id).resolve()
    if not fixture_dir.exists():
        raise SystemExit(f"fixture dir not found: {fixture_dir}")

    brush_bin = _find_brush_binary(repo_root)
    dataset_dir = _run_converter(repo_root, args.fixture_id)
    out_dir = fixture_dir / "splats/brush-train"
    final_ply = _run_brush(
        brush_bin=brush_bin,
        dataset_dir=dataset_dir,
        out_dir=out_dir,
        total_steps=args.total_steps,
        max_resolution=args.max_resolution,
    )
    descriptor = _write_descriptor(final_ply, args.fixture_id, args.total_steps)
    if not args.skip_scene_patch:
        _patch_scene(fixture_dir, descriptor)

    print(json.dumps({
        "ply": str(final_ply),
        "descriptor": descriptor,
        "scene_patched": not args.skip_scene_patch,
    }, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
