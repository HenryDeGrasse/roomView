# RoomPlan × LingBot-Map external review brief

This document is intended to be handed to another LLM so it can independently review this repo plus the same external sources and give its own recommendation on the best direction for the project.

It has two goals:
1. capture what was explored outside this repo
2. provide a strong, self-contained prompt for an independent second opinion

---

## 1) Why this brief exists

This repo is a **RoomPlan-first room editing product**. The current question is whether and how to combine it with **LingBot-Map**:

- external project page: `https://technology.robbyant.com/lingbot-map`
- external repo: `https://github.com/Robbyant/lingbot-map`

The core strategic question is:

> Should LingBot-Map become part of the product architecture, and if so, should it be used for canonical scene structure, scan-side visualization, appearance capture, texture projection, QA, or something else?

The current working hypothesis is:

> **Keep RoomPlan as the authoritative editable scene model. Use LingBot-Map as a non-authoritative, video-derived geometry / appearance / scan-evidence sidecar.**

This brief is meant to help another model validate, challenge, or improve that conclusion.

---

## 2) What was explored externally

### A. LingBot-Map project page
Source: `https://technology.robbyant.com/lingbot-map`

Observed themes from the page:

- It presents LingBot-Map as **streaming 3D reconstruction**.
- It emphasizes **Geometric Context Transformer / Attention**.
- It showcases demo categories such as:
  - Multi-Room
  - Aerial
  - Roaming
  - Driving
- It includes a **Camera Trajectory Estimation** section.
- The demos appear oriented around **point-cloud / reconstruction / trajectory** outputs rather than semantic room modeling.
- The page messaging strongly suggests that the system is about:
  - coordinate grounding
  - depth / geometry prediction
  - long-sequence reconstruction
  - camera trajectory quality

What the project page did **not** suggest:

- a RoomPlan-like semantic scene graph
- editable room objects with constraints
- walls / doors / windows as canonical parametric entities
- material or UV authoring tools
- Gaussian splat output as the primary artifact

### B. LingBot-Map GitHub repo
Source: `https://github.com/Robbyant/lingbot-map`

A cached checkout was created via the librarian skill and inspected locally.

Key files reviewed:

- `README.md`
- `pyproject.toml`
- `demo.py`
- `lingbot_map/vis/point_cloud_viewer.py`
- package/module layout under `lingbot_map/`

Key takeaways from repo inspection:

#### 1. It is a Python/CUDA reconstruction project
The repo is clearly built around:

- PyTorch
- video/image ingestion
- model inference
- visualization/export

It is not a JS/TS frontend library and not a direct browser-native component.

#### 2. It appears to output dense reconstruction artifacts, not semantic room structure
From the README/demo/viewer code, LingBot-Map appears to produce artifacts such as:

- camera poses
- depth
- confidence maps
- world points / point clouds
- trajectory visualization
- browser viewing through `viser`
- GLB export of point cloud + cameras

#### 3. It supports video/image-sequence processing very naturally
The demo accepts:

- an image folder
- a video path
- FPS sampling
- streaming/windowed modes
- long sequence handling

That fits naturally with this repo's existing:

- `POST /captures/:scene_id/video`
- background job model
- scan-side async processing concept

#### 4. It does not appear to be a structured editable scene generator
Nothing inspected suggested that LingBot-Map itself produces:

- wall / floor / ceiling topology
- door/window semantics
- object classes suitable for editing
- constraints or room-planning logic
- clean UV materials / PBR data
- canonical furniture scene graphs

#### 5. It does not look like a true gaussian splat pipeline
The inspected code/readme strongly suggest:

- streaming point-cloud / depth / pose outputs
- visualization and GLB export

not a full gaussian-splat renderer / trainer.

---

## 3) What was explored inside this repo to evaluate fit

Relevant local files inspected:

