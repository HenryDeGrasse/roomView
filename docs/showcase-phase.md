# Showcase Phase

*The phase where RoomView looks like a product.*

For the broader trajectory see [roadmap.md](roadmap.md). For the MVP spec that this builds on see [mvp_duet.md](mvp_duet.md). For the long-arc vision see [stretch.md](stretch.md). This doc is the concrete plan for the next 6–8 weeks.

## Why a single phase

The repo has solid structural bones — canonical scene schema, fixture-replay testing, validator-first mutations, clean provider abstractions — but the things a user actually sees are either plain (the editor UI) or synthetic (the photoreal pipeline uses SDXL against synthetic conditioning, not captured evidence). The render stack is a generation behind state of the art; the splat sidecar is schema-only; there is no native capture app.

Three improvements compound when shipped together:

1. A **SOTA render stack** (Flux + IP-Adapter + SAM2 + IC-Light) turns "AI-generated proxy" into "retouched photograph."
2. A **splat-primary scene viewer** turns the scan pane from a schematic into a cinematic.
3. A **polished editor + iPhone capture app** turns the demo from "imagine an iPhone here" into an end-to-end loop anyone can touch.

Each is individually valuable. Together they land as a flagship demo: scan a real room on an iPhone, see it render as a splat, edit one wall, see a photoreal before/after from three captured viewpoints, with a materials list that links to real products.

## Scope gate — what counts as "Showcase done"

- One ARKitScenes bedroom and one iPhone-scanned bedroom both round-trip: bundle ingest → splat generation → hero render on `repaint_surface` and `swap_flooring` from at least three captured viewpoints per room.
- LPIPS preservation outside the edit mask ≥ 0.97 on every hero render (verifier-enforced).
- Multi-view consistency: the same edit rendered from three viewpoints of the same room agrees on color, texture, and lighting character to the eye — no drift.
- Editor ships with the design system applied to every surface, not just new ones.
- iPhone app target installable on a real device with the full capture → upload loop working (not just a Swift Package).
- `npm run check` stays green across the whole phase. Every new capability gets a verifier.

Anything outside this gate is deferred — see the end of this doc.

---

## Track A — Photoreal that looks like a photograph

**Outcome.** A rendered image that, at thumbnail and at full resolution, is visually indistinguishable from a photo of the real room with the edit actually applied.

### The stack

The current provider interface ([photoreal-providers.ts:15](../apps/api/src/photoreal-providers.ts:15)) already carries the conditioning we need — `reference_image_data_url`, `client_conditioning` with width/height/byte lengths for color/depth/edge. The new provider kind plugs in without changing the calling convention.

**Models and why each:**

- **Flux.1-dev** as the base generator. Materially stronger interior photorealism than SDXL 1.0 — better material rendering (wood grain, matte paint, fabric weave), better prompt adherence, and the community tooling ecosystem has caught up. This is the single biggest visual-quality lever available right now.
- **IP-Adapter** conditioned on the captured RGB. The captured image becomes a *style* prompt in addition to the text prompt. This is what makes the render *feel like your room* rather than "an AI render of a room with those materials." No fine-tuning required, minimal engineering cost, massive quality delta. Flux has first-class IP-Adapter support via XLabs or InstantX adapters.
- **ControlNet-Depth** conditioned on the captured ARKit depth. Locks structural geometry. The captured depth from Milestone 1 is exactly what this wants.
- **Inpaint mode** via Flux-Fill or SDXL-Inpaint as fallback. Guarantees outside-mask pixels are preserved byte-for-byte, which is the core promise.
- **SAM2** (Segment Anything 2) for mask generation. Video-consistent successor to SAM — the "video" part matters because M3+ renders the same edit across multiple viewpoints, and SAM2's mask-propagation keeps them coherent.
- **Grounded-SAM** or text-prompted SAM2 for convenience ("the north wall"). Falls back to scene-surface-polygon projection as a geometric prior.
- **IC-Light** as a post-pass. Physically-plausible relighting of the edited region so a repainted wall reflects actual room illumination. Without this, paint looks flat and fake; with it, paint looks like a photograph. This is the polish layer.
- **MV-Adapter** (or Stable Video Diffusion with keyframe anchoring) for multi-view consistency. The same edit rendered from three captured viewpoints cohere to each other, not just to their individual references. This is what makes a gallery of hero shots feel like a real room instead of a collage.

