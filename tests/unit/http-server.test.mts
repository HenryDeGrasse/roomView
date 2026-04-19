/**
 * HTTP integration tests against the real Node http server exported by
 * apps/api/src/server.ts.
 *
 * Each test boots a fresh server on an ephemeral port with a temp storage
 * directory. These tests exercise:
 *   - 404 for unknown routes
 *   - 401/403 for missing / wrong session
 *   - malformed JSON → 400
 *   - OPTIONS preflight
 *   - end-to-end happy path: POST capture → POST handoff/redeem → GET scene
 *   - GET /assets/manifest and /scenes/:id/quick-render shape
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, test } from "node:test";

import { startApiHarness, type ApiHarness } from "../helpers/http-harness.mts";
import type { RoomPlanCaptureRequest } from "../../packages/contracts/src/index.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

function loadCaptureFixture(fixture: "bedroom-primary" | "bedroom-obstacle" = "bedroom-primary"): RoomPlanCaptureRequest {
  const body = readFileSync(resolve(repoRoot, "fixtures", "roomplan", fixture, "capture-request.json"), "utf8");
  return JSON.parse(body) as RoomPlanCaptureRequest;
}

describe("HTTP API — routing + error paths", () => {
  let harness: ApiHarness;

  before(async () => {
    harness = await startApiHarness();
  });

  after(async () => {
    await harness.close();
  });

  test("unknown route returns 404", async () => {
    const response = await harness.fetch("/definitely/not/a/route");
    assert.equal(response.status, 404);
    const body = await response.json();
    assert.equal(body.message, "Not found.");
  });

  test("OPTIONS preflight returns 204 with CORS headers", async () => {
    const response = await harness.fetch("/captures/roomplan", { method: "OPTIONS" });
    assert.equal(response.status, 204);
    assert.equal(response.headers.get("access-control-allow-origin"), "*");
    const methods = response.headers.get("access-control-allow-methods") ?? "";
    assert.ok(methods.includes("POST"));
    assert.ok(methods.includes("OPTIONS"));
  });

  test("GET /assets/manifest returns the curated manifest (no auth required)", async () => {
    const response = await harness.fetch("/assets/manifest");
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.ok(body.manifest);
    assert.ok(Array.isArray(body.manifest.assets));
    assert.ok(body.manifest.assets.length > 0);
  });

  test("POST /captures/roomplan with empty body returns 400 INVALID_CAPTURE", async () => {
    const response = await harness.fetch("/captures/roomplan", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "",
    });
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.reason_code, "INVALID_CAPTURE");
  });

  test("POST /captures/roomplan with non-JSON body returns 400", async () => {
    const response = await harness.fetch("/captures/roomplan", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not valid json",
    });
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.reason_code, "INVALID_CAPTURE");
  });

  test("GET /scenes/:id without session header returns 401 AUTH_REQUIRED", async () => {
    const response = await harness.fetch("/scenes/nonexistent-scene");
    assert.equal(response.status, 401);
    const body = await response.json();
    assert.equal(body.reason_code, "AUTH_REQUIRED");
  });

  test("GET /scenes/:id with a wrong bearer token returns 403 SCENE_ACCESS_DENIED", async () => {
    const response = await harness.fetch("/scenes/nonexistent-scene", {
      headers: { authorization: "Bearer fake-session" },
    });
    assert.equal(response.status, 403);
    const body = await response.json();
    assert.equal(body.reason_code, "SCENE_ACCESS_DENIED");
  });

  test("GET /jobs/:id returns 404 for unknown job", async () => {
    const response = await harness.fetch("/jobs/does-not-exist");
    assert.equal(response.status, 404);
    const body = await response.json();
    assert.equal(body.reason_code, "TARGET_NOT_FOUND");
  });
});

describe("HTTP API — end-to-end capture → redeem → read", () => {
  let harness: ApiHarness;
  let sceneId: string;
  let sessionId: string;

  before(async () => {
    harness = await startApiHarness();
  });

  after(async () => {
    await harness.close();
  });

  test("POST /captures/roomplan returns a scene_id, handoff url, qr payload", async () => {
    const request = loadCaptureFixture();
    const response = await harness.fetch("/captures/roomplan", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(typeof body.scene_id, "string");
    assert.ok(body.scene_id.startsWith("scene-"), `unexpected scene_id ${body.scene_id}`);
    assert.equal(body.scene_version, 1);
    assert.ok(body.handoff_url.startsWith("http://127.0.0.1/handoff"));
    assert.ok(body.qr_payload.length > 0);
    sceneId = body.scene_id;

    // Extract the raw handoff token from qr_payload (JSON with { handoff_token }).
    const parsed = JSON.parse(body.qr_payload) as { handoff_token: string };
    assert.ok(parsed.handoff_token, "qr_payload must include handoff_token");
    (globalThis as unknown as { __handoff_token?: string }).__handoff_token = parsed.handoff_token;
  });

  test("POST /handoffs/redeem exchanges the token for a session_id", async () => {
    const token = (globalThis as unknown as { __handoff_token?: string }).__handoff_token ?? "";
    const response = await harness.fetch("/handoffs/redeem", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ handoff_token: token }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.scene_id, sceneId);
    assert.equal(typeof body.session_id, "string");
    sessionId = body.session_id;
  });

  test("GET /scenes/:id with the session token returns the scene", async () => {
    const response = await harness.fetch(`/scenes/${sceneId}`, {
      headers: { authorization: `Bearer ${sessionId}` },
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.scene.head.scene_id, sceneId);
    assert.equal(body.scene.head.current_scene_version, 1);
  });

  test("GET /scenes/:id/quick-render returns a QuickRenderScene with matching scene_id", async () => {
    const response = await harness.fetch(`/scenes/${sceneId}/quick-render`, {
      headers: { "x-session-id": sessionId },
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.render_scene.scene_id, sceneId);
    assert.ok(Array.isArray(body.render_scene.asset_bindings));
  });

  test("GET /scenes/:otherId with the session token returns 403 (session scoped to its scene)", async () => {
    const response = await harness.fetch(`/scenes/${sceneId}-other`, {
      headers: { authorization: `Bearer ${sessionId}` },
    });
    assert.equal(response.status, 403);
    const body = await response.json();
    assert.equal(body.reason_code, "SCENE_ACCESS_DENIED");
  });

  test("Double-redeem of the same handoff token returns HANDOFF_ALREADY_USED", async () => {
    const token = (globalThis as unknown as { __handoff_token?: string }).__handoff_token ?? "";
    const response = await harness.fetch("/handoffs/redeem", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ handoff_token: token }),
    });
    assert.notEqual(response.status, 200);
    const body = await response.json();
    assert.equal(body.reason_code, "HANDOFF_ALREADY_USED");
  });

  test("Redeem with a garbage token returns SCENE_ACCESS_DENIED", async () => {
    const response = await harness.fetch("/handoffs/redeem", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ handoff_token: "totally-wrong" }),
    });
    assert.notEqual(response.status, 200);
    const body = await response.json();
    assert.equal(body.reason_code, "SCENE_ACCESS_DENIED");
  });
});