- `README.md`
- `apps/api/README.md`
- `apps/web/README.md`
- `packages/contracts/README.md`
- `docs/demo-runbook.md`
- `docs/stretch.md`
- `apps/api/src/server.ts`
- `apps/api/src/roomplan-ingest.ts`
- `apps/api/src/photoreal-providers.ts`
- `apps/web/src/server.ts`
- `apps/web/src/viewer.js`
- `packages/contracts/src/scene.ts`
- `packages/contracts/src/api.ts`

Important architectural facts from this repo:

### 1. This product is RoomPlan-first
The repo is organized around a canonical editable scene model, not dense reconstruction.

It already has:

- canonical scene JSON
- room shell
- openings
- objects
- constraints
- bookmarks
- photoreal gallery
- mutation/apply/undo pipeline
- deterministic quick render

### 2. There is already an async scan-side sidecar seam
The repo already supports:

- `POST /captures/roomplan`
- `POST /captures/:scene_id/video`
- `GET /jobs/:job_id`
- a scan pane that can remain functional before or without the sidecar

This is a very important fit point.

### 3. The current “splat” concept is mostly a placeholder/stub
The current code models a splat sidecar with job status transitions, but it is not yet a true rich scan reconstruction path.

This means LingBot-Map has a natural insertion point.

### 4. The frontend already uses Three.js and can load GLTF assets
The web app already has:

- Three.js rendering
- a scan pane
- GLTF loading support

So a first practical integration could use LingBot-derived preview artifacts without inventing a new frontend stack.

### 5. The long-term product vision wants richer scan fidelity and hybrid redesign
`docs/stretch.md` strongly suggests future interest in:

- richer scan fidelity
- splat-like or scan-realistic views
- hybrid scanned + generated representations
- better browser-side scan/render integration

This makes LingBot-Map strategically relevant, even if not as a canonical scene source.

---

## 4) Current strategy recommendation

## High-level recommendation

### Recommended split

- **RoomPlan** should remain the **authoritative editable scene representation**.
- **LingBot-Map** should be incorporated as a **video-derived reconstruction / appearance / scan-evidence sidecar**.

### Why

Because the two systems appear to be good at different things:

#### RoomPlan is good at:
- semantic room structure
- walls / floor / ceiling
- openings
- major room objects
- clean editable geometry
- constraints and mutation

#### LingBot-Map is good at:
- dense visual reconstruction evidence
- camera trajectory
- depth / point-cloud outputs
- turning raw RGB video into a richer scan artifact
- helping determine what the room actually looked like from many views

### Recommended mental model

> **RoomPlan tells us what the room is. LingBot-Map tells us what the room looked like from video.**

---

## 5) Specific strategy: how to combine them

### A. Do use LingBot-Map as a scan-sidecar
Best near-term use:

- user captures RoomPlan scene
- optional video is uploaded via existing video endpoint
- background worker runs LingBot-Map
- sidecar artifacts are stored and exposed through the existing jobs API
- scan pane upgrades from placeholder → richer reconstruction overlay

### B. Do not use LingBot-Map as the canonical scene source
Do **not** let LingBot-Map replace or overwrite:

- shell surfaces
- openings
- object editability
- scene constraints
- mutation authority

The canonical scene should remain RoomPlan-based.

### C. Use LingBot-Map for appearance evidence, not initially for “true texturing”
Best initial appearance use cases:

- wall appearance evidence
- floor appearance evidence
- ceiling appearance evidence
- large fixed-element appearance previews
- object color/material hints
- best-view thumbnails for RoomPlan objects

Avoid overclaiming that this is “material capture” or “exact object texture recovery.”

### D. Treat “splat” as a separate future branch
Do not force LingBot-Map into a misleading “splat” label.

Better long-term model:

- RoomPlan preview
- LingBot point cloud / reconstruction sidecar
- optional future gaussian splat sidecar

---

## 6) Reasoning behind this strategy

### 1. It matches the architecture that already exists
This repo already has a place for optional async video-derived outputs.

