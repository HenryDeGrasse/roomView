# apps/web

Bootstrapped web-editor workspace for the three-pane MVP client.

Current scaffold:
- `src/index.ts` provides fixture-first bootstrap constants and editor server exports
- `src/server.ts` serves the minimal three-pane editor shell plus fixture-backed development scene routes
- `../../fixtures/manifest.json` lists golden scenes that the shell can load before live capture is wired up
