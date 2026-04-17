Must-be-true checks I used

1. Shared contracts must define the RoomPlan capture request/response and the handoff/video-upload artifact shapes.
2. A shared ingest builder must deterministically assign stable IDs, map RoomPlan payloads into the initial Scene, and derive the initial cache/splat state.
3. Canonical fixtures must represent initial-ingest scenes correctly.
4. `POST /captures/roomplan` must go through the ingest service and persist the result durably.
5. Persistence must store `SceneHead`, `SceneSnapshot`, `derived_state_cache`, plus handoff and video-upload artifacts.
6. Persisted records must hydrate back into the canonical `Scene` and reload on service restart.
7. Fixture generation and replay verification must reuse the same shared ingest/persistence code, and replay verification must exist and pass.
8. The iOS companion upload path must use the same payload shapes/URLs and be verified by tests.

Findings

- PASS: Shared contracts define RoomPlan capture, response, handoff, and video-upload shapes — `packages/contracts/src/api.ts` defines `RoomPlanCaptureRequest` (`api.ts:65`), `RoomPlanCaptureResponse` (`api.ts:110`), `VideoUploadRequest` (`api.ts:308`), `HandoffGrantRecord` (`api.ts:334`), and `VideoUploadTokenRecord` (`api.ts:345`).

- PASS: The ingest builder deterministically creates stable IDs, scene mapping, and the initial derived cache/splat — `apps/api/src/roomplan-ingest.ts` exports `buildInitialSceneFromRoomPlanCapture` (`roomplan-ingest.ts:408`), derives `sceneSeed`/`snapshotId` via `makeStableId` (`:415-416`), populates `derived_state_cache: deriveInitialStateCache(...)` (`:600`), and creates queued `splat` state when `video_expected` is true (`:603`). The stable-ID helper is deterministic: `makeStableId(prefix, seed)` hashes the seed (`roomplan-ingest.ts` lower section).

- PASS: Canonical fixtures encode initial-ingest scenes correctly — `scripts/verify-fixtures.mjs` asserts `scene_version === 1` (`:65`), `mutation_kind === "initial_ingest"` (`:68`), populated `derived_state_cache` (`:70`), queued splat for `video_expected` fixtures (`:153-155`), and `generic_obstacle` preservation for obstacle fixtures (`:163-166`). I ran `npm run verify:fixtures`, and it passed: `Verified 2 fixture scene(s)`.

- PASS: `POST /captures/roomplan` is wired end-to-end to the ingest service and persists results — `apps/api/src/server.ts` routes `POST /captures/roomplan` to `service.postRoomPlanCapture(...)` (`server.ts:41-43`). `RoomPlanCaptureService.postRoomPlanCapture` decomposes records and persists them (`apps/api/src/roomplan-ingest.ts:725`, `:744`). I ran an end-to-end verifier that started `createRoomPlanApiServer`, POSTed `fixtures/roomplan/bedroom-primary/capture-request.json`, got HTTP `200`, and observed one persisted JSON file containing:
  - `scene_head`
  - `scene_snapshot`
  - `derived_state_cache`
  - `camera_bookmarks`
  - `photoreal_entries`
  - `splat_asset_record`
  - `handoff_grant`
  - `video_upload_token_record`

- PASS: Persistence stores the required initial scene records plus handoff/video artifacts — `apps/api/src/roomplan-persistence.ts` defines `PersistedInitialSceneRecords` with `scene_head`, `scene_snapshot`, `derived_state_cache`, `camera_bookmarks`, `photoreal_entries`, `splat_asset_record`, `handoff_grant`, and `video_upload_token_record` (`roomplan-persistence.ts:39-47`). `decomposeIngestedCaptureForStorage(...)` populates those fields (`:57-83`).

- PASS: Persisted records hydrate back into canonical scenes and reload on restart — `hydrateSceneFromStoredRecords(...)` reconstructs a `Scene` from stored records (`apps/api/src/roomplan-persistence.ts:89-97`). `FileSystemRoomPlanCaptureRecordStore.loadAll()` reads saved JSON files (`apps/api/src/roomplan-store.ts:21-23`), and the service constructor reloads them via `hydrateStoredScene(...)` (`apps/api/src/roomplan-ingest.ts:689-690`, `:854-856`). I ran a restart check with a temp storage directory: `scene_loaded_after_restart: true`, `scene_equal_after_restart: true`.

- PASS: Fixture generation and replay verification reuse the same shared ingest/persistence code, and replay verification passes — `scripts/update-roomplan-fixtures.mts` imports `buildInitialSceneFromRoomPlanCapture` from `../apps/api/src/index.ts` (`update-roomplan-fixtures.mts:5`, `:31`). `scripts/verify-roomplan-replays.mts` imports `buildInitialSceneFromRoomPlanCapture`, `ingestRoomPlanCaptureRequest`, `decomposeIngestedCaptureForStorage`, and `hydrateSceneFromStoredRecords` from the same module (`verify-roomplan-replays.mts:7-10`). It compares replayed scenes to fixture scenes (`:84-86`) and normalizes opaque token fields like `grant_id`, `token_id`, `token_hash`, `video_upload_token`, QR payload token, and handoff URL before parity checks (`:47-74`, `:104-111`). I ran `npm run verify:replays`, and it passed: `Verified deterministic replay parity for 2 fixture scene(s)`.
  - Note: I did not find separate timestamp normalization in this script; replay parity passes because fixture inputs carry fixed `captured_at` timestamps.

- PASS: The iOS companion uses matching snake_case payload shapes and scene-scoped URLs, and its tests pass — `ios/RoomViewCapture/Sources/RoomViewCapture/RoomViewCapture.swift` maps capture fields to API snake_case (`request_id`, `roomplan_payload`, `capture_metadata`, `supplementary_detections`) at `RoomViewCapture.swift:52-57`, and video upload fields to `video_upload_token` / `content_type` at `:372-373`. It also constructs capture/redeem/video URLs from shared templates. `ios/RoomViewCapture/Tests/RoomViewCaptureTests.swift` explicitly tests capture payload shape, video upload payload shape, and URL templates. I ran `cd ios/RoomViewCapture && swift test`; all 3 tests passed.

Assessment: CONVERGED — implementation matches requirements with no material gaps