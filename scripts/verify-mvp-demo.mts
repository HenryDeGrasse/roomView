import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { RoomPlanCaptureRequest } from "../packages/contracts/src/index.ts";
import { createRoomPlanApiServer } from "../apps/api/src/index.ts";

interface DemoSequenceFixture {
  fixture_request_path: string;
  steps: Array<{
    action: string;
    notes: string;
  }>;
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

async function postJson<T>(url: string, body: unknown, headers: Record<string, string> = {}): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
  const payload = (await response.json()) as T & { message?: string; reason_code?: string };
  if (!response.ok) {
    throw new Error(payload.message ?? payload.reason_code ?? `Request to ${url} failed`);
  }
  return payload;
}

async function getJson<T>(url: string, headers: Record<string, string> = {}): Promise<T> {
  const response = await fetch(url, { headers });
  const payload = (await response.json()) as T & { message?: string; reason_code?: string };
  if (!response.ok) {
    throw new Error(payload.message ?? payload.reason_code ?? `Request to ${url} failed`);
  }
  return payload;
}

const demo = readJson<DemoSequenceFixture>("./fixtures/demo/mvp-sequence.json");
assert.ok(demo.steps.length >= 9, "expected a full MVP demo sequence");

const storageDirectory = mkdtempSync(join(tmpdir(), "roomview-demo-"));
const server = createRoomPlanApiServer({
  storage_directory: storageDirectory,
  token_secret: "demo-test-secret",
  handoff_base_url: "https://roomview.local/h",
});

try {
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object", "expected the API server to listen on an ephemeral port");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const request = readJson<RoomPlanCaptureRequest>(demo.fixture_request_path);
  const capture = await postJson<{ scene_id: string; scene_snapshot_id: string; qr_payload: string; video_upload_token: string | null }>(
    `${baseUrl}/captures/roomplan`,
    request
  );
  const handoffToken = (JSON.parse(capture.qr_payload) as { handoff_token: string }).handoff_token;
  const redeem = await postJson<{ scene_id: string; session_id: string }>(`${baseUrl}/handoffs/redeem`, {
    handoff_token: handoffToken,
  });
  const authHeaders = { Authorization: `Bearer ${redeem.session_id}` };

  const initialScene = await getJson<{ scene: any }>(`${baseUrl}/scenes/${encodeURIComponent(capture.scene_id)}`, authHeaders);
  const quickRender = await getJson<{ render_scene: any }>(`${baseUrl}/scenes/${encodeURIComponent(capture.scene_id)}/quick-render`, authHeaders);
  assert.equal(quickRender.render_scene.scene_snapshot_id, initialScene.scene.snapshot.snapshot_id, "quick render should align with the current scene snapshot");

  const bed = initialScene.scene.snapshot.state.room.objects.find((candidate: any) => candidate.class === "bed");
  assert.ok(bed, "expected a bed object for the scripted planner step");
  const plan = await postJson<{ response_kind: string; preview: any }>(`${baseUrl}/scenes/${encodeURIComponent(capture.scene_id)}/plan`, {
    request_id: "demo-plan",
    idempotency_key: "demo-plan",
    scene_id: capture.scene_id,
    expected_scene_version: initialScene.scene.head.current_scene_version,
    selection_context: {
      selected_entity_ids: [bed.object_id],
    },
    user_prompt: "Keep this bed, don't touch it.",
  }, authHeaders);
  assert.equal(plan.response_kind, "operation_plan_preview", "demo planner step should produce a preview");

  const applied = await postJson<{ scene: any; applied_scene_version: number }>(`${baseUrl}/scenes/${encodeURIComponent(capture.scene_id)}/apply`, {
    preview_id: plan.preview.preview_id,
    apply_token: plan.preview.apply_token,
    canonical_plan_hash: plan.preview.canonical_plan_hash,
    expected_scene_version: initialScene.scene.head.current_scene_version,
    idempotency_key: "demo-apply",
  }, authHeaders);
  assert.equal(applied.applied_scene_version, 2, "apply should create scene version 2 in the demo flow");

  const bookmark = await postJson<{ bookmark: any; scene: any }>(`${baseUrl}/scenes/${encodeURIComponent(capture.scene_id)}/bookmarks`, {
    name: "Demo bookmark",
    camera_pose: applied.scene.bookmarks[0].camera_pose,
    fov: applied.scene.bookmarks[0].fov,
  }, authHeaders);
  assert.equal(bookmark.scene.head.current_scene_version, 2, "bookmark sidecars must not mutate the editable scene version");

  const photoreal = await postJson<{ job_id: string; photoreal_entry: any }>(`${baseUrl}/scenes/${encodeURIComponent(capture.scene_id)}/photoreal`, {
    scene_snapshot_id: applied.scene.snapshot.snapshot_id,
    bookmark_id: bookmark.bookmark.bookmark_id,
    prompt_modifiers: ["warm"],
    idempotency_key: "demo-photoreal",
  }, authHeaders);
  const photorealJob = await getJson<{ job: any; photoreal_entry: any }>(`${baseUrl}/jobs/${encodeURIComponent(photoreal.job_id)}`, authHeaders);
  assert.equal(photorealJob.job.status, "ready", "photoreal jobs should resolve immediately in the deterministic demo path");

  assert.ok(capture.video_upload_token, "expected an optional video upload token for the splat demo path");
  const splatUpload = await postJson<{ job_id: string }>(`${baseUrl}/captures/${encodeURIComponent(capture.scene_id)}/video`, {
    video_upload_token: capture.video_upload_token,
    content_type: "video/mp4",
  });
  const splatProcessing = await getJson<{ job: any; splat_asset_record: any }>(`${baseUrl}/jobs/${encodeURIComponent(splatUpload.job_id)}`, authHeaders);
  const splatReady = await getJson<{ job: any; splat_asset_record: any }>(`${baseUrl}/jobs/${encodeURIComponent(splatUpload.job_id)}`, authHeaders);
  assert.equal(splatProcessing.job.status, "processing", "first splat job poll should move to processing");
  assert.equal(splatReady.job.status, "ready", "second splat job poll should move to ready");
  assert.equal(splatReady.splat_asset_record?.status, "ready", "ready splat sidecar should be returned with the job poll");

  const refreshedScene = await getJson<{ scene: any }>(`${baseUrl}/scenes/${encodeURIComponent(capture.scene_id)}`, authHeaders);
  assert.equal(refreshedScene.scene.head.current_scene_version, 2, "refresh should preserve the committed latest editable scene version");
  assert.ok(refreshedScene.scene.bookmarks.some((entry: any) => entry.bookmark_id === bookmark.bookmark.bookmark_id), "refresh should preserve the saved bookmark sidecar");
  assert.ok(refreshedScene.scene.photoreal_gallery.some((entry: any) => entry.entry_id === photoreal.photoreal_entry.entry_id), "refresh should preserve the version-linked photoreal gallery entry");
  assert.equal(refreshedScene.scene.splat?.status, "ready", "refresh should preserve the ready splat sidecar for the scan pane swap");

  console.log(JSON.stringify({
    demo_steps: demo.steps.map((step) => step.action),
    latest_scene_version: refreshedScene.scene.head.current_scene_version,
    latest_snapshot_id: refreshedScene.scene.snapshot.snapshot_id,
    photoreal_entry_id: photoreal.photoreal_entry.entry_id,
    splat_asset_id: refreshedScene.scene.splat?.asset_id ?? null,
  }, null, 2));
  console.log("Verified reproducible end-to-end MVP flow from capture through refresh");
} finally {
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  rmSync(storageDirectory, { recursive: true, force: true });
}
