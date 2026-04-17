import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

import {
  buildInitialSceneFromRoomPlanCapture,
  decomposeIngestedCaptureForStorage,
  hydrateSceneFromStoredRecords,
  ingestRoomPlanCaptureRequest,
} from "../apps/api/src/index.ts";

interface FixtureDescriptor {
  fixture_id: string;
  request_path: string;
  scene_path: string;
}

interface FixtureManifest {
  fixtures: FixtureDescriptor[];
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function readJson<T>(relativePath: string): T {
  return JSON.parse(readFileSync(resolve(repoRoot, relativePath), "utf8")) as T;
}

function normalizeQrPayload(qrPayload: string): Record<string, unknown> {
  const parsed = JSON.parse(qrPayload) as Record<string, unknown>;
  return {
    ...parsed,
    handoff_token: parsed.handoff_token ? "<opaque>" : parsed.handoff_token,
  };
}

function normalizeHandoffUrl(handoffUrl: string): string {
  const parsed = new URL(handoffUrl);
  const segments = parsed.pathname.split("/").filter(Boolean);
  if (segments.length > 0) {
    segments[segments.length - 1] = "<opaque>";
  }
  parsed.pathname = `/${segments.join("/")}`;
  return parsed.toString();
}

function normalizePersistedRecords(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(normalizePersistedRecords);
  }

  const record = value as Record<string, unknown>;
  const normalized: Record<string, unknown> = {};
  for (const [key, current] of Object.entries(record)) {
    if (key === "qr_payload" && typeof current === "string") {
      normalized[key] = normalizeQrPayload(current);
      continue;
    }
    if (key === "handoff_url" && typeof current === "string") {
      normalized[key] = normalizeHandoffUrl(current);
      continue;
    }
    if (key === "grant_id" || key === "token_id" || key === "token_hash") {
      normalized[key] = "<opaque>";
      continue;
    }
    if (key === "video_upload_token") {
      normalized[key] = current === null ? null : "<opaque>";
      continue;
    }
    normalized[key] = normalizePersistedRecords(current);
  }
  return normalized;
}

const manifest = readJson<FixtureManifest>("fixtures/manifest.json");

for (const fixture of manifest.fixtures) {
  const request = readJson(fixture.request_path);
  const expectedScene = readJson(fixture.scene_path);
  const replay = buildInitialSceneFromRoomPlanCapture(request).scene;

  assert.deepStrictEqual(
    replay,
    expectedScene,
    `${fixture.fixture_id}: replayed scene does not match ${fixture.scene_path}`
  );

  const ingestedA = ingestRoomPlanCaptureRequest(request);
  const ingestedB = ingestRoomPlanCaptureRequest(request);
  const persistedA = decomposeIngestedCaptureForStorage(ingestedA);
  const persistedB = decomposeIngestedCaptureForStorage(ingestedB);

  assert.deepStrictEqual(
    hydrateSceneFromStoredRecords(persistedA),
    ingestedA.scene,
    `${fixture.fixture_id}: stored records do not hydrate back to the canonical scene`
  );

  assert.deepStrictEqual(
    normalizePersistedRecords(persistedA),
    normalizePersistedRecords(persistedB),
    `${fixture.fixture_id}: persisted records are not deterministic across replays`
  );

  assert.deepStrictEqual(
    normalizePersistedRecords(ingestedA.response),
    normalizePersistedRecords(ingestedB.response),
    `${fixture.fixture_id}: capture responses are not deterministic across replays`
  );
}

console.log(`Verified deterministic replay parity for ${manifest.fixtures.length} fixture scene(s)`);
