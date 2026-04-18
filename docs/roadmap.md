# RoomView Roadmap

*Living doc. Snapshot of where the project is, where it's going next, and the long arc.*

This doc is about trajectory. For the aspirational vision and track-by-track reasoning, see [stretch.md](stretch.md). For the MVP spec, see [mvp_duet.md](mvp_duet.md). For demo ops, see [demo-runbook.md](demo-runbook.md).

## Current state

**Shipped to date.** The MVP loop is end-to-end: RoomPlan capture → ingest → canonical `Scene` JSON → three.js editor with planner-driven edits → photoreal via OpenRouter/SDXL conditioning → immutable photoreal gallery → optional splat sidecar. 166 unit tests plus per-feature verifiers back it. See `npm run check`.

**Just landed — Milestone 1 (real scan bundle).** The iPhone can now post not just RoomPlan geometry but the raw ARKit evidence that underlies it: per-frame RGB, float32 depth (meters), ARKit confidence, 4x4 camera transform, and intrinsics. These arrive via `POST /captures/{scene_id}/frames`, get persisted as binary artifacts alongside the scene, and automatically materialize a `CameraBookmark` per keyframe so the existing render-pane UI picks them up without special-casing. The web editor's scan pane now shows a captured-views strip with thumbnails and depth/confidence links.

Verifier: `npm run verify:capture-bundle` exercises the full pipeline against an in-memory service using synthetic frames — no phone required for CI.

Swift Package (`ios/RoomViewCapture`) ships the pieces an app target needs: `FrameCaptureRecorder` (downsamples ARFrames to evenly-spaced keyframes), `NumpyEncoder` (writes `.npy` v1.0 so the Phase 0 bench consumes the same depth files), `CaptureBundleWriter` (disk bundle format), and `uploadCaptureFrames` on the existing uploader.

**What the MVP does not yet have.** No iPhone app target (the Swift Package is a library; the user's app target is the next build). No real-scan Phase 2 — edits still render against synthetic conditioning, not captured evidence. No multi-room, no floorplan ingest, no Android. Everything in `stretch.md` v1.1+ is out of scope for now.

## Near-term direction

The next two milestones take the scan bundle we just landed and turn it into a working photoreal edit loop.

**Milestone 2 — Ingested bundle wired into the render bench.** Once the iPhone app lands, a real capture produces `.npy` depth files that the Phase 0 bench already accepts via `--depth-source manifest` ([phase0-render-bench.py:411](../scripts/phase0-render-bench.py:411)). Swap MiDaS for real ARKit depth on one captured frame, compare output quality against the synthetic baseline, decide whether to keep MiDaS as a fallback. This is a measurement milestone, not a feature ship.

**Milestone 3 — Hero render from a captured camera.** The first user-facing payoff. Pick a `CameraBookmark` that was materialized from a captured frame. Apply one supported edit — `repaint_surface` on a wall, or `swap_flooring`. Render a photoreal image using: the captured RGB as reference, the captured depth as ControlNet conditioning, a surface-projection mask for the edited region, and an edit-specific prompt. The UX promise: "keep my room exactly, repaint one wall." Scope is intentionally narrow — one view, walls or floors only, captured viewpoints only (no novel views).

Why captured-viewpoint-first: with real reference RGB and matching depth, the model is editing a known view rather than hallucinating a new one. This is the easier version of the photoreal problem and the one worth shipping first.

## Explicitly deferred (Milestones 4+)

From the Phase 1/Phase 2 planning discussion, the following are deliberately **not** in the next two milestones:

- Arbitrary novel-view photoreal rendering
- Free-camera consistency
- Object move / replace with photoreal rerender
- Rich evidence index beyond captured frames (e.g. optical-flow between frames, point-cloud fusion)
- UV surface texturing pipeline
- Learned geometry add-ons (inpainting missing walls, etc.)
- Commerce-grade material taxonomy
- Multi-room support

Each is valuable. None unblock "scan a room, repaint a wall, see it rendered."

## Long-term vision

The shape of the product three years out.

**The killer feature.** A homeowner says: *"Keep my living room and kitchen as they are. Redesign my upstairs — instead of three small bedrooms, make it two bedrooms and a home office, with the primary suite on the east side."* The system works from a scan of the current home and a generative model for the redesigned portion, returns a new floorplan for the edited part, preserves the untouched part exactly, renders the whole thing photoreal, and hands back a materials list a contractor can act on. See [stretch.md](stretch.md) for the full argument.

**Three tracks** from `stretch.md` that this project advances along:

- **Scene acquisition.** Today: iPhone RoomPlan. Next: improved splat editing, floorplan ingest, Android capture via ARCore, multi-room graphs. The canonical `Scene` schema is already designed to absorb floorplan and synthetic input without migration.
- **Design intelligence.** Today: single-operation planner (move/rotate/replace/repaint/swap_flooring). Next: multi-step edits, regenerative room design ("redesign this bedroom as a nursery"), constraint-aware layout generation.
- **Professional outputs.** Today: photoreal gallery + BOM-adjacent asset metadata. Next: USD/DXF export, contractor-ready specs, material ordering integration.

The killer feature lands when all three tracks mature enough: multi-room scanning, regenerative design across rooms, coherent whole-home photoreal output with a materials list.

**Where Milestone 1 fits in this arc.** It's foundational for Track 1 (scene acquisition) and it unblocks the photoreal branch of Track 3 (professional outputs). Until we had raw scan evidence in the scene record, every photoreal render was synthetic; now the reference frame can come from the physical room. The shift from "edit a synthetic proxy of the room" to "edit the room itself" is the whole point.

## Open architectural questions

A running list of things that need a decision but don't block current milestones.

1. **Depth encoding on the wire.** Today the API accepts base64-encoded `.npy` bytes inside JSON. For larger captures (tens of frames, 10 MB+ depth each), this will balloon requests. Candidate fix: switch to multipart, or move to direct uploads to a blob store with signed URLs. Current approach is fine for Milestone 1 scale.
2. **Pose convention documentation.** `camera_transform` is 4x4 column-major, ARKit's world frame. This is stated in the contract comments but not in a canonical spec doc. Before Milestone 3 ships surface projection, pin this down in a short reference.
3. **Captured-frame retention.** Scenes can accumulate captured frames across re-scans. No GC strategy yet. Not urgent.
4. **Artifact-store namespacing.** `CapturedFrame` reuses the `_artifacts/photoreal/` path. Semantically fine today (it's a generic binary store), but when we want real lifecycle rules per asset kind (retention, access control, pre-signed URLs), we'll split.
