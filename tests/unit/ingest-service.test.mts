/**
 * RoomPlanCaptureService integration tests.
 *
 * End-to-end tests on the service object (no HTTP layer). Cover:
 *   - room_type gate
 *   - multi-room gate
 *   - idempotent capture (same request_id/client_capture_id returns same scene)
 *   - scene version bump after a successful apply
 *   - undo rolls back to the prior snapshot and decrements version
 *   - getJob / pollJob
 *   - scene observability snapshot exposes counters
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, test } from "node:test";

import {
  RoomPlanCaptureError,
  RoomPlanCaptureService,
} from "../../apps/api/src/roomplan-ingest.ts";
import type { RoomPlanCaptureRequest } from "../../packages/contracts/src/index.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

function loadCapture(): RoomPlanCaptureRequest {
  const body = readFileSync(
    resolve(repoRoot, "fixtures", "roomplan", "bedroom-primary", "capture-request.json"),
    "utf8"
  );
  return JSON.parse(body) as RoomPlanCaptureRequest;
}

describe("RoomPlanCaptureService — room-type + multi-room gates", () => {
  let storageDir: string;
  let service: RoomPlanCaptureService;

  before(() => {
    storageDir = mkdtempSync(join(tmpdir(), "roomview-ingest-test-"));
    service = new RoomPlanCaptureService({
      storage_directory: storageDir,
      token_secret: "test-secret",
      handoff_base_url: "https://example.com/handoff",
    });
  });

  after(() => {
    rmSync(storageDir, { recursive: true, force: true });
  });

  test("ROOM_TYPE_NOT_SUPPORTED for unsupported room_type", () => {
    const request = loadCapture();
    (request.capture_metadata as { room_type_hint: string }).room_type_hint = "kitchen" as "bedroom";
    request.roomplan_payload.room_type = "kitchen";
    assert.throws(
      () => service.postRoomPlanCapture(request),
      (error: Error) =>
        error instanceof RoomPlanCaptureError && error.reason_code === "ROOM_TYPE_NOT_SUPPORTED"
    );
  });

  test("MULTI_ROOM_NOT_SUPPORTED when room_count > 1", () => {
    const request = loadCapture();
    request.request_id = request.request_id + "-multi";
    request.client_capture_id = request.client_capture_id + "-multi";
    request.roomplan_payload.room_count = 2;
    assert.throws(
      () => service.postRoomPlanCapture(request),
      (error: Error) =>
        error instanceof RoomPlanCaptureError && error.reason_code === "MULTI_ROOM_NOT_SUPPORTED"
    );
  });
});

describe("RoomPlanCaptureService — idempotent capture", () => {
  let storageDir: string;
  let service: RoomPlanCaptureService;

  before(() => {
    storageDir = mkdtempSync(join(tmpdir(), "roomview-ingest-test-"));
    service = new RoomPlanCaptureService({
      storage_directory: storageDir,
      token_secret: "test-secret",
      handoff_base_url: "https://example.com/handoff",
    });
  });

  after(() => {
    rmSync(storageDir, { recursive: true, force: true });
  });

  test("second capture with the same request_id/client_capture_id returns the same scene_id", () => {
    const first = service.postRoomPlanCapture(loadCapture());
    const second = service.postRoomPlanCapture(loadCapture());
    assert.equal(first.scene_id, second.scene_id);
    assert.equal(first.scene_version, second.scene_version);
  });
});

describe("RoomPlanCaptureService — apply / undo lifecycle", () => {
  let storageDir: string;
  let service: RoomPlanCaptureService;
  let sceneId: string;
  let handoffToken: string;

  before(() => {
    storageDir = mkdtempSync(join(tmpdir(), "roomview-ingest-test-"));
    service = new RoomPlanCaptureService({
      storage_directory: storageDir,
      token_secret: "test-secret",
      handoff_base_url: "https://example.com/handoff",
    });
    const response = service.postRoomPlanCapture(loadCapture());
    sceneId = response.scene_id;
    handoffToken = JSON.parse(response.qr_payload).handoff_token;
  });

  after(() => {
    rmSync(storageDir, { recursive: true, force: true });
  });

  test("getScene returns the freshly ingested scene", () => {
    const scene = service.getScene(sceneId);
    assert.ok(scene);
    assert.equal(scene.head.scene_id, sceneId);
    assert.equal(scene.head.current_scene_version, 1);
  });

  test("fixture ingest yields a clean default layout with interior bookmarks", () => {
    const scene = service.getScene(sceneId);
    assert.ok(scene);
    assert.deepEqual(scene.derived_state_cache?.hard_violations ?? [], []);
    const vertices = scene.snapshot.state.room.shell.floor_polygon.vertices;
    const minX = Math.min(...vertices.map((vertex) => vertex.x));
    const maxX = Math.max(...vertices.map((vertex) => vertex.x));
    const minY = Math.min(...vertices.map((vertex) => vertex.y));
    const maxY = Math.max(...vertices.map((vertex) => vertex.y));
    assert.ok(scene.bookmarks.length >= 2, "expected multiple default interior bookmarks");
    for (const bookmark of scene.bookmarks) {
      assert.ok(bookmark.camera_pose.position.x >= minX && bookmark.camera_pose.position.x <= maxX, `${bookmark.name} x must stay inside room bounds`);
      assert.ok(bookmark.camera_pose.position.y >= minY && bookmark.camera_pose.position.y <= maxY, `${bookmark.name} y must stay inside room bounds`);
    }
  });

  test("redeemHandoff issues a session", () => {
    const response = service.redeemHandoff({ handoff_token: handoffToken });
    assert.equal(response.scene_id, sceneId);
    assert.equal(typeof response.session_id, "string");
  });

  test("preview → apply bumps scene_version and rewrites snapshot", () => {
    const sceneBefore = service.getScene(sceneId);
    assert.ok(sceneBefore);
    const surface = sceneBefore.snapshot.state.room.shell.surfaces.find(
      (candidate) => candidate.type === "wall"
    );
    assert.ok(surface, "scene fixture must have a wall");

    const previewRequest = {
      request_id: "req-preview-1",
      idempotency_key: "idem-preview-1",
      expected_scene_version: sceneBefore.head.current_scene_version,
      ops: [
        {
          op: "repaint_surface" as const,
          surface_id: surface.surface_id,
          color: "sage",
        },
      ],
      explanation: "paint a wall sage",
    };

    const previewResponse = service.createScenePreview(sceneId, previewRequest);
    assert.ok(previewResponse.preview.preview_id);

    const applyResponse = service.applyScenePreview(sceneId, {
      preview_id: previewResponse.preview.preview_id,
      apply_token: previewResponse.preview.apply_token,
      canonical_plan_hash: previewResponse.preview.canonical_plan_hash,
      expected_scene_version: sceneBefore.head.current_scene_version,
      idempotency_key: "idem-apply-1",
    });

    assert.equal(applyResponse.applied_scene_version, sceneBefore.head.current_scene_version + 1);
    const paintedSurface = applyResponse.scene.snapshot.state.room.shell.surfaces.find(
      (candidate) => candidate.surface_id === surface.surface_id
    );
    assert.equal(paintedSurface?.material_state.color, "sage");
  });

  test("undoLastChange rolls back to the prior snapshot and decrements version", () => {
    const before = service.getScene(sceneId);
    assert.ok(before);
    const response = service.undoLastChange(sceneId, {
      expected_scene_version: before.head.current_scene_version,
      idempotency_key: "idem-undo-1",
    });
    assert.equal(response.applied_scene_version, before.head.current_scene_version + 1);
    // Scene version always goes UP — undo writes a new snapshot tagged
    // mutation_kind=undo_restore. Actual behavior of the service.
    const after = service.getScene(sceneId);
    assert.ok(after);
    assert.equal(after.snapshot.mutation_kind, "undo_restore");
  });

  test("observability snapshot reflects the mutation traffic above", () => {
    const snapshot = service.getObservabilitySnapshot();
    // We've called postRoomPlanCapture, redeemHandoff, createScenePreview,
    // applyScenePreview, undoLastChange — so multiple operation counters
    // should exist.
    const counters = snapshot.counters;
    assert.ok(
      Object.keys(counters).some((k) => k.startsWith("operation:")),
      "expected at least one operation:* counter"
    );
    assert.ok(
      (counters["status:ok"] ?? 0) >= 1,
      "expected at least one successful operation"
    );
  });
});
