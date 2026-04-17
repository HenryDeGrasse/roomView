Verified by reading:
- `apps/api/src/roomplan-ingest.ts`
- `apps/api/src/index.ts`
- `apps/api/db/migrations/0001_initial_schema.sql`
- `packages/contracts/src/api.ts`
- `ios/RoomViewCapture/Sources/RoomViewCapture/RoomViewCapture.swift`
- `scripts/verify-fixtures.mjs`
- fixture files under `fixtures/roomplan/...`

And by running:
- `npm run verify:fixtures` ✅
- `cd ios/RoomViewCapture && swift build` ✅

1. PASS: Typed capture request/response shapes and iOS upload plumbing exist — `packages/contracts/src/api.ts:65-117` defines `RoomPlanCaptureRequest`/`RoomPlanCaptureResponse` with optional `video_upload_token`; `ios/RoomViewCapture/Sources/RoomViewCapture/RoomViewCapture.swift:19` defaults the capture path to `"/captures/roomplan"`, and `:511-515, :648-651` POSTs JSON-encoded capture bodies; `swift build` succeeded.

2. PASS: Ingest validates only single-room bedroom captures in meters and rejects malformed opening/surface links — `apps/api/src/roomplan-ingest.ts:885-916` checks `room_type_hint === "bedroom"`, `room_type === "bedroom"`, `(room_count ?? 1) === 1`, meter units, exactly one floor surface, and that every opening references a known host surface.

3. PASS: Shell/openings are mapped into canonical scene structures with coordinate frame, named walls, and floor-plane opening zones — `apps/api/src/roomplan-ingest.ts:425-555` builds canonical `Surface[]`, room `coordinate_frame`, and `named_wall_refs`; `:928-929`, `:945-970`, and `:1918-1922` derive cardinal wall refs from wall normals; `:1030-1038` maps openings and `:1689`+ computes `swing_zone`/`keepout_zone` on the floor plane.

4. PASS: Stable IDs are deterministically assigned and duplicate ingests do not mint new scene IDs; one-time handoff logic exists in the service layer — `apps/api/src/roomplan-ingest.ts:403-410`, `:1030`, and `:1068` assign stable ids via `makeStableId`; `:1913-1915` defines the stable-id helper; `:674-689` uses `client_capture_id` + `createRequestFingerprint` to reject conflicting reinserts and reuse stored scenes; `:621-646` issues handoff/video response data; `:729-759` enforces single-use handoff redemption with `HANDOFF_ALREADY_USED` at `:746-753`.

5. PASS: Unsupported detections are preserved as `generic_obstacle`, while editable objects get initial asset refs/proxies — `apps/api/src/roomplan-ingest.ts:482-498` turns supplementary detections into object inputs; `:1061-1075` maps unsupported categories to `generic_obstacle`; `:517-526` assigns `asset_ref`, style tags, material state, and `editing_asset_refs` for editable objects; proxy assets exist in the library at `:157-159` and `:259-261`; `fixtures/roomplan/bedroom-obstacle/scene.json:808-811` shows a preserved `generic_obstacle`, and `scripts/verify-fixtures.mjs:129-168` checks this; `npm run verify:fixtures` passed.

6. PASS: Initial scene creation computes the first derived cache and creates `SceneHead`/`SceneSnapshot` version 1, plus optional queued splat/video token without waiting on video upload — `apps/api/src/roomplan-ingest.ts:571-580` sets `current_scene_version: 1`, `scene_version: 1`, and `mutation_kind: "initial_ingest"`; `:588-590` sets `derived_state_cache`, bookmarks, and empty `photoreal_gallery`; `:593-596` queues the splat sidecar when `video_expected`; `:639-646` returns `video_upload_token`; actual video-job creation is separate in `:763-815`, so capture ingest itself does not block on upload/training.

7. FAIL: Expected an actual HTTP implementation behind `POST /captures/roomplan`; found no server route/handler — `apps/api/src/index.ts` only re-exports library symbols, and grep over `apps/api/src` found no `captures/roomplan`, `app.post`, `router.post`, `serve`, `createServer`, or similar HTTP route code. The iOS companion expects that endpoint (`RoomViewCapture.swift:19`), but no matching API handler is present.

8. FAIL: Expected durable persistence of `SceneSnapshot(scene_version = 1)` + `SceneHead`; found only in-memory storage — `apps/api/db/migrations/0001_initial_schema.sql` defines `scene_heads` and `scene_snapshots`, but `apps/api/src/roomplan-ingest.ts:659-663` stores scenes/jobs in `Map`s and `:715-719` writes only to those maps; grep over `apps/api/src` found no DB client, SQL execution, or writes to those tables.

Assessment: DIVERGED — found material discrepancies between requirements and implementation

Divergence issues:
- No actual `POST /captures/roomplan` HTTP endpoint implementation is present.
- No durable persistence of `SceneHead`/`SceneSnapshot`; the service stores state only in process-memory maps.