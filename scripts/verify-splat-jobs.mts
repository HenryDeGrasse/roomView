import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { RoomPlanCaptureRequest } from "../packages/contracts/src/index.ts";
import { RoomPlanCaptureError, RoomPlanCaptureService } from "../apps/api/src/index.ts";

interface SplatCaseManifest {
  cases: Array<{
    case_id: string;
    fixture_request_path: string;
    notes: string;
  }>;
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function createService(storageDirectory: string, videoUploadTtlMs = 10 * 60 * 1000): RoomPlanCaptureService {
  return new RoomPlanCaptureService({
    storage_directory: storageDirectory,
    token_secret: "splat-test-secret",
    handoff_base_url: "https://roomview.local/h",
    video_upload_ttl_ms: videoUploadTtlMs,
  });
}

function ingestScene(service: RoomPlanCaptureService, requestPath: string, clientCaptureIdSuffix = ""): { sceneId: string; videoUploadToken: string | null } {
  const request = readJson<RoomPlanCaptureRequest>(requestPath);
  const nextRequest = clientCaptureIdSuffix
    ? {
        ...request,
        request_id: `${request.request_id}-${clientCaptureIdSuffix}`,
        client_capture_id: `${request.client_capture_id}-${clientCaptureIdSuffix}`,
      }
    : request;
  const capture = service.postRoomPlanCapture(nextRequest);
  return { sceneId: capture.scene_id, videoUploadToken: capture.video_upload_token };
}

function expectReasonCode(action: () => unknown, expectedReasonCode: string): void {
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof RoomPlanCaptureError, "expected a RoomPlanCaptureError");
    assert.equal(error.reason_code, expectedReasonCode);
    return true;
  });
}

const manifest = readJson<SplatCaseManifest>("./fixtures/splat/step-11-cases.json");
assert.equal(manifest.cases.length, 4, "expected four splat verification cases");

{
  const storageDirectory = mkdtempSync(join(tmpdir(), "roomview-splat-none-"));
  try {
    const service = createService(storageDirectory);
    const { sceneId } = ingestScene(service, manifest.cases[0].fixture_request_path);
    const scene = service.getScene(sceneId);
    assert.ok(scene, "scene should exist after ingest");
    assert.equal(scene.head.current_scene_version, 1, "scene should stay editable before any optional upload");
    assert.equal(scene.splat?.status, "queued", "video-expected scenes should expose a queued splat sidecar placeholder");
    assert.equal(scene.splat?.job_id ?? null, null, "placeholder splat sidecar should not have a job until upload happens");
  } finally {
    rmSync(storageDirectory, { recursive: true, force: true });
  }
}

{
  const storageDirectory = mkdtempSync(join(tmpdir(), "roomview-splat-ready-"));
  try {
    const service = createService(storageDirectory);
    const { sceneId, videoUploadToken } = ingestScene(service, manifest.cases[1].fixture_request_path);
    assert.ok(videoUploadToken, "expected a video upload token for the splat path");
    const initialScene = service.getScene(sceneId);
    assert.ok(initialScene, "scene should exist after ingest");
    const initialVersion = initialScene.head.current_scene_version;
    const initialSnapshotId = initialScene.snapshot.snapshot_id;

    const upload = service.postCaptureVideo(sceneId, {
      video_upload_token: videoUploadToken,
      content_type: "video/mp4",
    });
    assert.equal(service.getJob(upload.job_id)?.status, "queued", "upload should create a queued splat job");
    assert.equal(service.getScene(sceneId)?.head.current_scene_version, initialVersion, "upload must not increment scene version");
    assert.equal(service.getScene(sceneId)?.snapshot.snapshot_id, initialSnapshotId, "upload must not rewrite the current snapshot");

    const processing = service.pollJob(upload.job_id);
    assert.equal(processing?.status, "processing", "first job poll should move the splat job into processing");
    const ready = service.pollJob(upload.job_id);
    assert.equal(ready?.status, "ready", "second job poll should mark the splat job ready");
    const readyScene = service.getScene(sceneId);
    assert.equal(readyScene?.splat?.status, "ready", "ready job should swap the scan pane source to the splat sidecar");
    assert.ok(readyScene?.splat?.asset_id, "ready splat should have an asset id");
    assert.ok(readyScene?.splat?.uri, "ready splat should have a uri");
    assert.equal(readyScene?.head.current_scene_version, initialVersion, "ready splat must still not increment scene version");

    const reloaded = createService(storageDirectory);
    assert.equal(reloaded.getJob(upload.job_id)?.status, "ready", "ready splat jobs should persist across reloads");
    assert.equal(reloaded.getScene(sceneId)?.splat?.status, "ready", "ready splat sidecars should persist across reloads");
  } finally {
    rmSync(storageDirectory, { recursive: true, force: true });
  }
}

