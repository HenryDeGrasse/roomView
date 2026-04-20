# Graph + Agent: 4-phase plan

Author: 2026-04-20 (pre-sleep work chunk follow-up)
Owner: Henry
Status: Phases 1–3 implemented; Phase 4 partially implemented (event log + endpoints shipped; preference consumption by the agent not wired).

**Current shipped state (2026-04-20 update):**

| Phase | Planned | Shipped | Evidence |
|------|------|------|------|
| 1 — Read-only graph | ✅ | ✅ | [scene-graph.ts](../apps/api/src/scene-graph.ts) (1216 LOC), `GET /scenes/:id/graph`, `GET /dev/fixtures/:id/graph`, SVG overlay + `setGraph`/`setGraphVisible` in [layout-view.js:1064](../apps/web/src/layout-view.js:1064), `#graph-toggle` button. |
| 2 — Constraint engine | ✅ | ✅ | [constraint-engine.ts](../apps/api/src/constraint-engine.ts) (485 LOC) with 7 registered constraints, `GET /scenes/:id/constraints`, constraints card at [server.ts:3452](../apps/web/src/server.ts:3452). |
| 3 — LLM agent | ✅ | ✅ | [graph-agent.ts](../apps/api/src/graph-agent.ts) (806 LOC), `POST /scenes/:id/graph-agent` + fixture variant, `#graph-agent-button` "Ask agent" and `submitGraphAgent()` at [server.ts:2131](../apps/web/src/server.ts:2131), plan cards with Apply at [server.ts:3332](../apps/web/src/server.ts:3332). |
| 4 — Feedback loop | ✅ sketched | ⚠ partial | [feedback-log.ts](../apps/api/src/feedback-log.ts) (166 LOC) + `POST/GET` event routes at [server.ts:121](../apps/web/src/server.ts:121), writing to `.pi/feedback.jsonl`. **Not yet wired:** `derivePreferences()` output is not prepended to `buildSystemPrompt()` in graph-agent.ts, so the loop does not yet close. |

The section bodies below are the original design — kept for design-intent provenance. Known deltas from what shipped:

- The original Phase 3 plan listed `commit_plan` as a tool; the shipped agent is dry-run-only and the UI's "Apply" button commits through the existing planner/apply pipeline instead (safer — matches the "never commits without user approval" policy).
- `find_paths` (A* over floor voronoi) was listed as a tool; shipped agent exposes `find_free_spots` instead.
- The Python `rederive-hard-violations.py` was planned to retire. It still exists but is no longer called in the ingest pipeline — the TS constraint engine is the canonical source.

## Why this, why now

The splat + mesh + footprint pipeline gives RoomView a **geometrically truthful** model
of the room. The next unlock isn't more pixels — it's **semantics**. "Bed against west
wall, two storage units flanking it, door opens onto the west closet, path from door
to bed blocked by the chair." That sentence is a graph. Every interesting thing you
can do — constraint violations, agentic edits, layout generation, VR-style narration —
falls out of having that graph cheaply at hand.

We ship it in four phases so each phase is individually useful:

| Phase | Deliverable | ~Time | Unlocks |
|------|------|------|------|
| 1 | Read-only spatial graph derived from scene.json | 1 week | Viewer overlay + developer introspection |
| 2 | First-class constraints, not ad-hoc rules | 1 week | Layout quality scoring, plan explainability |
| 3 | LLM agent using graph + constraints as tools | 1-2 weeks | "Move the chair so the door can open", "Can I fit a desk?" |
| 4 | Online feedback loop | ongoing | Preference learning, autonomous suggestions |

---

## Phase 1 — Read-only spatial graph (this commit)

### Scope

Build a **pure-derivation** graph on top of `scene.json`. No mutations, no cache state,
no planner coupling. Everything derived from geometry already in the scene.

The graph is:

