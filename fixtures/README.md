# Fixture scenes

These fixtures let backend ingest, validation, and the initial web shell develop against stable golden inputs before live iOS capture is wired up.

## Included fixtures

- `fixture-bedroom-primary`
  - `roomplan/bedroom-primary/capture-request.json`
  - `roomplan/bedroom-primary/scene.json`
- `fixture-bedroom-obstacle`
  - `roomplan/bedroom-obstacle/capture-request.json`
  - `roomplan/bedroom-obstacle/scene.json`

Each `scene.json` is a full golden scene read model: head, immutable snapshot, derived-state cache, bookmarks, gallery sidecars, and splat sidecar state.
