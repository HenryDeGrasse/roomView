I only found `docs/mvp_duet.md` in the repo; there is no existing iOS app, web app, backend, asset pipeline, or test scaffold. So this PRD is being reviewed as a greenfield build, not as an iteration on an existing codebase.

Blocking issues:
- The plan omits foundational bootstrap work for an empty repo. There is no step for choosing/creating the project structure, shared type/schema package, backend framework, web rendering stack, iOS app scaffold, storage layer, job queue, object storage, or CI/test setup. Every milestone currently assumes that scaffolding already exists.

- The cross-device handoff/privacy story is undefined. The core flow says the user scans on iPhone and then opens the scene on a laptop with `scene_id`, while privacy says there is no public sharing. The plan needs an explicit access model: auth, pairing, magic link/QR flow, or scoped share token. Otherwise the primary capture→editor flow is not implementable safely.

- The canonical schema is incomplete and internally inconsistent with the required behavior. Important referenced types are undefined (`ConstraintSpec`, `FixedElement`, `Polygon2D`, `RectOnSurface`, `Pose3D`, `OBB3D`, derived-state shapes). Also:
  - `Object` lacks anchor/support metadata needed for `ANCHOR_VIOLATION`
  - parent/child semantics are underspecified despite `parent_id`, `include_children`, and `PARENT_MOVE_VIOLATION`
  - `selection_context_summary` appears to be UI/session state, not canonical scene state
  - `focal element` and “north wall” are used later but are not represented in the model

- Versioning/undo semantics need clarification before implementation. The PRD says `scene_version` only increments for committed edit plans, but the scene document also changes when photoreal gallery entries or splat assets are attached. That means the canonical scene can mutate without a version bump. Undo is also ambiguous: does it restore an old snapshot in place, or create a new latest version pointing to a prior state? This affects stale-tab handling, gallery linkage, and API behavior.

- The `/plan` → `/apply` contract is race-prone and underspecified. The plan does not define whether the client can modify plans, how the server prevents tampering, how idempotency works, or how version conflicts are handled between preview and apply. It also mixes `generate_photoreal` and `undo_last_change` into typed operations even though both already have separate endpoints and special versioning behavior.

- Constraint validation is not specified deeply enough to be deterministic. The plan depends on geometric/pathfinding rules, but it does not define:
  - 2D vs 3D collision assumptions
  - per-class footprint/clearance behavior
  - access-zone geometry derivation
  - tolerances for overlap and wall adjacency
  - whether rugs/lamps/chairs participate in path blocking the same way as large furniture
  - how “desk under the window” or “against the wall” resolves to a concrete pose
  - how `add_object` and `replace_object` pick a placement before validation  
  As written, several validator outcomes will be implementation-defined.

- Some required behaviors reference concepts that do not exist yet and need explicit definition:
  - “north wall” in exit criteria requires a room/world orientation model
  - `SC-2 Sofa faces focal element` requires a defined focal-element source
  - render-pane surface selection requires a concrete surface-picking strategy
  - RoomPlan “parametric preview” in a web scan pane assumes a web-viewable representation, but no format/render path is specified

- The rendering/photoreal architecture is too vague for a core MVP feature. The PRD assumes:
  - a fast interactive quick renderer
  - a high-res conditioning renderer for photoreal
  - shared camera semantics between web and backend
  - structural consistency across repeated photoreal generations
  - median photoreal latency under 10s  
  But it does not name the rendering stack, provider, seed/control strategy, or where high-res renders are produced. That makes the photoreal requirements hard to evaluate for feasibility.

- The asset pipeline is assumed, not planned. The MVP depends on a curated ~500-item glTF library with class/style metadata, dimension normalization, proxies, and retrieval scoring, but the repo contains no assets or ingestion tooling. There needs to be an explicit step for sourcing, normalizing, tagging, validating, and packaging those assets before quick render/add/replace can work.

- Async job behavior and failure states are underspecified. The system depends on long-running splat and photoreal jobs, but there is no defined job-state schema, retry/cancel policy, deletion behavior while jobs are running, or UI behavior for failure/timeout states. Since the scan pane and gallery depend on these jobs, this needs to be specified earlier.

- Testing/evaluation is introduced far too late. Week 8 is too late to add the eval harness when the PRD’s main risks are schema correctness, RoomPlan ingestion quality, constraint validity, planner determinism, and photoreal consistency. The plan needs early fixtures and regression suites for:
  - RoomPlan ingestion
  - geometry/constraint cases
  - invalid-edit reason codes
  - planner prompt benchmarks
  - performance budgets

Verdict: changes_requested