- Computed on demand (`GET /scenes/:id/graph` + `GET /dev/fixtures/:id/graph`)
- Embarrassingly parallel with no scene-wide side effects
- A mirror of current state — swap scene.json, graph changes
- Expressed in room coordinate frame (XY on floor plane, +Z up)

### Node kinds

All nodes carry `node_id`, `kind`, `label`, and kind-specific metadata.

- **`floor`** — the room's floor polygon. Exactly one.
  - `polygon`, `area_m2`, `bounds`
- **`ceiling`** — the room's ceiling plane. Zero or one.
  - `height_m`
- **`wall`** — a named wall (NOT an individual Surface segment). One per `named_wall_refs[]`.
  - `wall_ref_id`, `name`, `azimuth_degrees`, `inward_normal_xy`
  - `segments`: floor-plan polyline endpoints that belong to this wall (derived by
    matching floor-polygon edges to the wall's inward normal)
  - `length_m`
- **`opening`** — a door / window / closet_door.
  - `opening_id`, `type`, `host_wall_node_id`, `rect_on_surface`, `keepout_zone`
  - `floor_segment`: the portion of the wall's floor segment that the opening covers
  - `ingress_polygon`: a 0.9m rectangle extending inward from the opening on the
    floor (used by clearance reasoning in Phase 2)
- **`object`** — a `SceneObject`.
  - `object_id`, `class`, `obb`, `yaw_degrees`, `footprint_polygon`
  - `forward_vector_xy`: unit vector in room coords pointing from the object's
    center along +x local (defines which way a sofa or chair "looks")
  - `tall`: boolean convenience (`obb.size_z > 1.5 m`); distinguishes wardrobes
    from nightstands when classes are the same
- **`fixed_element`** — architectural objects (radiators, built-ins). Treated like
  objects for adjacency but tagged `mobility: fixed`.

Every node carries `provenance` showing whether it came from RoomPlan, the mesh
pipeline, or an inferred-from-geometry step.

### Edge kinds

Each edge has `from_node`, `to_node`, `kind`, `symmetric` (bool),
`strength ∈ [0, 1]`, and `evidence` (the metric values that produced it —
essential for debugging and for the future LLM agent that will want to
understand *why* an edge exists).

| Kind | Direction | Definition |
|------|-----------|-----------|
| `SUPPORTS` | surface/obj → obj | `support.support_entity_id` exact match. Floor supports every floor-supported object; walls support wall-mounted art; objects support stacked things. |
| `HOSTED_ON` | obj → wall | `host.host_surface_id` resolves to a named wall. Emitted even when the object's `support_kind` ≠ "wall" (a bed flush-to-wall is floor-supported but wall-hosted). |
| `CONTAINS` | wall → opening | `opening.host_surface_id ∈ wall.surface_ids`. |
| `ADJACENT_TO` | obj ↔ obj | Polygon-to-polygon gap ≤ 15 cm AND centroids within `Σ half_diag + 0.15 m`. Skipped when `COLLIDES` is emitted instead. |
| `COLLIDES` | obj ↔ obj | Mesh-footprint polygon intersection area > 0.05 m² (same threshold as hard violation). Also publishes a `VIOLATES` edge to a synthetic `hard_violation` node for UI. |
| `FACES` | obj → (obj \| wall \| opening) | Object's forward vector dot normalized direction-to-target > 0.6 AND Euclidean distance < 3 m AND line-of-sight (target not occluded by another object's footprint). |
| `PARALLEL_TO` | obj → wall | Object yaw parallel or perpendicular to wall azimuth within 10°. This explains why a storage reads as "flush to the north wall" even when RoomPlan didn't set `host`. |
| `NEAR_OPENING` | obj → opening | Object footprint within 0.5 m of opening's floor segment. |
| `OBSTRUCTS` | obj → opening | Object footprint overlaps opening's ingress polygon. |
| `FLANKS` | obj ↔ obj | Mutual adjacency + yaw within 20° + z-axis size ratio ∈ [0.7, 1.4]. Typically surfaces the two nightstands around a bed. Not emitted when either side is the bed itself. |

