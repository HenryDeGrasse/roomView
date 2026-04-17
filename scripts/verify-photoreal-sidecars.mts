import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { GeneratePhotorealRequest, RoomPlanCaptureRequest, Scene } from "../packages/contracts/src/index.ts";
import { RoomPlanCaptureError, RoomPlanCaptureService } from "../apps/api/src/index.ts";

interface PhotorealCaseManifest {
  cases: Array<{
    case_id: string;
    fixture_request_path: string;
    notes: string;
  }>;
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function createService(storageDirectory: string): RoomPlanCaptureService {
  return new RoomPlanCaptureService({
    storage_directory: storageDirectory,
    token_secret: "photoreal-test-secret",
    handoff_base_url: "https://roomview.local/h",
  });
}

function ingestScene(service: RoomPlanCaptureService, requestPath: string): { sceneId: string; scene: Scene } {
  const request = readJson<RoomPlanCaptureRequest>(requestPath);
  const capture = service.postRoomPlanCapture(request);
  const scene = service.getScene(capture.scene_id);
  assert.ok(scene, `expected scene ${capture.scene_id}`);
  return { sceneId: capture.scene_id, scene };
}

function expectReasonCode(action: () => unknown, expectedReasonCode: string): void {
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof RoomPlanCaptureError, "expected a RoomPlanCaptureError");
    assert.equal(error.reason_code, expectedReasonCode);
    return true;
  });
}

const manifest = readJson<PhotorealCaseManifest>("./fixtures/photoreal/step-10-cases.json");
assert.equal(manifest.cases.length, 4, "expected four photoreal verification cases");

{
  const storageDirectory = mkdtempSync(join(tmpdir(), "roomview-bookmark-"));
  try {
    const service = createService(storageDirectory);
    const { sceneId, scene } = ingestScene(service, manifest.cases[0].fixture_request_path);
    const headVersion = scene.head.current_scene_version;
    const headSnapshotId = scene.snapshot.snapshot_id;
    const originalBookmarkCount = scene.bookmarks.length;
    const created = service.createBookmark(sceneId, {
      name: "Saved render view",
      camera_pose: scene.bookmarks[0].camera_pose,
      fov: scene.bookmarks[0].fov,
    });
    assert.equal(created.scene.head.current_scene_version, headVersion, "bookmark create must not increment scene version");
    assert.equal(created.scene.snapshot.snapshot_id, headSnapshotId, "bookmark create must not rewrite the head snapshot");
    assert.equal(created.scene.bookmarks.length, originalBookmarkCount + 1, "bookmark create should append a sidecar bookmark");

    const reloaded = createService(storageDirectory);
    const reloadedScene = reloaded.getScene(sceneId);
    assert.ok(reloadedScene, "bookmark scene should persist");
    assert.ok(reloadedScene.bookmarks.some((bookmark) => bookmark.bookmark_id === created.bookmark.bookmark_id), "bookmark should persist across reloads");
  } finally {
    rmSync(storageDirectory, { recursive: true, force: true });
  }
}

{
  const storageDirectory = mkdtempSync(join(tmpdir(), "roomview-photoreal-current-"));
  try {
    const service = createService(storageDirectory);
    const { sceneId, scene } = ingestScene(service, manifest.cases[1].fixture_request_path);
    const request: GeneratePhotorealRequest = {
      scene_snapshot_id: scene.snapshot.snapshot_id,
      bookmark_id: scene.bookmarks[0].bookmark_id,
      prompt_modifiers: ["warm", "evening"],
      idempotency_key: "photoreal-current",
    };
    const response = service.generatePhotoreal(sceneId, request);
    assert.equal(response.photoreal_entry.scene_version, scene.head.current_scene_version, "gallery entry should reference current scene version");
    assert.equal(response.photoreal_entry.scene_snapshot_id, scene.snapshot.snapshot_id, "gallery entry should reference the current snapshot");

    const job = service.getJob(response.job_id);
    assert.ok(job, "photoreal job should be tracked");
    assert.equal(job.status, "ready", "deterministic provider should finish immediately");
    assert.equal(job.scene_snapshot_id, scene.snapshot.snapshot_id, "job should link to the immutable snapshot");

    const replay = service.generatePhotoreal(sceneId, request);
    assert.deepEqual(replay, response, "same idempotency key should return the original response");
    assert.equal(service.getScene(sceneId)?.photoreal_gallery.length, 1, "idempotent replay must not duplicate gallery entries");

    const reloaded = createService(storageDirectory);
    assert.ok(reloaded.getJob(response.job_id), "photoreal job should persist across reloads");
    assert.equal(reloaded.getScene(sceneId)?.photoreal_gallery.length, 1, "gallery should persist across reloads");
  } finally {
    rmSync(storageDirectory, { recursive: true, force: true });
  }
}

