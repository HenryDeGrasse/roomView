# RoomView MVP workspace

Bootstrapped implementation surfaces for the RoomView one-room MVP.

## Workspace layout

- `apps/api/` — backend service surface plus initial SQL migration
- `apps/web/` — web editor shell surface
- `packages/contracts/` — shared PRD-aligned TypeScript contracts
- `ios/` — Swift capture companion bootstrap surface
- `fixtures/` — RoomPlan capture payloads and golden canonical scene outputs

## Fixture-first verification

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

See `docs/demo-runbook.md` for the reproducible end-to-end MVP script and failure fallback behavior.

To regenerate canonical fixture scenes from the shared RoomPlan ingest module:

```bash
npm run fixtures:update
```

## AI chat planner setup

To enable the OpenRouter-backed chat planner for live API sessions, copy `.env.example` to `.env` and fill in `OPENROUTER_API_KEY`. The API server automatically loads repo-root `.env` when it starts.