Edges are computed independently per kind so we can A/B individual rules in Phase 2.

### Failure-mode checklist (preempted at implementation time)

1. **Missing `footprint_polygon`** → fall back to OBB-derived rectangle.
2. **Zero-size OBB** → skip node, add warning `DEGENERATE_OBB`.
3. **NaN yaw** → normalise to 0, warn.
4. **Circular support chain** (A supports B, B supports A) → DFS with visited set, break on cycle, warn.
5. **Orphan `support_entity_id`** (points to non-existent entity) → skip edge, warn.
6. **Empty scene** → return graph with just `floor` + `ceiling`, no warnings.
7. **Floor polygon non-convex / > 20 vertices** → the wall-segment matcher uses
   per-edge azimuth comparison; no convex assumption is required here. Polygon
   math reuses `overlap-policy.ts` which handles convex clipping + non-convex
   point-in-polygon.
8. **One `named_wall_ref` spanning multiple surface IDs** → already handled; we
   walk `surface_ids[]`.
9. **Wall with zero matching floor edges** (malformed scene) → wall node still
   emitted, `segments: []`, warn `WALL_NO_FLOOR_EDGE`.
10. **Opening outside its host wall segment** → clamp `rect_on_surface` to the
    wall segment length when computing `floor_segment`, warn.
11. **Very large scenes (N > 100)** → adjacency rules are currently O(N²). A
    bounds-based prefilter brings real-world cost down; swap to a uniform grid if N ever exceeds 100.
12. **Degenerate forward vector** (sofa yaw NaN) → skip `FACES` edges for that
    node.
13. **Yaw wrap around ±180** → always normalise via `(((yaw % 360) + 540) % 360) - 180` before comparing.
14. **Stale graph when scene changes under us** → `computed_at` + `scene_version`
    on every response. Clients pin version; mismatch means re-fetch.
15. **Opening `host_surface_id` not in any named wall's `surface_ids`** → emit
    opening as a `wall:unknown` sentinel with a warning; still appears in graph.
16. **Duplicate IDs** — scene contract doesn't allow; guard anyway with a Set
    and warn on collision.

### API contract

```
GET /scenes/:scene_id/graph
GET /dev/fixtures/:fixture_id/graph

200 OK
{
  "graph": {
    "scene_id": "...",
    "scene_version": 1,
    "computed_at": "2026-04-20T07:00:00.000Z",
    "coordinate_frame": "room_xy_z_up",
    "room_summary": {
      "room_id": "...",
      "room_type": "bedroom",
      "floor_area_m2": 20.5,
      "ceiling_height_m": 2.747,
      "object_count": 12,
      "opening_count": 4,
      "wall_count": 4
    },
    "nodes": [...],
    "edges": [...],
    "warnings": [...]
  }
}
```

Auth identical to `/scenes/:scene_id` (session required for live scene; fixtures
open over `/dev/fixtures/...`).

### UI surface in Phase 1

- **Layout 2D overlay** — toggleable button overlays edges on the layout pane,
  coloured by kind (HOSTED_ON amber, ADJACENT_TO teal, COLLIDES red, FACES
  indigo, NEAR_OPENING violet). Edges run between footprint centroids with a
  slight curvature so overlapping pairs remain readable.
- **Selection "Relations" card** — when an object is selected, a card in the
  right drawer lists every edge touching that node, grouped by kind, with the
  neighbour name + its evidence (distance, yaw delta, overlap area).
- **Stats badge** — small counters (`N nodes · M edges`) next to the existing
  violation summary.

### Success criteria for Phase 1

- Bedroom110-4 fixture produces a graph with:
  - floor, ceiling, 4 walls, 4 openings, 12 objects
  - HOSTED_ON for every object RoomPlan flagged `flush_to_wall`
  - ADJACENT_TO around the bed and storage clusters
  - No COLLIDES (matches hard_violations count after recent overlap-policy fix)
  - 0 warnings
