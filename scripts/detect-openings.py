#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = [
#   "numpy>=1.26",
# ]
# ///
"""
Detect doors + windows in the fitted room walls by ray-casting every
captured depth pixel against each wall plane:

  - if the pixel's depth is significantly PAST the wall plane (or is
    NaN = ARKit gave up on that pixel), the camera saw THROUGH the wall
    — that pixel observed an opening;
  - accumulate those pixels into each wall's local (u, v) 2D grid;
  - cells voted on by ≥ N frames become opening candidates;
  - connected-component + axis-aligned rect fit → one opening each.

Classification heuristic (after the rect fit, in wall-local coords):
  door   := touches the floor (min_v ≤ 0.10 m) AND height ≥ 1.70 m
  window := otherwise

Usage:
    uv run scripts/detect-openings.py --fixture-id fixture-bedroom-arkitscenes

Writes `shell.openings` into the fixture's scene.json (replacing any
existing openings). Idempotent: re-running regenerates from the same
(scene.json + frames) inputs.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path
from typing import Any

import numpy as np


# Tunable thresholds. 15cm of "beyond wall" before a pixel counts as an
# opening; 5cm/cell wall grid; ≥3 frames needed to vote an opening cell
# (kills RANSAC-edge single-frame noise).
BEYOND_WALL_THRESHOLD_M = 0.15
WALL_GRID_CELL_M = 0.05
OPENING_MIN_FRAMES = 3
OPENING_MIN_AREA_M2 = 0.25
DOOR_FLOOR_TOUCH_THRESHOLD_M = 0.10
DOOR_MIN_HEIGHT_M = 1.70
# Expand edges a tiny amount so a barely-hit cell becomes part of an
# adjacent stronger cluster during connected-component labelling.
DILATION_STEPS = 1


def load_scene(fixture_dir: Path) -> dict:
    return json.loads((fixture_dir / "scene.json").read_text())


def load_frames_meta(scene: dict) -> list[dict]:
    return scene.get("captured_frames", [])


def load_depth_and_intrinsics(fixture_dir: Path, frame: dict) -> tuple[np.ndarray, dict]:
    depth_uri: str = frame["depth"]["uri"]
    if not depth_uri.startswith("/dev/fixtures/"):
        raise SystemExit(f"unexpected depth uri: {depth_uri}")
    # uri shape: /dev/fixtures/{fixture_id}/frames/{name}
    _, _, _, _, rel = depth_uri.split("/", 4)
    depth_path = fixture_dir / rel
    arr = np.load(depth_path)
    if arr.ndim != 2 or arr.dtype != np.float32:
        raise SystemExit(f"unexpected depth shape {arr.shape} dtype {arr.dtype} for {depth_path}")
    intr = frame["intrinsics"]
    dh, dw = arr.shape
    scale_x = dw / intr["width"]
    scale_y = dh / intr["height"]
    scaled = {
        "fx": intr["fx"] * scale_x,
        "fy": intr["fy"] * scale_y,
        "cx": intr["cx"] * scale_x,
        "cy": intr["cy"] * scale_y,
        "width": dw,
        "height": dh,
    }
    return arr, scaled


def column_major_to_4x4(flat16: list[float]) -> np.ndarray:
    return np.array(flat16, dtype=np.float64).reshape(4, 4, order="F")


def wall_frames_from_scene(scene: dict) -> list[dict]:
    """Return the wall surfaces with fully populated surface_frame + boundary."""
    shell = scene["snapshot"]["state"]["room"]["shell"]
    walls = []
    for s in shell.get("surfaces", []):
        if s.get("type") != "wall":
            continue
        frame = s.get("surface_frame")
        boundary = s.get("boundary")
        if not frame or not boundary:
            continue
        verts = [(float(v["x"]), float(v["y"])) for v in boundary["vertices"]]
        us = [v[0] for v in verts]
        vs = [v[1] for v in verts]
        origin = np.array([frame["origin"]["x"], frame["origin"]["y"], frame["origin"]["z"]], dtype=np.float64)
        u_axis = np.array([frame["u_axis"]["x"], frame["u_axis"]["y"], frame["u_axis"]["z"]], dtype=np.float64)
        v_axis = np.array([frame["v_axis"]["x"], frame["v_axis"]["y"], frame["v_axis"]["z"]], dtype=np.float64)
        normal = np.array([frame["normal"]["x"], frame["normal"]["y"], frame["normal"]["z"]], dtype=np.float64)
        walls.append({
            "surface_id": s["surface_id"],
            "origin": origin,
            "u_axis": u_axis,
            "v_axis": v_axis,
            "normal": normal,
            "u_min": min(us), "u_max": max(us),
            "v_min": min(vs), "v_max": max(vs),
        })
    return walls


def vote_openings_for_wall(
    wall: dict,
    frames: list[dict],
    fixture_dir: Path,
) -> np.ndarray:
    """
    Return a 2D array of vote counts: votes[v_cell, u_cell] = number of
    frames that saw through this wall at that lattice cell.
    """
    u_span = wall["u_max"] - wall["u_min"]
    v_span = wall["v_max"] - wall["v_min"]
    nu = max(2, int(np.ceil(u_span / WALL_GRID_CELL_M)))
    nv = max(2, int(np.ceil(v_span / WALL_GRID_CELL_M)))
    votes = np.zeros((nv, nu), dtype=np.int32)

    for frame in frames:
        depth, intr = load_depth_and_intrinsics(fixture_dir, frame)
        fx, fy = intr["fx"], intr["fy"]
        cx, cy = intr["cx"], intr["cy"]
        dw, dh = intr["width"], intr["height"]
        wfc = column_major_to_4x4(frame["camera_transform"])
        cam_origin = wfc[:3, 3]
        R = wfc[:3, :3]

        # Build a pixel grid in OpenCV cam frame at unit depth, then
        # rotate into world coords — the direction is the ray direction
        # from the camera through that pixel (not yet normalised).
        uu, vv = np.meshgrid(np.arange(dw), np.arange(dh))
        x_c = (uu - cx) / fx
        y_c = (vv - cy) / fy
        z_c = np.ones_like(x_c, dtype=np.float64)
        cam_rays = np.stack([x_c, y_c, z_c], axis=-1).astype(np.float64)
        world_rays = cam_rays @ R.T  # (H, W, 3) in world coords

        # Ray-plane intersection: plane is { x | normal · (x - origin) = 0 }.
        # For ray C + t * d: t = normal · (origin - C) / (normal · d).
        n = wall["normal"]
        denom = world_rays @ n  # (H, W)
        # A ray parallel to the plane has denom ≈ 0 — skip it.
        denom_safe = np.where(np.abs(denom) < 1e-4, np.nan, denom)
        num = float(np.dot(n, wall["origin"] - cam_origin))
        t_wall = num / denom_safe
        # Only accept rays hitting the wall IN FRONT of the camera.
        # Also drop NaN/Inf from parallel rays (denom≈0) so downstream
        # casts to int don't blow up.
        valid_front = np.isfinite(t_wall) & (t_wall > 0.3)

        # World intersection point.
        # Using broadcasting: intersection = cam_origin + t_wall * world_rays
        intersection = cam_origin[None, None, :] + t_wall[..., None] * world_rays

        # Project into wall-local (u, v).
        disp = intersection - wall["origin"][None, None, :]
        loc_u = disp @ wall["u_axis"]
        loc_v = disp @ wall["v_axis"]
        in_wall = (
            (loc_u >= wall["u_min"]) & (loc_u <= wall["u_max"]) &
            (loc_v >= wall["v_min"]) & (loc_v <= wall["v_max"])
        )

        actual_depth = depth  # in OpenCV cam frame, +Z is depth along ray at unit scaling
        # world_rays * t_wall gives a 3D point; convert back to the ray's
        # distance-along-ray. Since cam_rays was built with z=1, the
        # distance along the unit ray is t_wall * |world_rays| — but
        # we designed world_rays = R @ cam_ray and |cam_ray| is
        # sqrt(x_c^2 + y_c^2 + 1). To compare apples to apples: both
        # actual_depth and t_wall should be "distance along the ray
        # normalised to cam +Z = 1", which IS the case since cam_rays
        # stored (x/fx, y/fy, 1). So t_wall IS the "depth at this
        # pixel" in cam +Z, matching actual_depth.

        # Opening candidate = this pixel's actual depth is significantly
        # beyond the wall intersection, OR the pixel had NO depth reading
        # (NaN) while the wall was in front of it (likely through a
        # window onto the sky).
        beyond = np.where(
            np.isnan(actual_depth),
            valid_front & in_wall,
            valid_front & in_wall & (actual_depth > t_wall + BEYOND_WALL_THRESHOLD_M),
        )
        if not np.any(beyond):
            continue

        # Convert local (u, v) to grid cell indices and vote once per cell.
        # Mask NaN loc_u/loc_v (from parallel-ray t_wall) with -1 so the
        # post-cast bounds check rejects them.
        loc_u_safe = np.where(np.isfinite(loc_u), loc_u, wall["u_min"] - 99)
        loc_v_safe = np.where(np.isfinite(loc_v), loc_v, wall["v_min"] - 99)
        u_cells = np.floor((loc_u_safe - wall["u_min"]) / WALL_GRID_CELL_M).astype(np.int64)
        v_cells = np.floor((loc_v_safe - wall["v_min"]) / WALL_GRID_CELL_M).astype(np.int64)
        valid_cells = (
            beyond
            & (u_cells >= 0) & (u_cells < nu)
            & (v_cells >= 0) & (v_cells < nv)
        )
        if not np.any(valid_cells):
            continue
        uc = u_cells[valid_cells]
        vc = v_cells[valid_cells]
        # One vote per cell per frame — avoid a dense pixel cluster
        # counting as many frames.
        hit = np.zeros_like(votes, dtype=bool)
        hit[vc, uc] = True
        votes += hit.astype(np.int32)
    return votes


def dilate_mask(mask: np.ndarray, steps: int) -> np.ndarray:
    if steps <= 0:
        return mask
    out = mask.copy()
    for _ in range(steps):
        dilated = out.copy()
        dilated[1:, :] |= out[:-1, :]
        dilated[:-1, :] |= out[1:, :]
        dilated[:, 1:] |= out[:, :-1]
        dilated[:, :-1] |= out[:, 1:]
        out = dilated
    return out


def connected_components(mask: np.ndarray) -> list[np.ndarray]:
    """Simple 4-connectivity flood fill. Returns each component as a boolean mask."""
    visited = np.zeros_like(mask, dtype=bool)
    components: list[np.ndarray] = []
    nv, nu = mask.shape
    for v0 in range(nv):
        for u0 in range(nu):
            if not mask[v0, u0] or visited[v0, u0]:
                continue
            stack = [(v0, u0)]
            comp = np.zeros_like(mask, dtype=bool)
            while stack:
                v, u = stack.pop()
                if v < 0 or u < 0 or v >= nv or u >= nu:
                    continue
                if visited[v, u] or not mask[v, u]:
                    continue
                visited[v, u] = True
                comp[v, u] = True
                stack.extend([(v + 1, u), (v - 1, u), (v, u + 1), (v, u - 1)])
            components.append(comp)
    return components


def rects_from_votes(
    votes: np.ndarray,
    wall: dict,
    min_frames: int = OPENING_MIN_FRAMES,
) -> list[dict]:
    mask = votes >= min_frames
    if not np.any(mask):
        return []
    mask = dilate_mask(mask, DILATION_STEPS)
    rects = []
    for comp in connected_components(mask):
        area_cells = int(np.sum(comp))
        area_m2 = area_cells * WALL_GRID_CELL_M * WALL_GRID_CELL_M
        if area_m2 < OPENING_MIN_AREA_M2:
            continue
        vs, us = np.where(comp)
        u_min_cell = int(us.min()); u_max_cell = int(us.max())
        v_min_cell = int(vs.min()); v_max_cell = int(vs.max())
        rect = {
            "min_u": wall["u_min"] + u_min_cell * WALL_GRID_CELL_M,
            "min_v": wall["v_min"] + v_min_cell * WALL_GRID_CELL_M,
            "width": (u_max_cell - u_min_cell + 1) * WALL_GRID_CELL_M,
            "height": (v_max_cell - v_min_cell + 1) * WALL_GRID_CELL_M,
            "_vote_count": int(votes[comp].sum()),
        }
        rects.append(rect)
    return rects


def classify_opening(rect: dict) -> str:
    min_v = rect["min_v"]
    height = rect["height"]
    if min_v <= DOOR_FLOOR_TOUCH_THRESHOLD_M and height >= DOOR_MIN_HEIGHT_M:
        return "door"
    return "window"


def mint_opening_id(wall_id: str, rect: dict, idx: int) -> str:
    raw = f"{wall_id}|{idx}|{rect['min_u']:.2f}|{rect['min_v']:.2f}|{rect['width']:.2f}|{rect['height']:.2f}"
    return f"opening-fit-{hashlib.sha1(raw.encode()).hexdigest()[:12]}"


def detect_all(scene: dict, fixture_dir: Path) -> list[dict]:
    walls = wall_frames_from_scene(scene)
    frames = load_frames_meta(scene)
    if not frames:
        raise SystemExit("no captured_frames in scene")
    openings: list[dict] = []
    for i, wall in enumerate(walls):
        print(
            f"[detect-openings] wall {wall['surface_id'][-8:]} "
            f"({wall['u_max']-wall['u_min']:.2f}×{wall['v_max']-wall['v_min']:.2f}m) — "
            f"running vote over {len(frames)} frames",
            file=sys.stderr,
        )
        votes = vote_openings_for_wall(wall, frames, fixture_dir)
        wall_rects = rects_from_votes(votes, wall)
        print(
            f"  → {len(wall_rects)} opening rect(s)",
            file=sys.stderr,
        )
        for idx, rect in enumerate(wall_rects):
            otype = classify_opening(rect)
            opening_id = mint_opening_id(wall["surface_id"], rect, idx)
            openings.append({
                "opening_id": opening_id,
                "host_surface_id": wall["surface_id"],
                "type": otype,
                "rect": {
                    "min_u": float(rect["min_u"]),
                    "min_v": float(rect["min_v"]),
                    "width": float(rect["width"]),
                    "height": float(rect["height"]),
                },
                "swing_zone": None,
                "keepout_zone": None,
                "connects_to_room_id": None,
                "provenance": {
                    "source_kind": "measured",
                    "source_ref": "scan:detect-openings",
                    "confidence": min(0.85, 0.3 + 0.05 * rect.get("_vote_count", 0)),
                    "updated_at": "2026-04-19T00:00:00.000Z",
                },
            })
            print(
                f"    {otype} at u=[{rect['min_u']:.2f},{rect['min_u']+rect['width']:.2f}] "
                f"v=[{rect['min_v']:.2f},{rect['min_v']+rect['height']:.2f}] "
                f"votes={rect['_vote_count']}",
                file=sys.stderr,
            )
    return openings


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--fixture-id", required=True)
    parser.add_argument("--repo-root", type=Path, default=Path.cwd())
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    fixture_dir = (args.repo_root / "fixtures" / "roomplan" / args.fixture_id).resolve()
    if not fixture_dir.exists():
        raise SystemExit(f"fixture dir not found: {fixture_dir}")
    scene_path = fixture_dir / "scene.json"
    scene = json.loads(scene_path.read_text())
    openings = detect_all(scene, fixture_dir)
    print(f"[detect-openings] total: {len(openings)} openings", file=sys.stderr)
    if args.dry_run:
        print(json.dumps(openings, indent=2))
        return 0
    room = scene["snapshot"]["state"]["room"]
    room["shell"]["openings"] = openings
    # Each Opening needs a matching `opening_preserved` constraint on the
    # room for the scene contract; mint one per detected opening and
    # replace any stale entries that belonged to previously-detected
    # openings.
    constraints = room.get("constraints") or []
    constraints = [c for c in constraints if c.get("kind") != "opening_preserved"]
    for opening in openings:
        constraints.append({
            "constraint_id": f"constraint-{opening['opening_id']}-preserved",
            "kind": "opening_preserved",
            "scope": {"opening_ids": [opening["opening_id"]]},
            "provenance": opening["provenance"],
        })
    room["constraints"] = constraints
    scene_path.write_text(json.dumps(scene, indent=2) + "\n")
    print(f"[detect-openings] wrote {len(openings)} openings to {scene_path}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
