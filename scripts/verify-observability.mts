import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { RoomPlanCaptureRequest } from "../packages/contracts/src/index.ts";
import { ObservabilityRecorder, RoomPlanCaptureError, RoomPlanCaptureService } from "../apps/api/src/index.ts";

interface ObservabilityFixture {
  required_operations: string[];
  expected_error_reasons: string[];
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

const expectations = readJson<ObservabilityFixture>("./fixtures/evals/observability-operations.json");
const storageDirectory = mkdtempSync(join(tmpdir(), "roomview-observability-"));
const recorder = new ObservabilityRecorder();

try {
  const service = new RoomPlanCaptureService({
    storage_directory: storageDirectory,
    token_secret: "observability-test-secret",
    handoff_base_url: "https://roomview.local/h",
    observability: recorder,
  });
  const request = readJson<RoomPlanCaptureRequest>("./fixtures/roomplan/bedroom-primary/capture-request.json");
  const capture = service.postRoomPlanCapture(request);
  const scene = service.getScene(capture.scene_id);
  assert.ok(scene, "scene should exist after ingest");

  const bed = scene.snapshot.state.room.objects.find((candidate) => candidate.class === "bed");
  assert.ok(bed, "expected a bed object for planner/apply observability coverage");

  const plan = service.planSceneOperation(capture.scene_id, {
    request_id: "obs-plan",
    idempotency_key: "obs-plan",
    scene_id: capture.scene_id,
    expected_scene_version: scene.head.current_scene_version,
    selection_context: { selected_entity_ids: [bed.object_id] },
    user_prompt: "Keep this bed, don't touch it.",
  });
  assert.equal(plan.response_kind, "operation_plan_preview", "planner should produce a preview for observability coverage");

  const applied = service.applyScenePreview(capture.scene_id, {
    preview_id: plan.preview.preview_id,
    apply_token: plan.preview.apply_token,
    canonical_plan_hash: plan.preview.canonical_plan_hash,
    expected_scene_version: scene.head.current_scene_version,
    idempotency_key: "obs-apply",
  });
  assert.equal(applied.applied_scene_version, 2, "apply should advance scene version for observability coverage");

  service.createBookmark(capture.scene_id, {
    name: "Observability bookmark",
    camera_pose: applied.scene.bookmarks[0].camera_pose,
    fov: applied.scene.bookmarks[0].fov,
  });

  service.generatePhotoreal(capture.scene_id, {
    scene_snapshot_id: applied.scene.snapshot.snapshot_id,
    bookmark_id: applied.scene.bookmarks[0].bookmark_id,
    prompt_modifiers: ["warm"],
    idempotency_key: "obs-photoreal",
  });

  const upload = service.postCaptureVideo(capture.scene_id, {
    video_upload_token: capture.video_upload_token!,
    content_type: "video/mp4",
  });
  assert.equal(service.pollJob(upload.job_id)?.status, "processing", "first job poll should move to processing");
  assert.equal(service.pollJob(upload.job_id)?.status, "ready", "second job poll should move to ready");

  assert.throws(
    () =>
      service.generatePhotoreal(capture.scene_id, {
        scene_snapshot_id: "snapshot-does-not-exist",
        prompt_modifiers: [],
        idempotency_key: "obs-error",
      }),
    (error: unknown) => {
      assert.ok(error instanceof RoomPlanCaptureError);
      assert.equal(error.reason_code, "TARGET_NOT_FOUND");
      return true;
    }
  );

  const snapshot = service.getObservabilitySnapshot();
  for (const operation of expectations.required_operations) {
    assert.ok(snapshot.counters[`operation:${operation}`] >= 1, `missing observability counter for ${operation}`);
    assert.ok(snapshot.latencies_ms[operation], `missing latency summary for ${operation}`);
    assert.ok(snapshot.latencies_ms[operation].count >= 1, `missing latency count for ${operation}`);
  }
  for (const reason of expectations.expected_error_reasons) {
    assert.ok(snapshot.error_counts_by_reason[reason] >= 1, `missing expected error reason ${reason}`);
  }
  assert.ok(snapshot.recent_events.length >= expectations.required_operations.length, "expected structured events to be retained");

  console.log(JSON.stringify({
    verified_operations: expectations.required_operations,
    observed_error_reasons: snapshot.error_counts_by_reason,
    recent_event_count: snapshot.recent_events.length,
  }, null, 2));
  console.log("Verified structured observability counters, error reasons, and latency summaries");
} finally {
  rmSync(storageDirectory, { recursive: true, force: true });
}
