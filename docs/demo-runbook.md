# RoomView MVP demo runbook

This repo carries its own acceptance evidence. Run the scripted checks before a demo:

```bash
npm run verify:fixtures
npm run verify:replays
npm run verify:quick-render
npm run verify:mutation-pipeline
npm run verify:planner
npm run verify:photoreal
npm run verify:splat
npm run verify:observability
npm run verify:demo
```

Or run the full bundle:

```bash
npm run check
```

## Reproducible MVP sequence

The scripted end-to-end scenario is defined in `fixtures/demo/mvp-sequence.json` and executed by `scripts/verify-mvp-demo.mts`.

It covers:
1. RoomPlan capture ingest
2. secure handoff redemption
3. authenticated scene read + quick render
4. planner preview
5. atomic apply
6. bookmark sidecar creation
7. immutable photoreal generation + gallery read
8. optional video upload + splat job polling
9. refresh against the latest scene

## Observability evidence

`apps/api/src/observability.ts` records structured events, counters, error reasons, and latency summaries.

- `scripts/verify-observability.mts` exercises ingest, planner, mutation, bookmark, photoreal, and splat flows
- expected operation coverage lives in `fixtures/evals/observability-operations.json`
- running the API server emits structured JSON logs through the console sink

## Demo fallback behavior

### Planner fallback
- If planning is ambiguous, the client receives a `clarification_request`
- If a target is unsupported or invalid, the client receives a `rejection` with a reason code
- The client can reject a preview without mutating scene state

### Photoreal fallback
- Photoreal generation is sidecar-only and keyed to immutable scene versions
- If a snapshot or bookmark is missing, the request fails with `TARGET_NOT_FOUND`
- Failed or rejected photoreal requests never mutate the editable scene head

### Splat fallback
- If video upload never happens, the scan pane stays on the RoomPlan preview
- If the splat job fails, the scan pane stays on the RoomPlan preview and the editor remains fully usable
- Splat state never increments `scene_version` and never rewrites the authoritative editable snapshot
