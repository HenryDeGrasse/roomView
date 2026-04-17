# apps/api

Bootstrapped backend workspace for ingest, scene storage, validation, jobs, and secure handoff APIs.

Key bootstrap assets:
- `db/migrations/0001_initial_schema.sql`
- `src/index.ts`
- `src/roomplan-ingest.ts`
- `src/roomplan-persistence.ts`
- `src/quick-render.ts`
- `src/server.ts` with authenticated scene reads, curated asset manifest, and quick-render routes
- `../../fixtures/manifest.json`