- Graph endpoint returns in < 50 ms for 12-object scenes on local dev
- UI overlay highlights every edge without visual tangling
- Unit tests cover: degenerate OBB skipped, orphan support, opening without
  host wall, bed-nightstand FLANKS detection, line-of-sight occlusion

---

## Phase 2 — First-class constraints

*Shipped. Engine in [constraint-engine.ts](../apps/api/src/constraint-engine.ts); original design below.*

The current `overlap-policy.ts` implements two physics rules inline. Phase 2
moves validation into a rule engine that runs against the graph.

### Constraint primitives

- **Predicate** — a function `(graph) → ConstraintEvaluation[]`. Examples:
  `door_has_walkway(min_width=0.9m)`, `bed_anchored_to_wall`,
  `chair_does_not_block_path(from="door", to="bed")`.
- **ConstraintEvaluation** — `{ constraint_id, status: "ok|soft_warn|hard_fail", evidence, edge_ids }`.
  The `edge_ids` field links the evaluation back to graph edges so the UI can
  highlight the exact failure.
- **Constraint catalogue** (in `packages/contracts/src/constraints.ts`, stub already exists):
  - `no_overlap_in_bounds` — becomes the current hard-violation rule.
  - `opening_preserved` — sum of ingress clearances above floor threshold.
  - `class_specific_clearance` — e.g. sofa seating depth, desk chair pull-out.
  - `sofa_faces_focal_element`, `desk_near_window` — existing focal-element
    concepts, now evaluated via `FACES` + `ADJACENT_TO` edges.
  - `primary_path_not_serpentine` — path from door to bed without detours.

### Engine shape

```ts
interface ConstraintEngine {
  register(definition: ConstraintDefinition): void;
  evaluate(graph: SceneGraph): ConstraintReport;
  explain(evaluation: ConstraintEvaluation): string;
}
```

Evaluation is pure and deterministic. Re-running `evaluate` on the same graph
always produces the same report, so the planner can use it as a reward signal.

### Replaces today's `hard_violations[]`

`derived_state_cache.hard_violations` becomes a *projection* of the constraint
report filtered by `severity: hard`. The Python `rederive-hard-violations.py`
script retires; the TS constraint engine is the single source of truth, invoked
from the ingest pipeline and from the web server's live re-compute path.

### Surface tests we'll add

- Moving the bed off the wall violates `bed_anchored_to_wall` softly (warning,
  not a failure — beds are movable; this is just layout guidance).
- Inserting a chair into a door's ingress polygon triggers `opening_preserved`
  hard-fail with `edge_ids` pointing at the `OBSTRUCTS` edge.
- Every existing fixture produces the same hard-violation count in Phase 2 as
  it does today (regression guard).

### Risks

- Constraint explosion. Catalogue stays small, curated, human-readable.
- Runtime cost on large scenes. We cache per-constraint evaluations keyed by
  the subset of nodes/edges each constraint reads.
- UI noise. Soft warnings get a muted colour; hard fails keep the red chip.

---

## Phase 3 — LLM agent with graph + constraint tools

*Shipped. Agent in [graph-agent.ts](../apps/api/src/graph-agent.ts); UI chat pane at [server.ts:2131](../apps/web/src/server.ts:2131); original design below.*

### Agent architecture

An OpenRouter-backed LLM (OpenAI, Claude, Gemini — we already have the
abstraction in `apps/api/src/ai-planner.ts`) operates a tool surface that
exposes read-only queries and mutation proposals.

**Tools exposed to the agent:**

1. `query_graph({ subject?, relation?, object?, class? })` — Cypher-lite lookup
   over the graph. Returns matching node IDs + evidence.
2. `describe_node(node_id)` — full node detail + its neighbourhood.
3. `evaluate_constraints()` — current constraint report.
4. `propose_move(object_id, target_position, target_yaw)` — runs the existing
   preview pipeline, returns the diff in constraint report.
