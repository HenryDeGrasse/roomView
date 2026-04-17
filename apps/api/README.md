# apps/api

Bootstrapped backend workspace for ingest, scene storage, validation, jobs, and secure handoff APIs.

Key bootstrap assets:
- `db/migrations/0001_initial_schema.sql`
- `src/index.ts`
- `src/roomplan-ingest.ts`
- `src/roomplan-persistence.ts`
- `src/mutation-engine.ts`
- `src/quick-render.ts`
- `src/server.ts` with authenticated scene reads, quick-render routes, and preview/apply/undo mutation endpoints
- `../../fixtures/manifest.json`
- `../../fixtures/mutations/step-8-cases.json`
