# Graph-agent: next four steps

Author: 2026-04-20
Status: Planned. Phases 1–4 of [graph-agent-plan.md](../graph-agent-plan.md) have shipped; this doc captures the follow-ups that convert the MVP bundle into a production-trusted feature.

Four steps, ordered by dependency (not priority). Each is independently shippable; each ends with a verifier that can be added to `npm run check`.

---

## Step 4 — Cache graph + constraints on `DerivedState`

**Problem.** `POST /scenes/:id/graph-agent` rebuilds the scene graph and re-evaluates all seven constraints on every call. For the ~25-object bedroom fixture this is a few ms, but a chatty agent session on a ~50-object room would rebuild 10+ times and the graph-agent's own `propose_move` tool rebuilds a *second* graph on each invocation. Pre-computing at ingest + after each apply collapses that to one rebuild per mutation.

**Where it changes.**
- [packages/contracts/src/scene.ts:365](../../packages/contracts/src/scene.ts:365) — extend `DerivedState` with two optional fields: `graph?: SceneGraph | null` and `constraint_report?: ConstraintReport | null`. Optional so existing fixtures remain valid.
- [apps/api/src/roomplan-ingest.ts](../../apps/api/src/roomplan-ingest.ts) — after the scene is finalised in `observeSync()`, compute the graph + constraint report and store them on `derived_state_cache`. Reuse existing hooks that populate `selection_context_summary`.
- [apps/api/src/mutation-engine.ts](../../apps/api/src/mutation-engine.ts) — after each successful `apply()`, recompute graph + constraints and update the cache. Cache coherence is trivial because `DerivedState` is already rebuilt per version.
- [apps/api/src/server.ts:286](../../apps/api/src/server.ts:286) — `/graph` and `/constraints` routes prefer the cache; fall through to `buildSceneGraph` + `evaluate` only if the cache is empty (import-from-fixture path, migration).
- [apps/api/src/graph-agent.ts:143](../../apps/api/src/graph-agent.ts:143) — `run()` reads from cache if present; `propose_move`'s cloned-scene rebuild is unavoidable and unchanged.

**Risks.**
- Scene contract change. Fields are optional, so legacy `scene.json` files continue to load — but `Scene` JSON serialisation round-trip tests will start including graph + constraints. Adjust fixture snapshots or exclude the new fields from snapshot comparison.
- Memory. A 25-object graph is ~30 KB; 50 objects is ~200 KB. Fine in-process; worth noting before we start persisting derived state to R2.

**Verifier.** `scripts/verify-graph-cache.mts`: ingest a fixture, assert `scene.derived_state_cache.graph` is non-null and matches a fresh `buildSceneGraph(scene)` structurally. Apply one `move_object` op, assert the cache updated and the two hard-violation counts match.

**Effort.** ~2–3h including the fixture snapshot updates.

---

## Step 5 — Relations card in the selection sidebar

**Problem.** The graph overlay at [layout-view.js](../../apps/web/src/layout-view.js) shows *all* edges globally. When the user selects one object, they still have to visually trace which edges touch it. The chat sidebar already has a `.chat-selection__graph` DOM hook ([design-tokens.css:1883](../../apps/web/src/design-tokens.css:1883)), but the server.ts template doesn't yet populate it.

**Spec.** When an object is selected, the sidebar card lists every graph edge touching that node, grouped by `edge.kind`, with the evidence inline. Example:

> **Selected: bed (obj-bea6)**
> - **HOSTED_ON** → floor · contact_area 3.1 m²
> - **FLANKS** (2) · nightstand-a (0.18 m gap), nightstand-b (0.22 m gap)
> - **ADJACENT_TO** (1) · west wall (contact 1.84 m)
> - **COLLIDES** (1) · rug · overlap 0.42 m² · **hard violation**

Violations render with the same chip treatment as the existing `.chip` class; clicking a related node highlights it in the layout pane (selection bus already exists).

**Where it changes.**
- [apps/web/src/server.ts](../../apps/web/src/server.ts) — extend the selection-card renderer to consume the graph fetched alongside `/scenes/:id`. The template hook exists; just needs the data wire.
- If the graph isn't loaded yet (race between scene fetch + graph fetch), render a one-line "Loading relations…" placeholder.

**Risks.** Edge count explodes on cluttered rooms. Cap the list at 8 per kind with a "show all" affordance; deprioritise low-confidence kinds (`PARALLEL_TO` at the bottom).

**Verifier.** Playwright-equivalent via the existing preview server: load `capture-bedroom110-4`, select the bed, assert the DOM contains `data-edge-kind="FLANKS"` entries with at least two adjacent nightstand labels. Manual check in the preview covers the hard-violation chip.