### Route taken: hybrid mask with geometric prior

From the three routes discussed during M3 scoping:

- **Route A — pure geometric projection.** Blocked on mesh-based wall fitting for ARKitScenes scenes.
- **Route B — pure SAM click.** Fast to ship but masks don't bind to scene geometry, so multi-view propagation is lossy.
- **Route C — hybrid.** Scene surface polygon as box prompt → SAM2 refines → mask bound to `surface_id`.

We take **Route C**. When geometry is good (iPhone scans via RoomPlan), the prior is tight and SAM2 just cleans edges. When geometry is rough (ARKitScenes synthetic shell), SAM2 does more work but still lands on the right wall because the prior gets it close. Fall back to pure click-SAM2 if no surface_id is provided. The mask binds to the surface, so later we re-mask the same surface from a different viewpoint and the semantic identity is preserved.

### Preservation guarantee

Inpaint-mode diffusion natively preserves outside-mask pixels, but lighting bleed at mask boundaries can still shift hue on untouched regions. Post-step: alpha-composite the edited mask region (with feathering, ~2–3 px at 1024 edge) back onto the reference RGB. The verifier asserts LPIPS(reference_outside_mask, rendered_outside_mask) ≥ 0.97; if that fails, the render is rejected before it lands in the gallery.

### Multi-view consistency

Approach: render the "hero" viewpoint first, then use MV-Adapter (or a simpler noise-locked seed + IP-Adapter chaining) to condition subsequent renders on the first. The first render becomes the style anchor for siblings. The Scene already supports multiple `photoreal_versions` per snapshot; the new field is `render_group_id` linking versions from the same edit.

### Provider dispatch

New `PhotorealProviderKind`: `flux_inpaint_stack`. Selected via `ROOMVIEW_PHOTOREAL_PROVIDER=flux_inpaint_stack`. Backend: Modal or Replicate for Flux + IP-Adapter + ControlNet-Depth + SAM2 + IC-Light as a single pipeline endpoint (one round-trip per render, not five). Mock backend for CI: deterministic fixture image keyed off `(scene_snapshot_id, entry_id)` so `npm run check` stays offline.

### Evaluation

- **Automated:** LPIPS outside mask ≥ 0.97 (hard gate), SSIM outside mask ≥ 0.98 (soft gate), mean delta-E in edit region > 5 (proves something actually changed), FID against ARKitScenes distribution (informational, not gated).
- **Human:** weekly review pass on the hero gallery. "Does this look like a photo?" binary call.

### Deferred out of Track A

- Object-level edits (`replace_object`) with photoreal rerender. Requires novel-view consistency we're not promising.
- Free-camera novel-view photoreal. Splats are the novel-view surface for this phase; photoreal stays on captured viewpoints.
- Relighting for edits other than the painted region (e.g. replacing a lamp should change room illumination globally). Out.
- Per-material fine-tunes. LoRAs for specific paint brands would bump quality further but aren't needed for the gate.

---

## Track B — Splat-primary scene viewer

**Outcome.** Opening a scene shows a Gaussian Splatting render of the real room. Editing happens against OBB overlays on top of the splat. Cinematic camera paths between captured viewpoints. Sub-second view transitions.

### The stack