So the question is not “how do we redesign the product around LingBot?”

It is:

> “How do we upgrade the current placeholder video sidecar into a real useful reconstruction layer?”

LingBot-Map appears to be a very good candidate for that.

### 2. It preserves editability
A dense RGB reconstruction system is usually a poor source of truth for:

- semantic constraints
- object editing
- clean wall/opening structure

RoomPlan is far better suited for the editable canonical model.

### 3. It creates product value early
Even before any complex fusion work, LingBot-Map could enable:

- better scan pane fidelity
- camera/coverage inspection
- quality diagnostics
- better photoreal conditioning inputs
- shell appearance projection experiments

These are high-value additions without risking the core editing model.

### 4. It leaves room for future sophistication
This approach keeps open future options like:

- alignment to canonical scene
- surface coverage maps
- projected appearance atlases
- better scan/render compositing
- non-RoomPlan / Android capture experiments

while avoiding premature commitment to full reconstruction fusion.

---

## 7) What seems like the best first implementation direction

### Phase 1: real LingBot sidecar job
Convert the current placeholder video job into a real background job that produces artifacts such as:

- cameras / poses
- internal predictions
- point cloud preview asset
- preview GLB or similar scan-side artifact

### Phase 2: scan pane overlay
Allow the scan pane to display LingBot-derived reconstruction data as a read-only overlay.

### Phase 3: alignment
Add a way to align LingBot coordinates to the RoomPlan coordinate frame.

### Phase 4: diagnostics
Compute useful things like:

- surface coverage
- best frames per surface/object
- possible mismatch hints

### Phase 5: appearance projection
Project visual evidence onto canonical RoomPlan shell surfaces.

### Phase 6: object appearance descriptors
Add object-level color/material hints and thumbnails, not exact UV textures.

---

## 8) What not to do

The following directions currently seem wrong or risky:

### Do not:
- replace RoomPlan with LingBot-Map
- treat LingBot output as canonical scene geometry
- auto-mutate RoomPlan objects/walls from LingBot point clouds early
- promise exact furniture texture recovery too soon
- label LingBot output as a true splat unless a real splat pipeline exists
- make the editor depend on LingBot success

### Do:
- keep LingBot optional and async
- keep RoomPlan authoritative
- use LingBot additively
- start with scan realism, alignment, diagnostics, and appearance evidence

---

## 9) Open questions that should be independently validated

These are the main things another LLM should verify or challenge:

1. **Does LingBot-Map actually produce enough stable artifact structure for a clean worker integration?**
2. **Is GLB actually the best first browser-facing artifact, or should the first viewer path be custom point-cloud rendering?**
3. **Can LingBot be aligned reliably enough to RoomPlan to support surface projection?**
4. **For iPhone capture specifically, is ARKit pose data already sufficient for early appearance projection without LingBot?**
5. **Is LingBot most valuable as scan visualization, appearance evidence, QA, photoreal conditioning, or future Android fallback?**
6. **Should the current schema generalize `splat` immediately, or is that too much churn for an early prototype?**
7. **What should the API / schema look like if the project wants to support multiple sidecar kinds over time?**

---

## 10) Copy-paste prompt for another LLM

Use the following prompt verbatim or with light edits.

---

# Prompt: independent review of RoomPlan × LingBot-Map strategy

You are reviewing a local repo plus external sources to give an independent recommendation on whether and how to combine **RoomPlan** with **LingBot-Map**.

## Your task

Please independently inspect:

### Local repo
This repo is a RoomPlan-first room editing product. Please inspect at least these files:

- `README.md`
- `docs/demo-runbook.md`
- `docs/stretch.md`
- `apps/api/src/server.ts`
- `apps/api/src/roomplan-ingest.ts`
- `apps/api/src/photoreal-providers.ts`
- `apps/web/src/server.ts`
- `apps/web/src/viewer.js`
- `packages/contracts/src/scene.ts`
- `packages/contracts/src/api.ts`