**Effort.** ~1.5h.

---

## Step 6 — Promote the graph overlay to first-class

**Problem.** `#graph-toggle` exists and works, but it's a discoverable-by-accident button in the overlay head actions. For the overlay to become a debug surface worth depending on, it needs a keyboard shortcut, a tooltip explaining what the edge kinds mean, and a mention in [demo-runbook.md](../demo-runbook.md).

**Spec.**
- Keyboard shortcut `G` toggles graph visibility when focus is in the layout pane (ignore when typing in the chat input — check `document.activeElement.tagName`).
- Hover tooltip on `#graph-toggle` explains the seven edge kinds with one-line descriptions (copy from `GRAPH_CONSTANTS` comments in [scene-graph.ts:47](../../apps/api/src/scene-graph.ts:47)).
- Edge-kind filter chips below the toggle (use `setGraphKindFilter` which already exists on the layout-view public surface). Default-on: `COLLIDES`, `FLANKS`, `NEAR_OPENING`. Default-off: `PARALLEL_TO`, `ADJACENT_TO` (too chatty at a glance).
- Update [demo-runbook.md](../demo-runbook.md) with a "Debug surfaces" section listing: graph overlay (G), constraint report (`/constraints`), feedback log (`.pi/feedback.jsonl`).

**Risks.** Key-chord collision — check that `G` isn't already bound. Current layout pane has no global key handlers, so it's clear.

**Verifier.** None automated — visual inspection in the preview server. A short manual checklist lands in demo-runbook.md.

**Effort.** ~1h.

---

## Step 7 — `verify:graph-agent` in CI

**Problem.** The three new unit test files (`scene-graph.test.mts`, `constraint-engine.test.mts`, `graph-agent.test.mts`) already run inside `verify:unit`, and `verify:unit` is already in `npm run check`. What's missing is an *integration* verifier that exercises the full HTTP path: ingest → graph endpoint → agent endpoint → proposed plan shape.

**Spec.** A new `scripts/verify-graph-agent.mts` that:

1. Boots the API in-process (same pattern as `verify-mutation-pipeline.mts`).
2. Ingests `fixtures/roomplan/capture-bedroom110-4-20260420-005336`.
3. Hits `GET /scenes/:id/graph` — asserts non-empty nodes + edges, all edge evidence fields present.
4. Hits `GET /scenes/:id/constraints` — asserts exactly seven constraint definitions evaluated, at least one has a cited `edge_id`.
5. Hits `POST /scenes/:id/graph-agent` with `{ question: "what's colliding?" }` — no API key, so it uses the deterministic fallback. Asserts the response has `mode: "dry_run"`, at least one cited evaluation, and the steps array is well-formed.
6. Appends three drag events via `POST /dev/feedback`, re-runs the agent, asserts the preference block eventually surfaces in a live-LLM path (skipped if `OPENROUTER_API_KEY` is absent — or use a mock).

Add to `scripts/` and wire into the `check` script alongside `verify:unit`.

**Risks.** The deterministic fallback returns a hand-rolled summary — its shape is stable now but brittle to future refactors. Assertions focus on the *envelope* (keys present, types correct) rather than specific content strings.

**Verifier.** Itself — meta.

**Effort.** ~1.5–2h.

---

## Suggested ordering

The four steps are mostly independent, but Step 4's cache lands in a place Step 7 can reach for free, and Step 5's card wants the cached graph to avoid a second fetch. Ship order:

1. **Step 4** (cache) — unblocks downstream performance AND lets Step 5 pull graph from the scene payload.
2. **Step 5** (relations card) — user-visible UX win, shortest feedback loop with design.
3. **Step 7** (verify:graph-agent) — lock in the envelope before Step 6 starts changing UI.
4. **Step 6** (overlay polish) — polish is cheapest last, especially the runbook entry.

Total: ~6–8h focused work.

---

## What this plan deliberately does not cover

- **Agent → apply trust boundary** (open question #7 in roadmap.md). Needs confidence scoring + batch undo semantics; worth its own design doc when dry-run has a few weeks of real usage.
- **Multi-object propose_plan** (agent suggests e.g. "swap bed and dresser" as one composite move). Today the agent emits one move at a time; composite plans need a plan-graph data structure first.
- **Preference ML**. `derivePreferences()` is intentionally heuristic. Anything learned would need a privacy review because the feedback log is local today but gets interesting the moment it's persisted remotely.
- **Remote feedback store**. `.pi/feedback.jsonl` is single-user. Multi-user deployments (Fly.io) will need a DB-backed store and scoped reads. Out of scope until there's a second user.