{
  const storageDirectory = mkdtempSync(join(tmpdir(), "roomview-splat-fail-"));
  try {
    const service = createService(storageDirectory);
    const { sceneId, videoUploadToken } = ingestScene(service, manifest.cases[2].fixture_request_path);
    assert.ok(videoUploadToken, "expected a video upload token for the failure path");
    const initialScene = service.getScene(sceneId);
    assert.ok(initialScene, "scene should exist after ingest");

    const upload = service.postCaptureVideo(sceneId, {
      video_upload_token: videoUploadToken,
      content_type: "video/fail",
    });
    assert.equal(service.pollJob(upload.job_id)?.status, "processing", "failed simulations should still show processing before failure");
    const failed = service.pollJob(upload.job_id);
    assert.equal(failed?.status, "failed", "second failed poll should move the job to failed");
    const failedScene = service.getScene(sceneId);
    assert.equal(failedScene?.splat?.status, "failed", "failed splat jobs must keep a failed sidecar status");
    assert.equal(failedScene?.head.current_scene_version, 1, "failed splat jobs must not increment scene version");

    const bed = failedScene?.snapshot.state.room.objects.find((candidate) => candidate.class === "bed");
    assert.ok(bed, "scene should still be editable after a splat failure");
    const preview = service.createScenePreview(sceneId, {
      request_id: "lock-bed-after-failed-splat",
      idempotency_key: "lock-bed-after-failed-splat",
      expected_scene_version: failedScene!.head.current_scene_version,
      explanation: "Lock the bed after a failed splat job.",
      ops: [{ op: "lock_entity", entity_id: bed!.object_id, entity_type: "object" }],
    });
    assert.equal(preview.preview.ops[0]?.op, "lock_entity", "failed splat sidecars must not block normal edits");
  } finally {
    rmSync(storageDirectory, { recursive: true, force: true });
  }
}

{
  const storageDirectory = mkdtempSync(join(tmpdir(), "roomview-splat-guards-"));
  try {
    const service = createService(storageDirectory);
    const first = ingestScene(service, manifest.cases[3].fixture_request_path, "a");
    const second = ingestScene(service, manifest.cases[3].fixture_request_path, "b");
    assert.ok(first.videoUploadToken && second.videoUploadToken, "expected upload tokens for guardrail verification");

    service.postCaptureVideo(first.sceneId, {
      video_upload_token: first.videoUploadToken,
      content_type: "video/mp4",
    });
    expectReasonCode(
      () =>
        service.postCaptureVideo(first.sceneId, {
          video_upload_token: first.videoUploadToken!,
          content_type: "video/mp4",
        }),
      "VIDEO_UPLOAD_TOKEN_ALREADY_USED"
    );
    expectReasonCode(
      () =>
        service.postCaptureVideo(second.sceneId, {
          video_upload_token: first.videoUploadToken!,
          content_type: "video/mp4",
        }),
      "VIDEO_UPLOAD_TOKEN_INVALID"
    );
  } finally {
    rmSync(storageDirectory, { recursive: true, force: true });
  }

  const expiringStorageDirectory = mkdtempSync(join(tmpdir(), "roomview-splat-expire-"));
  try {
    const service = createService(expiringStorageDirectory, 1);
    const { sceneId, videoUploadToken } = ingestScene(service, manifest.cases[3].fixture_request_path, "expiring");
    assert.ok(videoUploadToken, "expected a video upload token for expiry verification");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expectReasonCode(
      () =>
        service.postCaptureVideo(sceneId, {
          video_upload_token: videoUploadToken,
          content_type: "video/mp4",
        }),
      "VIDEO_UPLOAD_TOKEN_EXPIRED"
    );
  } finally {
    rmSync(expiringStorageDirectory, { recursive: true, force: true });
  }
}

console.log(`Verified optional video upload tokens and asynchronous splat sidecars for ${manifest.cases.length} scripted case groups`);
