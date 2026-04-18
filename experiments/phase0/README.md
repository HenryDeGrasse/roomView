# Phase 0 — local render bench

Phase 0 exists to answer one question before we build more architecture:

> Do real-room references and depth conditioning materially improve indoor redesign renders over prompt-only generation?

This folder intentionally stops short of canonicalization, evidence indexing, or planner integration. It gives us a **minimal immutable capture bundle** and a **repeatable local render bench**.

## What is in scope

- raw-ish room capture bundles stored under `experiments/phase0/rooms/<room-id>/`
- local SDXL bench runs with four conditions:
  - `prompt_only`
  - `ref_only`
  - `depth_only`
  - `ref_depth`
- blind output filenames plus a separate condition map
- a CSV scoring sheet for manual evaluation

## What is out of scope

- canonical scene design
- evidence coverage computation
- best-view ranking
- photoreal product UX
- object-level edit semantics

## Local model stack

The benchmark script defaults to:

- `stabilityai/stable-diffusion-xl-base-1.0`
- `madebyollin/sdxl-vae-fp16-fix`
- `diffusers/controlnet-depth-sdxl-1.0-small`
- `h94/IP-Adapter` (`ip-adapter_sdxl.safetensors`)
- MiDaS depth estimation via `controlnet_aux` when no depth image is provided in the room bundle

On Apple Silicon, the script prefers `mps` and runs one condition at a time to stay memory-stable.

## Room bundle layout

Create one directory per room under `experiments/phase0/rooms/`.

```text
experiments/phase0/rooms/
  <room-id>/
    manifest.json
    cases.json
    frames/
      frame_front.jpg
      frame_front.depth.png      # optional for Phase 0; otherwise MiDaS is used
      frame_front.pose.json      # optional but recommended to preserve future evidence
      frame_front.intrinsics.json
      frame_corner.jpg
```

Use the templates in `experiments/phase0/templates/`:

- `manifest.example.json`
- `cases.example.json`

## Quick start

From the repo root:

```bash
mkdir -p experiments/phase0/rooms/bedroom-a/frames
cp experiments/phase0/templates/manifest.example.json experiments/phase0/rooms/bedroom-a/manifest.json
cp experiments/phase0/templates/cases.example.json experiments/phase0/rooms/bedroom-a/cases.json
# edit the copied files and add your room photos under frames/
```

Validate manifests without loading models:

```bash
uv run ./scripts/phase0-render-bench.py --dry-run
```

Run a one-room smoke pass:

```bash
uv run ./scripts/phase0-render-bench.py --room bedroom-a --samples 1
```

Run the full bench across all rooms discovered under `experiments/phase0/rooms/`:

```bash
uv run ./scripts/phase0-render-bench.py --samples 2
```

## Useful flags

```bash
# Use a different depth source
uv run ./scripts/phase0-render-bench.py --depth-source dpt
uv run ./scripts/phase0-render-bench.py --depth-source manifest

# Run CPU if needed
uv run ./scripts/phase0-render-bench.py --device cpu

# Quick subset of conditions
uv run ./scripts/phase0-render-bench.py --modes prompt_only,ref_only

# Fewer cases during iteration
uv run ./scripts/phase0-render-bench.py --max-cases 2
```

## Output layout

Each run writes to a timestamped directory under `experiments/phase0/results/`:

```text
experiments/phase0/results/
  20260418-213000/
    run_config.json
    metadata.jsonl
    condition_map.csv
    blind_scoring_sheet.csv
    <room-id>/
      <case-id>/
        input_reference.png
        input_depth.png
        <blind-id>.png
        <blind-id>.png
```

- `condition_map.csv` reveals which blind image corresponds to which mode.
- `blind_scoring_sheet.csv` omits condition labels so you can score outputs before unblinding.

## Suggested manual scoring rubric

Score each output 1–5 on:

1. `edit_faithfulness`
2. `room_preservation`
3. `structural_realism`
4. `artifact_severity`

The benchmark is promising if the conditioned modes beat prompt-only clearly on preservation and realism across multiple rooms/cases.

## Practical guidance for Phase 0

- Start with **2–3 rooms**.
- Use **3–5 sharp room photos** per room max.
- Keep edit cases simple:
  - paint one wall
  - swap flooring
  - replace or recolor a rug
- Do **not** wait on ARKit depth export. MiDaS-estimated depth is good enough to validate whether depth conditioning helps the renderer at all.

## Notes

- The first real run downloads several GB of model weights into your local Hugging Face cache.
- `experiments/phase0/rooms/` and `experiments/phase0/results/` are ignored by Git so you can keep local photos and outputs out of the repo.
- The script locks transform naming to `T_dst_from_src` in the room bundle templates, even though Phase 0 does not consume pose data yet.
