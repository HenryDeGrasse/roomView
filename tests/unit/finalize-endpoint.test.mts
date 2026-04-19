/**
 * HTTP integration tests for POST /captures/{scene_id}/finalize.
 *
 * The finalize endpoint promotes an uploaded capture (RoomPlan payload +
 * captured frames) into a persistent fixture directory under a temp repo
 * root, then kicks off the splat/texture pipeline. These tests stub out the
 * pipeline runner with a success sentinel so we exercise the promotion +
 * job bookkeeping paths without shelling out to `uv`.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, test } from "node:test";

import { createRoomPlanApiServer } from "../../apps/api/src/server.ts";
import type { CapturePipelineInputs, CapturePipelineResult } from "../../apps/api/src/capture-pipeline.ts";
import type {
  CaptureFrameInput,
  CaptureFramesRequest,
  CaptureFramesResponse,
  FinalizeCaptureRequest,
  FinalizeCaptureResponse,
  FixtureManifest,
  JobReadResponse,
  RoomPlanCaptureRequest,
  RoomPlanCaptureResponse,
  Scene,
} from "../../packages/contracts/src/index.ts";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const thisDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(thisDir, "..", "..");

function loadBaseCapture(): RoomPlanCaptureRequest {
  const body = readFileSync(
    resolve(repoRoot, "fixtures", "roomplan", "bedroom-primary", "capture-request.json"),
    "utf8"
  );
  return JSON.parse(body) as RoomPlanCaptureRequest;
}

function synthFrame(index: number): CaptureFrameInput {
  const width = 4;
  const height = 3;
  const depthBuffer = Buffer.alloc(width * height * 4);
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    depthBuffer.writeFloatLE(1.0 + pixel * 0.05, pixel * 4);
  }
  const jpegMagic = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
  return {
    frame_id: `frame_${String(index + 1).padStart(4, "0")}`,
    captured_at: new Date(Date.UTC(2026, 3, 18, 12, index, 0)).toISOString(),
    camera_pose: { position: { x: index * 0.1, y: 1.5, z: -index * 0.05 }, yaw_degrees: index * 12 },
    camera_transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, index * 0.1, 1.5, -index * 0.05, 1],
    intrinsics: { fx: 1450, fy: 1450, cx: width / 2, cy: height / 2, width, height },
    rgb_content_type: "image/jpeg",
    rgb_base64: jpegMagic.toString("base64"),
    depth_content_type: "application/x-numpy",
    depth_base64: depthBuffer.toString("base64"),
    bookmark_name: null,
  };
}

describe("HTTP POST /captures/:scene_id/finalize", () => {
  let server: ReturnType<typeof createRoomPlanApiServer>;
  let baseUrl: string;
  let tmpStorage: string;
  let tmpFixtureRoot: string;
  let recordedRunnerInvocations: CapturePipelineInputs[] = [];

  before(async () => {
    tmpStorage = mkdtempSync(join(tmpdir(), "roomview-finalize-"));
    tmpFixtureRoot = mkdtempSync(join(tmpdir(), "roomview-fixture-root-"));
    // The promotion code expects `<repo-root>/fixtures/roomplan/...` and a
    // `<repo-root>/fixtures/manifest.json`. Materialize an empty skeleton so
    // the test's appendFixtureToManifest doesn't blow up.
    mkdirSync(resolve(tmpFixtureRoot, "fixtures", "roomplan"), { recursive: true });

    const stubRunner = async (inputs: CapturePipelineInputs): Promise<CapturePipelineResult> => {
      recordedRunnerInvocations.push({
        fixture_id: inputs.fixture_id,
        repo_root: inputs.repo_root,
        has_roomplan_shell: inputs.has_roomplan_shell,
        on_stage_change: () => {},
      });
      inputs.on_stage_change({ stage: "splat", message: "stub splat" });
      inputs.on_stage_change({ stage: "textures", message: "stub textures" });
      return {
        success: true,
        failed_stage: null,
        stages_completed: ["splat", "textures", "complete"],
        error_tail: null,
      };
    };

    server = createRoomPlanApiServer({
      storage_directory: tmpStorage,
      handoff_base_url: "http://127.0.0.1/handoff",
      token_secret: "test-secret",
      fixture_repo_root: tmpFixtureRoot,
      fixture_web_base_url: "http://127.0.0.1:4173",
      capture_pipeline_runner: stubRunner,
    });

    await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", () => resolvePromise()));
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  after(async () => {
    await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    rmSync(tmpStorage, { recursive: true, force: true });
    rmSync(tmpFixtureRoot, { recursive: true, force: true });
  });

  async function ingestCapture(idSuffix: string): Promise<RoomPlanCaptureResponse> {
    const request = loadBaseCapture();
    request.request_id = `finalize-req-${idSuffix}`;
    request.client_capture_id = `finalize-capture-${idSuffix}`;
    request.capture_metadata = { ...request.capture_metadata, video_expected: true };
    const response = await fetch(`${baseUrl}/captures/roomplan`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    });
    assert.equal(response.status, 200, "capture ingest failed");
    return (await response.json()) as RoomPlanCaptureResponse;
  }

  async function uploadFrames(capture: RoomPlanCaptureResponse): Promise<CaptureFramesResponse> {
    const request: CaptureFramesRequest = {
      video_upload_token: capture.video_upload_token!,
      idempotency_key: `frames-${capture.scene_id}`,
      frames: [synthFrame(0), synthFrame(1)],
    };
    const response = await fetch(`${baseUrl}/captures/${capture.scene_id}/frames`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    });
    assert.equal(response.status, 200);
    return (await response.json()) as CaptureFramesResponse;
  }

  test("happy path: promotes to fixture, writes manifest, kicks pipeline, returns job", async () => {
    recordedRunnerInvocations = [];
    const capture = await ingestCapture("happy");
    await uploadFrames(capture);

    const finalize: FinalizeCaptureRequest = {
      video_upload_token: capture.video_upload_token!,
      idempotency_key: `finalize-happy-${capture.scene_id}`,
      room_label: "Living Room",
    };
    const response = await fetch(`${baseUrl}/captures/${capture.scene_id}/finalize`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(finalize),
    });
    assert.equal(response.status, 200);
    const body = (await response.json()) as FinalizeCaptureResponse;

    // Returned job + result
    assert.equal(body.job.job_kind, "capture_pipeline");
    assert.match(body.result.fixture_id, /^capture-living-room-/);
    assert.equal(
      body.result.fixture_url,
      `http://127.0.0.1:4173/?fixture=${encodeURIComponent(body.result.fixture_id)}`
    );

    // Fixture dir written under the temp repo root
    const fixtureDir = resolve(tmpFixtureRoot, "fixtures", "roomplan", body.result.fixture_id);
    assert.ok(existsSync(fixtureDir), "fixture dir should be created");
    assert.ok(existsSync(resolve(fixtureDir, "scene.json")), "fixture dir should contain scene.json");
    assert.ok(existsSync(resolve(fixtureDir, "capture-request.json")), "fixture dir should contain capture-request.json");
    assert.ok(existsSync(resolve(fixtureDir, "frames")), "fixture dir should contain frames/");

    // scene.json should have captured_frames rewritten to /dev/fixtures/<id>/frames/...
    const promotedScene = JSON.parse(readFileSync(resolve(fixtureDir, "scene.json"), "utf8")) as Scene;
    assert.equal(promotedScene.captured_frames.length, 2);
    for (const frame of promotedScene.captured_frames) {
      assert.ok(
        frame.rgb.uri.startsWith(`/dev/fixtures/${body.result.fixture_id}/frames/`),
        `rgb uri should be rewritten to /dev/fixtures/... got: ${frame.rgb.uri}`
      );
      assert.ok(
        frame.depth.uri.startsWith(`/dev/fixtures/${body.result.fixture_id}/frames/`),
        `depth uri should be rewritten to /dev/fixtures/... got: ${frame.depth.uri}`
      );
    }

    // Manifest entry
    const manifestPath = resolve(tmpFixtureRoot, "fixtures", "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as FixtureManifest;
    const entry = manifest.fixtures.find((f) => f.fixture_id === body.result.fixture_id);
    assert.ok(entry, "manifest should contain the new fixture entry");
    assert.equal(entry!.scene_path, `fixtures/roomplan/${body.result.fixture_id}/scene.json`);

    // Pipeline runner invoked once with the right inputs
    assert.equal(recordedRunnerInvocations.length, 1);
    assert.equal(recordedRunnerInvocations[0]!.fixture_id, body.result.fixture_id);
    assert.equal(recordedRunnerInvocations[0]!.repo_root, tmpFixtureRoot);
  });

  test("returns 400 when no frames were uploaded", async () => {
    const capture = await ingestCapture("no-frames");
    const finalize: FinalizeCaptureRequest = {
      video_upload_token: capture.video_upload_token!,
      idempotency_key: `finalize-nf-${capture.scene_id}`,
      room_label: null,
    };
    const response = await fetch(`${baseUrl}/captures/${capture.scene_id}/finalize`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(finalize),
    });
    assert.equal(response.status, 400);
    const body = (await response.json()) as { reason_code: string };
    assert.equal(body.reason_code, "CAPTURE_NO_FRAMES");
  });

  test("idempotency: same key returns the cached response (no duplicate promotion)", async () => {
    recordedRunnerInvocations = [];
    const capture = await ingestCapture("idem");
    await uploadFrames(capture);

    const finalize: FinalizeCaptureRequest = {
      video_upload_token: capture.video_upload_token!,
      idempotency_key: `finalize-idem-${capture.scene_id}`,
      room_label: "Kitchen",
    };
    const firstResponse = await fetch(`${baseUrl}/captures/${capture.scene_id}/finalize`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(finalize),
    });
    assert.equal(firstResponse.status, 200);
    const firstBody = (await firstResponse.json()) as FinalizeCaptureResponse;

    const secondResponse = await fetch(`${baseUrl}/captures/${capture.scene_id}/finalize`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(finalize),
    });
    assert.equal(secondResponse.status, 200);
    const secondBody = (await secondResponse.json()) as FinalizeCaptureResponse;

    assert.equal(secondBody.job.job_id, firstBody.job.job_id, "idempotent finalize returns same job_id");
    assert.equal(secondBody.result.fixture_id, firstBody.result.fixture_id);
    assert.equal(recordedRunnerInvocations.length, 1, "pipeline runner should only fire once for duplicate finalize");
  });

  test("invalid token returns VIDEO_UPLOAD_TOKEN_INVALID", async () => {
    const capture = await ingestCapture("bad-token");
    await uploadFrames(capture);
    const finalize: FinalizeCaptureRequest = {
      video_upload_token: "definitely-not-a-real-token",
      idempotency_key: `finalize-bad-${capture.scene_id}`,
      room_label: null,
    };
    const response = await fetch(`${baseUrl}/captures/${capture.scene_id}/finalize`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(finalize),
    });
    // Token errors map to 409 in the existing status-code table to match
    // the video / frames endpoints.
    assert.equal(response.status, 409);
    const body = (await response.json()) as { reason_code: string };
    assert.equal(body.reason_code, "VIDEO_UPLOAD_TOKEN_INVALID");
  });

  test("pipeline job status transitions to ready after stub runner completes", async () => {
    const capture = await ingestCapture("status");
    await uploadFrames(capture);

    const finalize: FinalizeCaptureRequest = {
      video_upload_token: capture.video_upload_token!,
      idempotency_key: `finalize-status-${capture.scene_id}`,
      room_label: "Bedroom",
    };
    const response = await fetch(`${baseUrl}/captures/${capture.scene_id}/finalize`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(finalize),
    });
    assert.equal(response.status, 200);
    const body = (await response.json()) as FinalizeCaptureResponse;

    // Authenticate for job-read: redeem the handoff token to get a session_id,
    // then use that as the Bearer token (matches the /scenes/:id pattern).
    const handoffToken = extractToken(capture.qr_payload);
    const redeemResponse = await fetch(`${baseUrl}/handoffs/redeem`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ handoff_token: handoffToken }),
    });
    assert.equal(redeemResponse.status, 200);
    const redeemBody = (await redeemResponse.json()) as { session_id: string };

    // Pipeline runs async — poll until ready (or timeout after 2s of 50ms ticks).
    let jobReadResponse: JobReadResponse | null = null;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      await new Promise((r) => setTimeout(r, 50));
      const polled = await fetch(`${baseUrl}/jobs/${body.job.job_id}`, {
        headers: { Authorization: `Bearer ${redeemBody.session_id}` },
      });
      if (polled.status !== 200) continue;
      jobReadResponse = (await polled.json()) as JobReadResponse;
      if (jobReadResponse.job.status === "ready" || jobReadResponse.job.status === "failed") break;
    }
    assert.ok(jobReadResponse, "job read should succeed");
    assert.equal(jobReadResponse!.job.status, "ready");
    assert.equal(jobReadResponse!.job.stage, "complete");
    assert.ok(jobReadResponse!.capture_pipeline_result, "capture_pipeline_result should be populated");
    assert.equal(jobReadResponse!.capture_pipeline_result!.fixture_id, body.result.fixture_id);
  });
});

function extractToken(qrPayload: string): string {
  const parsed = JSON.parse(qrPayload) as { handoff_token: string };
  return parsed.handoff_token;
}