5. `commit_plan(plan_id)` — applies the last preview via the existing
   `/scenes/:id/apply` endpoint.
6. `find_paths(from_node, to_node)` — A* over the free-space voronoi graph
   derived from floor polygon minus object footprints.

All tools are stateless except `propose_move` (holds a preview token) and
`commit_plan`.

### Environment variables (already in `.env`)

- `OPENROUTER_API_KEY` — existing.
- `OPENROUTER_MODEL` — existing, model selector.
- `ROOMVIEW_AGENT_MAX_STEPS` — new, default 12.
- `ROOMVIEW_AGENT_TEMPERATURE` — new, default 0.2.
- `ROOMVIEW_AGENT_DRY_RUN` — new, default `true`; false enables `commit_plan`.

### Prompt structure

System prompt includes:

- Scene coordinate frame explainer
- Constraint catalogue (short names + intent)
- Tool schemas
- A policy block: never commit without a preview that improves (or preserves)
  the constraint score; always cite the edge IDs you used.

### Flows to validate

- **Diagnostic**: "Why is the chair in violation?" → `query_graph(object=chair)`,
  `evaluate_constraints(chair)`, human-readable answer citing the COLLIDES /
  OBSTRUCTS edge.
- **Planning**: "Tuck the chair under the desk." → `query_graph(FACES, desk)`,
  `propose_move`, diff report, commit if improved.
- **Discovery**: "Could I fit a 180×80 desk against the east wall?" →
  `query_graph(wall=east)`, sample positions along the wall, `propose_move`
  each, return best.

### Risks to design around

- **Hallucinated object IDs** → tools validate IDs and return `UNKNOWN_NODE`
  rather than silent failure.
- **Infinite loops / runaway cost** → max step budget, tool-call budget,
  watchdog timeout.
- **Destructive commits** → `ROOMVIEW_AGENT_DRY_RUN=true` default; when false,
  the agent can only commit previews it itself generated in the same session
  and every commit logs the preview diff.
- **Coordinate drift** → the agent never emits world-coord numbers directly;
  it calls `propose_move` with room-frame positions, which the engine
  validates.

---

## Phase 4 — Online feedback loops

*Partially shipped: event log + endpoints in [feedback-log.ts](../apps/api/src/feedback-log.ts); the "prepend preferences to agent system prompt" half is not wired yet (see status table at top).*

### What the agent learns from

1. **Direct demonstrations** — when the user drags an object, emit
   `LayoutEvent { object_id, from_obb, to_obb, constraint_delta }`. These
   stream to a small local store (SQLite or JSONL in `.pi/feedback.jsonl`).
2. **Accept/reject on proposals** — every agent-proposed plan is either
   committed or dismissed; log both.
3. **Explicit ratings** — thumbs up/down in the UI writes a row.

### How it closes the loop

- Preference snippets (system prompt extension) accumulate from logged events:
  *"User consistently prefers beds against windows over beds against interior
  walls. User rejected storage-next-to-bed arrangements in the last three
  sessions."*
- Each new conversation reads the latest preferences and prepends them.
- No online training of the base LLM; preferences live in prompt context.

### Telemetry — what we'd actually measure

- `time_to_first_usable_plan` (seconds from user message to committed plan)
- `constraint_improvement_delta` (did the plan fix anything?)
- `user_accept_rate` (fraction of proposals the user commits)
- `violation_surface_rate` (fraction of sessions that reach zero hard fails)

### Open questions

- Whether to persist preferences per-user or per-room. Probably per-user with
  room tags.
- Whether preference extraction itself is LLM-based (pre-conversation summariser)
  or a simple heuristic pass. Start heuristic, upgrade later.
- Safety: avoid anchoring on a single rejection. Use a minimum event count
  (say 3) before lifting a preference into the prompt.
