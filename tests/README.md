# tests/

Unit + integration tests that run alongside the nine existing `verify:*`
scripts in the repo root.

## Layout

```
tests/
  helpers/              reusable test fixtures (scene builders, http harness)
  unit/
    _harness.test.mts            sanity-check the runner itself
    contracts-*.test.mts         @roomview/contracts: enums, manifest, quick-render
    observability.test.mts       ObservabilityRecorder invariants
    photoreal-providers.test.mts provider selection + client-conditioning summary
    roomplan-persistence.test.mts decompose/hydrate round-trip
    roomplan-store.test.mts      filesystem record store (atomic writes, loadAll)
    mutation-engine.test.mts     preview simulator, guards, every op kind
    planner.test.mts             deterministic planner keyword routing
    http-server.test.mts         real Node http server, ephemeral port
    ingest-service.test.mts      RoomPlanCaptureService lifecycle
```

## Running

```
npm run verify:unit        # run just the unit suite
npm run check              # run all nine verify scripts + verify:unit
```

## How the harness works

`scripts/verify-unit.mts` imports every `*.test.mts` under `tests/unit/`.
Each test file uses Node's built-in `node:test` + `node:assert/strict`. Tests
register via `describe()` / `test()` when their module evaluates; the runner
executes them and sets `process.exitCode` to non-zero on any failure.

This matches the existing pattern of `npx --yes tsx ./scripts/verify-*.mts`
and requires no new dependencies.

## Adding a new test

1. Create `tests/unit/<module>.test.mts`.
2. At the top:
   ```ts
   import assert from "node:assert/strict";
   import { describe, test } from "node:test";
   ```
3. Import the module under test via its package path (e.g.
   `../../apps/api/src/mutation-engine.ts` or
   `../../packages/contracts/src/index.ts`).
4. If you need a minimal canonical `Scene`, use
   `buildMinimalScene` from `tests/helpers/scene-builder.ts`. It gives you a
   4×3 m bedroom with four named walls; pass `objects: [...]` to populate
   editable objects without having to spell out every field.
5. If you need to hit the HTTP layer, use `startApiHarness` from
   `tests/helpers/http-harness.ts`. It boots the real server on an ephemeral
   port with a temp storage directory.

## Philosophy

- **Unit tests drive branches the verify scripts can't reach** — negative
  paths, guards, auth failures, clock-jump edge cases. The verify scripts
  pin golden-fixture end-to-end output; the unit tests lock in the isolated
  branch behavior that makes those outputs possible.
- **Tests document quirks.** Where the planner has a surprising keyword
  precedence (e.g. `"replace the chair with a desk"` without a selection
  resolves to `desk` and falls through to clarification), the test name and
  comment explain the behavior so a future change is obvious rather than
  accidental.
- **Tests do not reach into private state.** Service tests call only the
  public method surface — `postRoomPlanCapture`, `redeemHandoff`,
  `createScenePreview`, etc. — so they remain valid if the internal record
  shape changes.