{
  const storageDirectory = mkdtempSync(join(tmpdir(), "roomview-photoreal-history-"));
  try {
    const service = createService(storageDirectory);
    const { sceneId, scene } = ingestScene(service, manifest.cases[2].fixture_request_path);
    const bed = scene.snapshot.state.room.objects.find((candidate) => candidate.class === "bed");
    assert.ok(bed, "expected bed object for mutation history setup");
    const preview = service.createScenePreview(sceneId, {
      request_id: "lock-bed-preview",
      idempotency_key: "lock-bed-preview",
      expected_scene_version: scene.head.current_scene_version,
      explanation: "Lock the bed before historical photoreal generation.",
      ops: [{ op: "lock_entity", entity_id: bed.object_id, entity_type: "object" }],
    });
    const applied = service.applyScenePreview(sceneId, {
      preview_id: preview.preview.preview_id,
      apply_token: preview.preview.apply_token,
      canonical_plan_hash: preview.preview.canonical_plan_hash,
      expected_scene_version: scene.head.current_scene_version,
      idempotency_key: "lock-bed-apply",
    });
    assert.equal(applied.applied_scene_version, 2, "mutation setup should advance the head to version 2");

    const historical = service.generatePhotoreal(sceneId, {
      scene_snapshot_id: scene.snapshot.snapshot_id,
      bookmark_id: scene.bookmarks[0].bookmark_id,
      prompt_modifiers: [],
      idempotency_key: "photoreal-history",
    });
    const currentScene = service.getScene(sceneId);
    assert.ok(currentScene, "scene should still be readable after historical photoreal generation");
    assert.equal(currentScene.head.current_scene_version, 2, "historical photoreal must not rewrite the editable head version");
    assert.equal(currentScene.snapshot.snapshot_id, applied.scene.snapshot.snapshot_id, "historical photoreal must not rewrite the current head snapshot");
    assert.equal(historical.photoreal_entry.scene_version, 1, "historical gallery entry must preserve the old scene version");
    assert.equal(historical.photoreal_entry.scene_snapshot_id, scene.snapshot.snapshot_id, "historical gallery entry must preserve the old snapshot id");
  } finally {
    rmSync(storageDirectory, { recursive: true, force: true });
  }
}

{
  const storageDirectory = mkdtempSync(join(tmpdir(), "roomview-photoreal-conflicts-"));
  try {
    const service = createService(storageDirectory);
    const { sceneId, scene } = ingestScene(service, manifest.cases[3].fixture_request_path);
    const explicitCameraRequest: GeneratePhotorealRequest = {
      scene_snapshot_id: scene.snapshot.snapshot_id,
      camera_pose: scene.bookmarks[0].camera_pose,
      fov: scene.bookmarks[0].fov,
      prompt_modifiers: ["moody"],
      idempotency_key: "photoreal-explicit-camera",
    };
    const explicitCameraResponse = service.generatePhotoreal(sceneId, explicitCameraRequest);
    assert.equal(explicitCameraResponse.photoreal_entry.bookmark_id, null, "explicit camera requests should not backfill a bookmark id");

    const duplicateEntry = service.generatePhotoreal(sceneId, {
      ...explicitCameraRequest,
      idempotency_key: "photoreal-explicit-camera-second-key",
    });
    assert.equal(duplicateEntry.photoreal_entry.entry_id, explicitCameraResponse.photoreal_entry.entry_id, "identical camera+snapshot requests should dedupe gallery entries deterministically");
    assert.equal(service.getScene(sceneId)?.photoreal_gallery.length, 1, "deterministic dedupe must keep one gallery entry per immutable view request");

    expectReasonCode(
      () => service.generatePhotoreal(sceneId, { ...explicitCameraRequest, idempotency_key: "photoreal-explicit-camera", prompt_modifiers: ["different"] }),
      "IDEMPOTENCY_CONFLICT"
    );
    expectReasonCode(
      () => service.generatePhotoreal(sceneId, { ...explicitCameraRequest, idempotency_key: "photoreal-missing-snapshot", scene_snapshot_id: "snapshot-does-not-exist" }),
      "TARGET_NOT_FOUND"
    );
    expectReasonCode(
      () => service.generatePhotoreal(sceneId, { ...explicitCameraRequest, idempotency_key: "photoreal-missing-bookmark", bookmark_id: "bookmark-does-not-exist", camera_pose: undefined, fov: undefined }),
      "TARGET_NOT_FOUND"
    );
  } finally {
    rmSync(storageDirectory, { recursive: true, force: true });
  }
}

console.log(`Verified bookmark sidecars and immutable photoreal gallery behavior for ${manifest.cases.length} scripted case groups`);
