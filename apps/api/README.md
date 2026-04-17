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
- `src/server.ts` with authenticated scene reads, `/plan`, bookmark creation, quick-render routes, preview/apply/undo mutation endpoints, `POST /scenes/:scene_id/photoreal`, and `GET /jobs/:job_id`
- `../../fixtures/manifest.json`
- `../../fixtures/mutations/step-8-cases.json`
- `../../fixtures/planner/golden-transcripts.json`
- `../../fixtures/photoreal/step-10-cases.json`
