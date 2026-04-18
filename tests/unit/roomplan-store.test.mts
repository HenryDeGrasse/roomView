/**
 * FileSystemRoomPlanCaptureRecordStore unit tests.
 *
 * Covers:
 *  - atomic write (rename-after-write) so a crash mid-write can't leave a
 *    half-written JSON file
 *  - loadAll ignores non-JSON entries and returns parsed records
 *  - save is idempotent on scene_id (overwrites in place)
 *  - round-trip across save/loadAll preserves shape
 */
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

import { FileSystemRoomPlanCaptureRecordStore } from "../../apps/api/src/roomplan-store.ts";
import type { PersistedRoomPlanCaptureRecord } from "../../apps/api/src/roomplan-store.ts";
import {
  decomposeIngestedCaptureForStorage,
  type PersistedInitialSceneRecords,
} from "../../apps/api/src/roomplan-persistence.ts";
import type { HandoffGrantRecord, Scene } from "../../packages/contracts/src/index.ts";
import { buildMinimalScene } from "../helpers/scene-builder.ts";

function withTempDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "roomview-store-test-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function buildPersistedInitialSceneRecords(scene: Scene): PersistedInitialSceneRecords {
  const handoff: HandoffGrantRecord = {
    grant_id: "grant:test",
    scene_id: scene.head.scene_id,
    token_hash: "t".repeat(64),
    qr_payload: "qr://test",
    status: "issued",
    expires_at: "2026-04-17T01:00:00.000Z",
    redeemed_at: null,
    redeemed_session_id: null,
  };
  return decomposeIngestedCaptureForStorage({
    scene,
    scene_id: scene.head.scene_id,
    scene_snapshot_id: scene.snapshot.snapshot_id,
    handoff_grant: handoff,
    video_upload_token_record: null,
    response: {
      scene_id: scene.head.scene_id,
      scene_version: scene.head.current_scene_version,
      scene_snapshot_id: scene.snapshot.snapshot_id,
      handoff_url: "https://example.com/handoff",
      qr_payload: handoff.qr_payload,
      expires_at: handoff.expires_at,
      video_upload_token: null,
    },
  });
}

function buildRecord(scene: Scene): PersistedRoomPlanCaptureRecord {
  return {
    request_fingerprint: "fp-" + scene.head.scene_id,
    request_id: "req-1",
    client_capture_id: "client-1",
    persisted_records: buildPersistedInitialSceneRecords(scene),
  };
}

describe("FileSystemRoomPlanCaptureRecordStore", () => {
  test("loadAll on an empty directory returns []", () => {
    withTempDir((dir) => {
      const store = new FileSystemRoomPlanCaptureRecordStore(dir);
      assert.deepEqual(store.loadAll(), []);
    });
  });

  test("loadAll ignores non-.json files (directories, tmp files)", () => {
    withTempDir((dir) => {
      const store = new FileSystemRoomPlanCaptureRecordStore(dir);
      writeFileSync(join(dir, "ignore.txt"), "noise");
      writeFileSync(join(dir, "scene-1.json.tmp-9999"), "{}"); // fake tmp from aborted write
      assert.deepEqual(store.loadAll(), []);
    });
  });

  test("save then loadAll round-trips a record", () => {
    withTempDir((dir) => {
      const store = new FileSystemRoomPlanCaptureRecordStore(dir);
      const scene = buildMinimalScene({ scene_id: "scene:rt", objects: [] });
      const record = buildRecord(scene);
      store.save(record);
      const loaded = store.loadAll();
      assert.equal(loaded.length, 1);
      assert.equal(loaded[0].persisted_records.scene_head.scene_id, "scene:rt");
      assert.equal(loaded[0].request_id, "req-1");
    });
  });

  test("save is idempotent per scene_id (overwrites, does not duplicate)", () => {
    withTempDir((dir) => {
      const store = new FileSystemRoomPlanCaptureRecordStore(dir);
      const scene = buildMinimalScene({ scene_id: "scene:overwrite", objects: [] });
      const firstRecord = buildRecord(scene);
      store.save(firstRecord);

      const secondRecord = { ...firstRecord, request_id: "req-2" };
      store.save(secondRecord);

      const files = readdirSync(dir).filter((name) => name.endsWith(".json"));
      assert.equal(files.length, 1);

      const loaded = store.loadAll();
      assert.equal(loaded.length, 1);
      assert.equal(loaded[0].request_id, "req-2");
    });
  });

  test("save uses an atomic rename (tmp file is not left behind on normal success)", () => {
    withTempDir((dir) => {
      const store = new FileSystemRoomPlanCaptureRecordStore(dir);
      const scene = buildMinimalScene({ scene_id: "scene:atomic", objects: [] });
      store.save(buildRecord(scene));
      const remaining = readdirSync(dir);
      for (const name of remaining) {
        assert.ok(!name.includes(".tmp-"), `unexpected tmp file after save: ${name}`);
      }
    });
  });

  test("constructor creates the directory recursively if it does not exist", () => {
    withTempDir((dir) => {
      const nested = join(dir, "a", "b", "c");
      new FileSystemRoomPlanCaptureRecordStore(nested);
      const found = readdirSync(nested);
      assert.ok(Array.isArray(found));
    });
  });

  test("loadAll tolerates many stored records", () => {
    withTempDir((dir) => {
      const store = new FileSystemRoomPlanCaptureRecordStore(dir);
      for (let index = 0; index < 5; index += 1) {
        const scene = buildMinimalScene({ scene_id: `scene:${index}`, objects: [] });
        store.save(buildRecord(scene));
      }
      const loaded = store.loadAll();
      assert.equal(loaded.length, 5);
      const ids = new Set(loaded.map((record) => record.persisted_records.scene_head.scene_id));
      assert.equal(ids.size, 5);
    });
  });
});