- **Splat generation.** Splatfacto via Nerfstudio, or 3DGS-Lightning for faster training on iPhone-count frame counts (dozens, not hundreds). Runs as a background job — the existing `SplatAssetRecord` lifecycle ([scene.ts:219](../packages/contracts/src/scene.ts:219)) is already `queued → processing → ready → failed`, so the scaffolding is there.
- **Splat format.** PLY with per-gaussian color/scale/rotation/opacity, compatible with Luma's format and the [gsplat.js](https://github.com/huggingface/gsplat.js) loaders.
- **Web viewer.** Integrate [@mkkellogg/gaussian-splats-3d](https://github.com/mkkellogg/GaussianSplats3D) or gsplat.js into the existing three.js scene at `LAYER_SPLAT=2`. The layer already exists ([viewer.js `mountScanView()`](../apps/web/src/viewer.js)); it just needs a real splat loader wired in.
- **OBB overlay.** Keep the current OBB rendering at `LAYER_OBJECTS=1`, rendered with translucency over the splat. Selection, move, rotate gizmos continue to work against OBBs — the splat is view-only.
- **Cinematic camera paths.** Smooth Bezier or Catmull-Rom through `CameraBookmark` sequence. Ease-in/ease-out timing. One-tap "fly through" button.

### Splat generation pipeline

1. Scan bundle ingest creates `SplatAssetRecord` in `queued` state (already wired when `video_expected: true`).
2. New Python script `scripts/splat-generate.py` (uv inline-deps) runs Nerfstudio's Splatfacto pipeline on the captured frames. Input: captured RGB + depth + pose + intrinsics from the scan bundle. Output: `splat.ply` in the artifact store.
3. Job progresses: `queued → processing → ready`. The web editor polls and swaps the scan pane from "shell-only" to "splat visible" the moment it's ready.
4. Fixture splats ship with the existing ARKitScenes and iPhone bedroom fixtures so the editor isn't empty when the backend isn't available.

### View modes

- **Splat-primary** (default for scenes with `splat.status === "ready"`): splat layer visible, OBBs hidden until hover.
- **Edit-primary** (toggled when selecting an object): OBBs opaque, splat dims to 30% opacity.
- **Render-primary** (gallery view): photoreal entry shown full-bleed, splat behind it for context.
- **Smooth transitions** between modes (300ms crossfade, CSS-driven where possible).

### Why splats, not NeRF

NeRFs train slower (minutes-to-hours) and render slower (ray-marching at inference). Splats train in minutes on a T4, render at 60fps in a browser. The quality is comparable for interiors with decent coverage. The product doesn't need NeRF's implicit representation — we have explicit OBB geometry for editing already.

### Deferred out of Track B

- Splat editing (deleting/moving gaussians to reflect object moves). Splats stay static; the splat shows the *original scan*, OBB overlay shows the *current edit state*. This is the honest and tractable version.
- Mesh extraction from splats. Not needed if the photoreal track carries the visual-quality burden.
- Real-time splat re-training as new captures arrive. Batch only.

---

## Track C — Editor, capture, and gallery UX

**Outcome.** Every surface of the app feels intentional. Scan pane, edit pane, gallery, and iPhone capture app share a design system. A third-party looking at screenshots cannot tell this is a hackathon repo.

### Current state

The editor is vanilla JS with inline CSS in [apps/web/src/server.ts:163](../apps/web/src/server.ts:163). Dark theme (#0b1020 bg, #e5e7eb text), card-based layout, functional but minimal. No component library, no design tokens, no motion system. This is correct for the MVP; it is not correct for the Showcase.

### Approach: tokens-first, no framework flip

We don't need React/Svelte to make this pretty. The editor has a clear structure (toolbar, three panes, gallery) and vanilla JS with a design-tokens CSS module will carry it. Framework migration is a separate and larger project; punting it does not block Showcase.

**Design tokens.** Extract the inline CSS into `apps/web/src/design-tokens.css`. Semantic tokens (`--color-surface`, `--color-surface-raised`, `--color-accent`, `--color-accent-muted`, `--space-xs/sm/md/lg/xl`, `--radius-sm/md/lg`, `--shadow-card`, `--motion-ease`, `--motion-fast/medium/slow`). Every new surface uses tokens; existing surfaces migrate opportunistically.

**Type scale.** Inter is already loaded. Lock to a 1.25 ratio scale (12 / 15 / 19 / 24 / 30 / 38 px) so everything aligns.

**Color system.** Warm dark accent shift — move from blue-heavy (#2563eb, #60a5fa) to a warmer secondary (sage or terracotta) for the "this is an interior design product" cue. Primary stays blue for CTAs. One highlight color for surfaces under edit (warm amber). One error red. Nothing else.

**Motion language.** `framer-motion`-free — vanilla CSS transitions, respecting `prefers-reduced-motion`. 180ms for interactive feedback, 300ms for view transitions, 600ms for cinematic splat fly-throughs. Ease curves defined as tokens.

### Specific surfaces

**Scan pane redesign:**
- Captured frame thumbnails with depth-colored overlay option (viridis colormap), confidence as corner badges (green/yellow/red).
- Click any thumbnail → splat view flies to that camera.
- Upload progress as a ring around the thumbnail while the frame is still processing.
- "Generate splat" button shows status (queued/processing/ready) inline.

**Edit pane redesign:**
- Material picker pulling BOM catalog thumbnails (first concrete UI use of the asset catalog). Real paint colors, real flooring swatches, real product brand tags.
- Live OBB highlight when hovering a material on a surface.
- Drag a material onto a surface to stage an edit; confirm pill appears.
- Diff view showing what the pending edit changes (before/after values for position, rotation, material).

**Gallery redesign:**
- Before/after slider (reveal-on-drag, library-free in pure CSS with a clipped `::before` on the rendered image).
- Multi-view grid for the same edit (3 cards, one per captured viewpoint).
- Lighting-variation pills where available.
- Click-to-fullscreen with keyboard navigation.
- Materials list pinned at the bottom of a selected render — one row per material, thumb + name + brand + retailer link pulled from the asset manifest.

**Status / toast system:**
- Structured toast component (success/info/warn/error) replacing the current ad-hoc `#status` div.
- Job progress (photoreal, splat) shown as persistent toasts with progress rings.

### iPhone app target (SwiftUI)

The Swift Package at `ios/RoomViewCapture` ships the library pieces (FrameCaptureRecorder, CaptureBundleWriter, uploader). Showcase adds the app target that consumes them:

- **App structure.** Single SwiftUI app, three screens: scan, review, upload.
- **Scan screen.** Live ARKit view with RoomPlan overlay, confidence heatmap toggle, frame-coverage progress ring. "Stop capture" primary button.
- **Review screen.** Captured-frame scrub with depth preview, keyframe selection. "Upload" or "Scan more" secondary.
- **Upload screen.** Progress ring per asset (scene JSON, RGB, depth, confidence). Deep-link to the web editor when done.
- **Design alignment.** Shared visual language with the web editor — warm dark theme, same accent colors, same type scale translated to SF-adjacent metrics.
- **Testing.** UI test against a stub API. Swift-build CI job already exists.

### Deferred out of Track C

- Framework migration to React/Svelte. Not needed; the tokens approach delivers the quality.
- Storybook or a formal component library. Overkill for this surface area.
- Multi-theme support (light mode, high-contrast). Dark-only for Showcase.
- A full marketing site. The gallery itself is the marketing site.

---

## Week-by-week plan

### Week 1 — Contracts and scaffolding

**Goal.** Every new capability lands first as a contract + stub + fixture, so Tracks A/B/C can proceed in parallel without stepping on each other.

- Add `flux_inpaint_stack` to `PhotorealProviderKind` in [photoreal-providers.ts:56](../apps/api/src/photoreal-providers.ts:56). Resolve via `ROOMVIEW_PHOTOREAL_PROVIDER=flux_inpaint_stack`.
- Add `captured_viewpoint_id?: BookmarkId | null` to `RepaintSurfaceOperation` and `SwapFlooringOperation` in [api.ts](../packages/contracts/src/api.ts). When present, the render job uses the captured-frame pipeline; when absent, current behavior.
- Add `SurfaceMask` contract type to `packages/contracts/src/scene.ts`: `{ surface_id, viewpoint_id, mask_uri, mask_bytes_sha256, generated_at, generator_kind }`.
- Add `render_group_id?: string` to `PhotorealEntry` so multi-view renders from the same edit can be grouped in the gallery.
- Add new Python script `scripts/mask-service.py` with uv inline-deps header. Fixture mode returns a deterministic mask for a known `(scene_id, surface_id, viewpoint_id)`; real mode is a stub with TODO for SAM2 integration.
- Update `.env.example` with new provider kind and any new env vars.
- Unit tests for the new contract shapes and provider resolution.
- New verifier skeleton `scripts/verify-hero-render.mts` that exercises the full captured-viewpoint render pipeline with the deterministic stub.

**Verification.** `npm run check` passes. New provider kind is selectable. Fixture mask service returns a known mask for a known input.

### Week 2 — Track A first cut (SAM2-refined masks + Flux inpaint)

**Goal.** A real photoreal render of an ARKitScenes bedroom from a captured viewpoint, with a SAM2-refined mask and Flux-Inpaint backend.

- `scripts/mask-service.py` real mode: SAM2 via `segment-anything-2` package. Takes scene polygon as box prompt, returns refined mask PNG.
- New Python script `scripts/flux-render.py` with Flux.1-dev + IP-Adapter + ControlNet-Depth. Takes captured RGB, captured depth, mask, prompt, returns PNG. Backed by Modal for real runs; fixture mode for CI.
- Wire the new provider in the API: when `flux_inpaint_stack` is selected and a captured viewpoint is attached, call the mask service then the render service.
- End-to-end: ingest ARKitScenes bedroom → pick a wall → `repaint_surface` with `captured_viewpoint_id` → photoreal entry lands in the gallery.
- LPIPS preservation metric in the verifier (soft gate initially, hard gate at end of Week 3).

**Verification.** Hero render exists in the gallery for one ARKitScenes bedroom. Preservation metric ≥ 0.95 (pre-hard-gate).

### Week 3 — Track A polish + Track C design tokens

**Goal.** IC-Light relighting lands. Design tokens extracted. Scan pane gets its Showcase redesign.

- `scripts/iclight-pass.py` as a post-render relighting pass. Swap in or out via env flag; hard-requires the Flux output to exist.
- Multi-view consistency MVP: render the same edit from three captured viewpoints, tagged with shared `render_group_id`. First viewpoint anchors the style; subsequent viewpoints chain IP-Adapter on the first.
- Design tokens module `apps/web/src/design-tokens.css`. Extract all inline CSS from [server.ts:163](../apps/web/src/server.ts:163) into semantic tokens.
- Apply tokens to scan pane: depth-colored frame thumbnails, confidence badges, splat-status inline indicator.
- Hard-gate LPIPS ≥ 0.97 in the hero-render verifier.

**Verification.** `npm run check` green. Scan pane visibly improved. One hero render passes the hard preservation gate.

### Week 4 — Track B splat integration + Track C edit pane

- `scripts/splat-generate.py` with Splatfacto. Runs offline; splat artifact lands in the store.
- Web viewer loads splats via gsplat.js or mkkellogg/GaussianSplats3D at `LAYER_SPLAT=2`.
- Fixture splats for ARKitScenes and iPhone bedroom fixtures so the editor isn't empty without a backend.
- Edit pane redesigned with material picker pulling from asset manifest.
- Live OBB highlight on material hover.

**Verification.** Scan pane shows a splat, not just a shell, for at least one fixture. Material picker functional.

### Week 5 — iPhone app target + Track C gallery

- SwiftUI app target consuming the existing Swift Package. Three screens: scan, review, upload. Shared design language with web editor.
- Real-device install + end-to-end capture → upload → web-editor-renders-the-scan loop.
- Gallery redesign: before/after slider, multi-view grid, lighting-variation pills.
- Materials list pinned to selected renders.

**Verification.** iPhone build runs on a physical device. Full loop works. Gallery shows multi-view consistency for one edit.

### Week 6 — Cinematic paths + demo assembly

- Smooth Bezier camera paths through bookmarks. "Fly through" button in scan pane.
- Splat ↔ edit ↔ gallery transitions (300ms crossfade).
- Job progress toast system (photoreal/splat progress).
- Demo script assembly: two scanned rooms, three edits per room, hero gallery.
- Screenshot + video capture for [roadmap.md](roadmap.md) and [stretch.md](stretch.md).

**Verification.** Demo runnable end-to-end against real backends. Screenshots captured.

### Weeks 7–8 — Buffer + polish + MV-Adapter upgrade

- MV-Adapter integration for stricter multi-view consistency (upgrade over IP-Adapter chaining if it proves insufficient).
- Bug pass across all tracks.
- Edge cases: scenes with no captured frames, scenes with failed splat jobs, renders that fail the preservation gate.
- Demo dress rehearsal against a real iPhone.

**Verification.** Showcase gate met. Phase ships.

---

## Explicitly deferred — do not land in Showcase

- **Mesh-based wall/opening inference.** Roadmap open question #5. Track A's SAM2 masks make this less urgent; wall-fitting is a later quality upgrade.
- **Object-level `replace_object` with photoreal.** Requires novel-view consistency we're not promising yet.
- **Free-camera novel-view photoreal.** Captured viewpoints only for Showcase; novel views are what the splat is for.
- **Multi-room graphs and floorplan ingest.** Next killer-feature phase, not this one.
- **Real-time splat re-training.** Batch only.
- **LoRAs / per-material fine-tunes.** Bump Track A further but not required for the gate.
- **Framework migration** (React/Svelte on the web). Tokens approach is enough.
- **Light mode / high-contrast.** Dark-only.
- **Marketing site.** The gallery is the marketing site.

## How the three tracks advance the product

- **Scene acquisition (Track 1 of [stretch.md](stretch.md)).** Splat-primary viewer lands. iPhone app lands. Both were roadmap open items.
- **Design intelligence (Track 2).** Single-operation planner stays, but the render stack becomes production-grade. Multi-view consistency is the architectural primitive that Track 2's future work (multi-step edits, regenerative rooms) will lean on.
- **Professional outputs (Track 3).** BOM catalog stops being decorative metadata — it drives material thumbnails, prompts, color values, and appears in a user-visible materials list on every render. First real use of the catalog in the render path.

The killer feature ("keep my living room, redesign upstairs, render the whole house coherently") needs edits that are **surface-bound** (Route C), **style-preserving** (inpaint, not synth), and **materials-catalog-backed**. Showcase is the smallest phase that exercises all three in one flow.

## Risk register

- **Flux availability / cost.** Modal or Replicate cost per render matters at demo scale. Mitigation: aggressive caching keyed off `(snapshot_id, edit_hash, viewpoint_id)`; fixture mode for CI never hits the backend.
- **SAM2 mask quality on ARKitScenes data.** Synthetic shell walls may give a weak geometric prior. Mitigation: fall back to pure click-SAM2; re-scan one ARKitScenes bedroom with a real iPhone mid-phase if needed.
- **Splat generation compute.** Splatfacto needs a GPU. Mitigation: run offline on a single-session GPU box (rented or local); cache splats per scene.
- **iPhone app review / provisioning.** Can block the real-device build. Mitigation: start Week 5 with provisioning already sorted; TestFlight is the fallback.
- **Design overhead creeping.** Pretty is subjective and expandable. Mitigation: the tokens approach bounds the scope; every redesign has a "before screenshot → after screenshot" verification, not a taste debate.