### External sources
Please inspect the same external sources:

- project page: `https://technology.robbyant.com/lingbot-map`
- GitHub repo: `https://github.com/Robbyant/lingbot-map`

Also inspect any obviously relevant linked sources if useful, such as the paper/model page, but do not rely on them unless you actually inspect them.

## Working context

This local repo already has:

- a canonical editable scene model based on RoomPlan
- shell surfaces, openings, objects, constraints, bookmarks, photoreal gallery
- `POST /captures/roomplan`
- `POST /captures/:scene_id/video`
- `GET /jobs/:job_id`
- a scan pane, layout pane, and render pane
- a current optional “splat” sidecar flow that is mostly placeholder/stub logic
- Three.js rendering and GLTF loading

The strategic question is:

> Should LingBot-Map be incorporated into this product, and if so, what role should it play?

## Initial hypothesis to challenge or validate

A prior synthesis suggests:

- RoomPlan should remain the authoritative editable scene model
- LingBot-Map should be treated as a non-authoritative, video-derived reconstruction / scan / appearance sidecar
- LingBot-Map seems better suited for scan visualization, depth/pose/point-cloud evidence, coverage diagnostics, and surface appearance evidence than for canonical semantic scene generation
- It should probably not be labeled a “splat” unless there is a real splat pipeline behind it
- Shell appearance projection seems more realistic than exact furniture texture recovery

Do **not** simply accept this hypothesis. Please verify it or explain why it is wrong.

## What I want from you

Please produce a structured, opinionated report covering:

### 1. What LingBot-Map actually appears to produce
Be concrete. Does it produce:

- depth
- camera poses
- point clouds
- meshes
- GLB assets
- semantic objects
- UV/material data
- splats
- radiance fields

Distinguish between what is clearly present vs what is inferred vs what is absent.

### 2. Best-fit roles in this architecture
Assess whether LingBot-Map is best used for:

- scan pane upgrade
- dense reconstruction sidecar
- QA / diagnostics
- appearance / texture projection
- photoreal conditioning
- Android/non-RoomPlan fallback capture
- canonical scene generation
- object reconstruction

### 3. What is a bad fit
Call out the roles that would be misleading, risky, or architecturally wrong.

### 4. Strategy recommendation
Recommend the best overall architecture for combining RoomPlan and LingBot-Map.

### 5. Reasoning
Explain why your recommendation is correct, using evidence from both the local repo and external sources.

### 6. Concrete implementation path
Give a phased implementation plan. Please be practical and repo-aware.

I want you to address things like:

- should the current `splat` concept be generalized?
- what new sidecar/job abstractions should exist?
- what artifacts should the worker emit first?
- what should the scan pane render first?
- how should alignment work?
- what appearance/texture work is realistic in v1 vs later?

### 7. Risks and “do not do this” list
Call out traps, misleading assumptions, or scope creep risks.

### 8. If you disagree with the initial hypothesis
Please explicitly say where and why.

## Important instructions

- Be specific, not generic.
- Use the repo’s actual architecture when giving recommendations.
- Distinguish clearly between:
  - RoomPlan as canonical structure
  - LingBot-Map as possible sidecar/evidence layer
- Do not assume LingBot-Map is a splat system unless you verify that directly.
- Do not assume exact object texturing/material capture unless you can support that claim.
- If you think another direction is better, say so clearly.

## Desired output style

Please structure your answer as:

1. Executive summary
2. What LingBot-Map actually is / is not
3. Fit with this repo
4. Recommended architecture
5. Phased implementation plan
6. Risks / anti-patterns
7. Final recommendation

---

## 11) Final internal summary

If another reviewer reaches the same general conclusion, the likely next move for this repo is:

> **Use LingBot-Map to upgrade the existing optional video sidecar into a real, read-only scan reconstruction / appearance evidence layer, while keeping RoomPlan as the canonical editable model.**

That currently appears to be the most strategically sound direction.
