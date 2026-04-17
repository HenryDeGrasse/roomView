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
```

To regenerate canonical fixture scenes from the shared RoomPlan ingest module:

```bash
npm run fixtures:update
```
