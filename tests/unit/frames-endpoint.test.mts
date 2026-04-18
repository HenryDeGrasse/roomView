/**
 * HTTP integration tests for POST /captures/{scene_id}/frames.
 *
 * The in-process verifier (scripts/import-capture-bundle.mts --synthetic)
 * exercises the service object. These tests go through the real Node http
 * server so we catch routing, body parsing, and artifact-URL regressions that
 * the in-process path would miss.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, test } from "node:test";

import { startApiHarness, type ApiHarness } from "../helpers/http-harness.ts";
import type {
  CaptureFrameInput,
  CaptureFramesRequest,
  CaptureFramesResponse,
  RoomPlanCaptureRequest,
  RoomPlanCaptureResponse,
  Scene,
} from "../../packages/contracts/src/index.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

function loadCapture(): RoomPlanCaptureRequest {
  const body = readFileSync(
    resolve(repoRoot, "fixtures", "roomplan", "bedroom-primary", "capture-request.json"),
    "utf8"
  );
  return JSON.parse(body) as RoomPlanCaptureRequest;
}

function synthesizeFrame(index: number): CaptureFrameInput {
  const width = 4;
  const height = 3;
  const depthBuffer = Buffer.alloc(width * height * 4);
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    depthBuffer.writeFloatLE(1.0 + pixel * 0.05, pixel * 4);
  }
  const confidenceBuffer = Buffer.alloc(width * height, 2);
  const jpegMagic = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  return {
    frame_id: `frame_${String(index + 1).padStart(4, "0")}`,
    captured_at: new Date(Date.UTC(2026, 3, 18, 12, index, 0)).toISOString(),
    camera_pose: { position: { x: index * 0.1, y: 1.5, z: -index * 0.05 }, yaw_degrees: index * 12 },
    camera_transform: [...identity.slice(0, 12), index * 0.1, 1.5, -index * 0.05, 1],
    intrinsics: { fx: 1450, fy: 1450, cx: width / 2, cy: height / 2, width, height },
    rgb_content_type: "image/jpeg",
    rgb_base64: jpegMagic.toString("base64"),
    depth_content_type: "application/x-numpy",
    depth_base64: depthBuffer.toString("base64"),
    confidence_content_type: "application/octet-stream",
    confidence_base64: confidenceBuffer.toString("base64"),
    bookmark_name: null,
  };
}

let ingestCounter = 0;
async function ingestScene(harness: ApiHarness): Promise<RoomPlanCaptureResponse> {
  ingestCounter += 1;
  const request = loadCapture();
  request.request_id = `frames-test-req-${ingestCounter}`;
  request.client_capture_id = `frames-test-capture-${ingestCounter}`;
  const response = await harness.fetch("/captures/roomplan", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
  });
  assert.equal(response.status, 200, `capture ingest failed (${response.status})`);
  return (await response.json()) as RoomPlanCaptureResponse;
}

describe("HTTP POST /captures/:scene_id/frames", () => {
  let harness: ApiHarness;

  before(async () => {
    harness = await startApiHarness();
  });

  after(async () => {
    await harness.close();
  });

  test("happy path: persists frames, materializes bookmarks, returns artifact URIs", async () => {
    const capture = await ingestScene(harness);
    assert.ok(capture.video_upload_token, "capture response must include a video_upload_token");

    const frames: CaptureFrameInput[] = [synthesizeFrame(0), synthesizeFrame(1)];
    const request: CaptureFramesRequest = {
      video_upload_token: capture.video_upload_token!,
      idempotency_key: `frames-happy-${capture.scene_id}`,
      frames,
    };

    const framesResponse = await harness.fetch(`/captures/${capture.scene_id}/frames`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    });
    assert.equal(framesResponse.status, 200);
    const body = (await framesResponse.json()) as CaptureFramesResponse;

    assert.equal(body.captured_frames.length, 2);
    const first = body.captured_frames[0]!;
    assert.equal(first.frame_id, frames[0]!.frame_id);
    assert.ok(first.bookmark_id, "bookmark_id should be materialized");
    assert.ok(first.rgb.uri.startsWith("/artifacts/photoreal/"), "rgb uri should be served from the artifact store");
    assert.ok(first.depth.uri.startsWith("/artifacts/photoreal/"), "depth uri should be served from the artifact store");
    assert.ok(first.confidence?.uri.startsWith("/artifacts/photoreal/"), "confidence uri should be served when provided");

    assert.equal(body.scene.captured_frames.length, 2, "scene.captured_frames mirrors response");
    const newBookmarkIds = new Set(body.captured_frames.map((frame) => frame.bookmark_id));
    const matchingBookmarks = body.scene.bookmarks.filter((bookmark) => newBookmarkIds.has(bookmark.bookmark_id));
    assert.equal(matchingBookmarks.length, 2, "scene.bookmarks gains one CameraBookmark per frame");
  });

  test("artifact URIs serve the bytes we uploaded", async () => {
    const capture = await ingestScene(harness);
    const frames = [synthesizeFrame(0)];
    const request: CaptureFramesRequest = {
      video_upload_token: capture.video_upload_token!,
      idempotency_key: `frames-artifact-${capture.scene_id}`,
      frames,
    };
    const framesResponse = await harness.fetch(`/captures/${capture.scene_id}/frames`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    });
    assert.equal(framesResponse.status, 200);
    const body = (await framesResponse.json()) as CaptureFramesResponse;

    const rgbUri = body.captured_frames[0]!.rgb.uri;
    const rgbResponse = await harness.fetch(rgbUri);
    assert.equal(rgbResponse.status, 200);
    assert.equal(rgbResponse.headers.get("content-type"), "image/jpeg");
    const rgbBytes = Buffer.from(await rgbResponse.arrayBuffer());
    assert.equal(rgbBytes.toString("base64"), frames[0]!.rgb_base64);

    const depthUri = body.captured_frames[0]!.depth.uri;
    const depthResponse = await harness.fetch(depthUri);
    assert.equal(depthResponse.status, 200);
    assert.equal(depthResponse.headers.get("content-type"), "application/x-numpy");
    const depthBytes = Buffer.from(await depthResponse.arrayBuffer());
    assert.equal(depthBytes.toString("base64"), frames[0]!.depth_base64);
  });

  test("idempotency: same key + body returns the cached response", async () => {
    const capture = await ingestScene(harness);
    const request: CaptureFramesRequest = {
      video_upload_token: capture.video_upload_token!,
      idempotency_key: `frames-idem-${capture.scene_id}`,
      frames: [synthesizeFrame(0)],
    };
    const first = await harness.fetch(`/captures/${capture.scene_id}/frames`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    });
    assert.equal(first.status, 200);
    const firstBody = (await first.json()) as CaptureFramesResponse;

    const second = await harness.fetch(`/captures/${capture.scene_id}/frames`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    });
    assert.equal(second.status, 200);
    const secondBody = (await second.json()) as CaptureFramesResponse;

    assert.equal(secondBody.captured_frames.length, firstBody.captured_frames.length);
    assert.equal(secondBody.captured_frames[0]!.frame_id, firstBody.captured_frames[0]!.frame_id);
    assert.equal(
      secondBody.scene.captured_frames.length,
      firstBody.scene.captured_frames.length,
      "replay must not duplicate scene.captured_frames"
    );
  });

  test("invalid video upload token returns VIDEO_UPLOAD_TOKEN_INVALID (409)", async () => {
    const capture = await ingestScene(harness);
    const request: CaptureFramesRequest = {
      video_upload_token: "not-the-real-token",
      idempotency_key: `frames-bad-token-${capture.scene_id}`,
      frames: [synthesizeFrame(0)],
    };
    const response = await harness.fetch(`/captures/${capture.scene_id}/frames`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    });
    assert.equal(response.status, 409);
    const body = await response.json();
    assert.equal(body.reason_code, "VIDEO_UPLOAD_TOKEN_INVALID");
  });

  test("empty frames array returns INVALID_CAPTURE (400)", async () => {
    const capture = await ingestScene(harness);
    const response = await harness.fetch(`/captures/${capture.scene_id}/frames`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        video_upload_token: capture.video_upload_token,
        idempotency_key: `frames-empty-${capture.scene_id}`,
        frames: [],
      }),
    });
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.reason_code, "INVALID_CAPTURE");
  });

  test("malformed intrinsics returns INVALID_CAPTURE (400)", async () => {
    const capture = await ingestScene(harness);
    const bad = synthesizeFrame(0);
    bad.intrinsics = { fx: 0, fy: -1, cx: 0, cy: 0, width: 1, height: 1 };
    const response = await harness.fetch(`/captures/${capture.scene_id}/frames`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        video_upload_token: capture.video_upload_token,
        idempotency_key: `frames-badint-${capture.scene_id}`,
        frames: [bad],
      }),
    });
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.reason_code, "INVALID_CAPTURE");
  });

  test("frames survive scene read after ingest (captured_frames field present)", async () => {
    const capture = await ingestScene(harness);
    const sceneId = capture.scene_id;

    const handoffToken = JSON.parse(capture.qr_payload).handoff_token as string;
    const redeem = await harness.fetch("/handoffs/redeem", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ handoff_token: handoffToken }),
    });
    assert.equal(redeem.status, 200);
    const { session_id: sessionId } = (await redeem.json()) as { session_id: string };

    const framesRequest: CaptureFramesRequest = {
      video_upload_token: capture.video_upload_token!,
      idempotency_key: `frames-read-${sceneId}`,
      frames: [synthesizeFrame(0)],
    };
    const framesResponse = await harness.fetch(`/captures/${sceneId}/frames`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(framesRequest),
    });
    assert.equal(framesResponse.status, 200);

    const sceneResponse = await harness.fetch(`/scenes/${sceneId}`, {
      headers: { authorization: `Bearer ${sessionId}` },
    });
    assert.equal(sceneResponse.status, 200);
    const sceneBody = (await sceneResponse.json()) as { scene: Scene };
    assert.equal(sceneBody.scene.captured_frames.length, 1);
    assert.equal(sceneBody.scene.captured_frames[0]!.frame_id, "frame_0001");
    assert.ok(sceneBody.scene.captured_frames[0]!.bookmark_id, "captured_frame must carry a bookmark_id");
  });
});
