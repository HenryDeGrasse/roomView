# apps/api

Bootstrapped backend workspace for ingest, scene storage, validation, jobs, and secure handoff APIs.

Key bootstrap assets:
- `db/migrations/0001_initial_schema.sql`
- `src/index.ts`
- `src/roomplan-ingest.ts`
- `src/roomplan-persistence.ts`
- `src/mutation-engine.ts`
- `src/planner.ts`
- `src/quick-render.ts`
- `src/server.ts` with authenticated scene reads, `/plan`, quick-render routes, preview/apply/undo mutation endpoints, and the photoreal command placeholder route
- `../../fixtures/manifest.json`
- `../../fixtures/mutations/step-8-cases.json`
- `../../fixtures/planner/golden-transcripts.json`
