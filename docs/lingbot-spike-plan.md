# RoomPlan × scan-evidence evaluation plan

Status: proposed (superseded prior "productized spike" draft after outside-voice review)
Supersedes: `docs/lingbot-map-external-review-brief.md` (strategic brief)
Generated: 2026-04-18 via CEO-mode plan review + outside-voice pass
Branch: `main`

---

## Strategic decision

**Premise:** dense visual evidence (keyframes, poses, intrinsics) from video-like
capture improves photoreal render quality, enough to justify further investment.

**Blocker we originally missed:** this repo has no photoreal provider that actually
consumes scan evidence. [photoreal-providers.ts:59-75](apps/api/src/photoreal-providers.ts:59)
warns and falls back to the deterministic stub for every non-stub kind. An A/B
harness built on top of today's providers would compare
stub-that-ignores-evidence against stub-that-ignores-evidence, and produce noise
regardless of seed discipline.

**New approach:** answer two questions in order, offline, before any capture
infrastructure work lands in the product.

1. Can we stand up or acquire access to a renderer that actually consumes visual
   evidence (reference images, depth maps, conditioning frames)?
2. If yes, does evidence meaningfully improve render quality under blind paired
   rating with a predefined win bar?

Only if both answers are yes do we build capture infrastructure. If answer 1 is
no, the scan-evidence thesis is dead for reasons unrelated to capture. If answer
2 is no, evidence doesn't help and we redirect effort.

**Mental model:** RoomPlan tells us what the room is. We already have that. The
real question is whether *any* evidence-consuming render path beats
shell-and-prompt alone. We answer that outside the product first.

---

## Phase 0 — render path (this is the blocker)

Before anything else: identify or stand up one renderer that consumes visual
evidence. Options, ordered by effort:

1. **Replicate / hosted API with IP-Adapter or ControlNet.** Cheapest path.
   Examples: `lucataco/sdxl-ip-adapter`, Stability SD3 with reference images.
   Costs per-call money, no GPU infra. Good enough for offline eval.
2. **Local SDXL + IP-Adapter.** Higher effort, no per-call cost. Requires local
   GPU. Gives us deployable control later.
3. **Local SDXL + depth ControlNet.** Uses ARKit depth instead of reference
   images. Different conditioning semantics, possibly stronger signal for
   geometry-accurate generation.

**Deliverable:** one standalone script, outside the product. Input:
`(prompt, seed, scheduler, steps, cfg, camera_pose, camera_intrinsics, reference_images[])`.
Output: one PNG. Not in `photoreal-providers.ts` yet. Not hooked to any API.

**Exit criterion:** we can produce a render that visibly changes when
`reference_images[]` changes, with all other inputs held constant. If we can't
find any pipeline that does this, stop. That is the real blocker, and all the
downstream work was premature.

---

## Phase 1 — offline eval

Assumes Phase 0 cleared.

### Data

- 10-15 rooms. Use existing RoomPlan captures where available. Stage the rest
  with a phone camera.
- Per room, manually select 3-5 sharp, well-framed, non-redundant frames.
  Manual selection is a deliberate choice: we want to test whether evidence
  helps when the evidence is good. "Does frame selection matter?" is a separate
  downstream question.
- For each frame, capture:
  - RGB image at native resolution (no preemptive downsampling).
  - Full 6DoF extrinsics (rotation matrix or quaternion + translation).
  - Camera intrinsics (fx, fy, cx, cy) at the captured resolution.
  - Any resolution change (downsample for the renderer) must rescale intrinsics
    accordingly.
- Storage: out-of-band on the filesystem. No `Scene` schema changes. No
  persistence in the repo's scene store.

### Renders

- Fix every variable except evidence. Same model, same seed, same scheduler,
  same steps, same CFG, same prompt, same target camera pose.
- Per room, produce one pair:
  - Variant A: render without reference images.
  - Variant B: render with reference images.
- Keep prompts reasonable. Don't cheat by making the prompt depend on the
  reference ("use the wall color from the reference"). The whole point is to
  measure whether evidence changes the render even when the prompt is neutral.

### Rating

- Predefine the bar *before* looking at results. Example:
  - At least 3 raters, blind to variant assignment.
  - At least 30 pairs (split across the 10-15 rooms with multiple prompts/angles).
  - Win rate for variant B ≥ 65% with binomial significance.
  - Inter-rater agreement ≥ Fleiss' kappa 0.4 (otherwise the signal is noise).
- Raters: start with us. If we disagree, recruit friendly beta users or use a
  paid rating platform. Document who rated.

### Outcomes

- **Clear the bar:** evidence helps. Proceed to Phase 2. Begin designing real
  capture infrastructure.
- **Miss the bar:** evidence doesn't help under this pipeline. Kill the
  scan-evidence thesis for this provider and consider whether it's worth
  retrying with a different conditioning approach (ControlNet depth vs
  IP-Adapter images, etc.). Do not build capture infrastructure.
