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
- `src/observability.ts`
- `src/server.ts` with authenticated scene reads, scene-scoped `/plan`, bookmark creation, `POST /captures/:scene_id/video`, quick-render routes, preview/apply/undo mutation endpoints, `POST /scenes/:scene_id/photoreal`, and `GET /jobs/:job_id`
- `../../fixtures/manifest.json`
- `../../fixtures/mutations/step-8-cases.json`
- `../../fixtures/planner/golden-transcripts.json`
- `../../fixtures/photoreal/step-10-cases.json`
- `../../fixtures/splat/step-11-cases.json`
- `../../fixtures/evals/observability-operations.json`
- `../../fixtures/demo/mvp-sequence.json`
- `../../docs/demo-runbook.md`

## AI planner

When `OPENROUTER_API_KEY` is present in the repo-root `.env`, the `/plan` endpoint upgrades from the deterministic rule-based planner to an OpenRouter-backed conversational planner that can inspect scene state, ask clarifying questions, and propose validated typed previews while still relying on the existing server-authoritative preview/apply pipeline.