- **Inconclusive (low agreement or small effect):** the eval is underpowered.
  Expand the sample or tighten the rubric before deciding.

---

## Phase 2 — capture infrastructure (gated on Phase 1)

Only design this if Phase 1 clears. At that point the infrastructure questions
become answerable with real constraints:

- Which evidence kind matters? Images, depth, mesh, all three? Phase 1 tells us.
- How many frames are enough? Phase 1's effect-size data tells us.
- Does frame quality matter more than frame count? Test with a frame-selection
  ablation before committing to a capture UX.
- Then, and only then, design the `Scene` schema changes, iOS capture flow,
  provider abstractions, and deployment story.

---

## What explicitly does NOT change now

All of the following were in the prior draft. All are deferred until Phase 2
gates open:

- `Scene.splat` rename to `Scene.scan`. The splat field stays. Repo-wide rename
  (migrations, fixtures, persistence, web polling, verify scripts) is a bigger
  change than a 1-week spike, and it's premature before we know what shape the
  new field should have.
- `scan-providers.ts` abstraction. No abstraction before we have one concrete
  implementation.
- Atomic upload extension to `POST /captures/roomplan`. No capture API
  changes.
- Keyframe schema, pose validation, payload limits. No `Keyframe[]` type.
- ARKit mesh capture. Second variable, confounds the eval.
- iOS retry / disk-cache state machine. Not needed without capture changes.
- A/B harness product surface. Offline eval uses paired PNGs on disk, not a
  web UI.
- Feature flag `SCAN_EVIDENCE_ENABLED`. Nothing to flag.
- Observability metrics (`scan.keyframes.*`, `abharness.*`). No runtime
  instrumentation without runtime code.

---

## What the render request needs eventually (reference, not this phase)

If Phase 2 ever proceeds, the API gaps the outside voice identified are real:

- `GeneratePhotorealRequest` has no `seed` field ([api.ts:337-359](packages/contracts/src/api.ts:337)).
  Any future A/B work requires it.
- `Pose3D = { position, yaw_degrees }` ([primitives.ts:43-46](packages/contracts/src/primitives.ts:43))
  is 4DoF. A 6DoF camera type is required.
- No intrinsics type anywhere in contracts. Required for reprojection, coverage,
  or geometry-aware conditioning.
- Current sidecar invariants (`source_scene_version`, `status`, `job_id`,
  `updated_at` on [scene.ts:218-226](packages/contracts/src/scene.ts:218)) must
  survive any future `Scene.scan` design, not be dropped.
- Inlining binary evidence in `Scene` JSON would balloon every
  `GET /scenes/:id` and every save ([roomplan-store.ts:63-67](apps/api/src/roomplan-store.ts:63)).
  Future design must use URI references and a separate store, not inline bytes.

Capture those as design constraints for Phase 2, not as work items for now.

---

## Phase 0 checklist (the only work that starts now)

- [ ] Pick a candidate renderer from Phase 0 options (hosted first, local
      second).
- [ ] Write the standalone eval script. Inputs listed above. Output one PNG.
- [ ] Verify it actually responds to reference images (null-reference test:
      render twice with and without any reference, confirm the outputs differ).
- [ ] If no candidate responds to evidence, stop and report. That's the finding.

---

## Success criteria for the eval (predefined)

Write these down in a checked-in file before running the eval, so we don't move
the goalposts after looking at the data.

- N rooms: 10-15
- N pairs: ≥ 30
- Raters: ≥ 3, blind
- Win-rate threshold for B: ≥ 65%
- Agreement threshold: Fleiss' kappa ≥ 0.4
- Significance: binomial test, p < 0.05

---

## Open questions

- Who rates? Team members first. If team disagrees or sample is small, recruit
  paid raters or friendly users.
- What prompt distribution? Generic ("modern living room," "scandinavian
  kitchen") vs scene-specific. Start generic to avoid prompt-engineering the
  outcome.
- Does the renderer need GPU infra for the eval? Preference: use hosted API
  (Replicate) for Phase 1 to avoid infra work. Local GPU becomes a Phase 2
  decision.
- What does "reasonable" conditioning look like? Some renderers accept 1
  reference, others accept up to 4. Test what the chosen renderer supports and
  pick a config; don't design around an ideal we can't ship.

---

## Cross-model agreement

Two independent reviewers (CEO-mode review + outside-voice review) converged on
the same load-bearing conclusion: the original productized spike builds capture
infrastructure for a render path that does not exist. Both recommended cutting
capture work and focusing on the render path first. The outside voice was
sharper about *how much* was wrong in the original spike (schema coherence,
6DoF pose, intrinsics, seed API, payload math, rename cost). Those correctness
issues all become moot under the current plan, since none of the capture
infrastructure is being built.

If Phase 2 ever proceeds, re-read the outside-voice review before drafting the
capture design.
