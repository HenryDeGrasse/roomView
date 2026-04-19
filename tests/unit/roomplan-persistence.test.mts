/**
 * roomplan-persistence unit tests.
 *
 * Covers decompose/hydrate round-trip invariants that the verify scripts
 * don't assert because they only replay ingest-generated artifacts end to
 * end. These tests:
 *   - prove hydrate ∘ decompose is the identity on the Scene portion
 *   - prove decompose produces defensive copies (mutating output must not
 *     touch input)
 *   - exercise null-splat, null-derived-state-cache, no-bookmark paths.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  decomposeIngestedCaptureForStorage,
  hydrateSceneFromStoredRecords,
} from "../../apps/api/src/roomplan-persistence.ts";
import type { IngestedCaptureArtifacts } from "../../apps/api/src/roomplan-ingest.ts";
import type {
  HandoffGrantRecord,
  Scene,
} from "../../packages/contracts/src/index.ts";
import { buildMinimalScene } from "../helpers/scene-builder.mts";

function buildIngested(scene: Scene): IngestedCaptureArtifacts {
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
  return {
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
  };
}

describe("decomposeIngestedCaptureForStorage", () => {
  test("propagates scene_head + created_at + deleted_at=null", () => {
    const scene = buildMinimalScene({ objects: [] });
    const records = decomposeIngestedCaptureForStorage(buildIngested(scene));
    assert.equal(records.scene_head.scene_id, scene.head.scene_id);
    assert.equal(records.scene_head.created_at, scene.snapshot.created_at);
    assert.equal(records.scene_head.deleted_at, null);
  });

  test("null splat stays null", () => {
    const scene = buildMinimalScene({ objects: [] });
    scene.splat = null;
    const records = decomposeIngestedCaptureForStorage(buildIngested(scene));
    assert.equal(records.splat_asset_record, null);
  });

  test("splat present is deep-cloned", () => {
    const scene = buildMinimalScene({ objects: [] });
    scene.splat = {
      scene_id: scene.head.scene_id,
      source_scene_version: 1,
      status: "queued",
      asset_id: null,
      uri: null,
      updated_at: scene.head.updated_at,
    };
    const records = decomposeIngestedCaptureForStorage(buildIngested(scene));
    assert.ok(records.splat_asset_record);
    assert.notEqual(records.splat_asset_record, scene.splat, "must be a deep copy");
    assert.equal(records.splat_asset_record.status, "queued");

    // Mutate source; decomposed record must stay pristine.
    scene.splat!.status = "failed";
    assert.equal(records.splat_asset_record.status, "queued");
  });

  test("null derived_state_cache stays null", () => {
    const scene = buildMinimalScene({ objects: [] });
    scene.derived_state_cache = null;
    const records = decomposeIngestedCaptureForStorage(buildIngested(scene));
    assert.equal(records.derived_state_cache, null);
  });

  test("derived_state_cache persists with snapshot_id + scene_id cross-reference", () => {
    const scene = buildMinimalScene({ objects: [] });
    scene.derived_state_cache = {
      zones: [],
      clearance_paths: [],
      soft_scores: {},
      hard_violations: [],
      selection_context_summary: "test summary",
    };
    const records = decomposeIngestedCaptureForStorage(buildIngested(scene));
    assert.ok(records.derived_state_cache);
    assert.equal(records.derived_state_cache.snapshot_id, scene.snapshot.snapshot_id);
    assert.equal(records.derived_state_cache.scene_id, scene.head.scene_id);
    assert.equal(records.derived_state_cache.scene_version, scene.head.current_scene_version);
  });

  test("bookmarks + photoreal entries are tagged with scene_id", () => {
    const scene = buildMinimalScene({ objects: [] });
    scene.bookmarks = [
      {
        bookmark_id: "bm:1",
        name: "door view",
        camera_pose: { position: { x: 0, y: 0, z: 1.6 }, yaw_degrees: 0 },
        fov: 65,
        created_at: scene.head.updated_at,
        updated_at: scene.head.updated_at,
      },
    ];
    scene.photoreal_gallery = [
      {
        entry_id: "entry:1",
        asset_id: "asset-photoreal-1",
        scene_version: 1,
        scene_snapshot_id: scene.snapshot.snapshot_id,
        bookmark_id: null,
        camera_pose: { position: { x: 0, y: 0, z: 1.6 }, yaw_degrees: 0 },
        fov: 65,
        prompt_modifiers: ["modern"],
        created_at: scene.head.updated_at,
      },
    ];

    const records = decomposeIngestedCaptureForStorage(buildIngested(scene));
    assert.equal(records.camera_bookmarks.length, 1);
    assert.equal(records.camera_bookmarks[0].scene_id, scene.head.scene_id);
    assert.equal(records.photoreal_entries.length, 1);
    assert.equal(records.photoreal_entries[0].scene_id, scene.head.scene_id);
  });
});

describe("hydrateSceneFromStoredRecords", () => {
  test("decompose → hydrate is the identity on the scene portion", () => {
    const originalScene = buildMinimalScene({
      objects: [{ object_id: "obj:1", class: "bed" }],
    });
    originalScene.derived_state_cache = {
      zones: [],
      clearance_paths: [],
      soft_scores: { desk_near_window: 1 },
      hard_violations: [],
      selection_context_summary: "ok",
    };
    originalScene.bookmarks = [
      {
        bookmark_id: "bm:1",
        name: "door view",
        camera_pose: { position: { x: 0, y: 0, z: 1.6 }, yaw_degrees: 0 },
        fov: 65,
        created_at: originalScene.head.updated_at,
        updated_at: originalScene.head.updated_at,
      },
    ];

    const records = decomposeIngestedCaptureForStorage(buildIngested(originalScene));
    const hydrated = hydrateSceneFromStoredRecords(records);
    assert.deepEqual(hydrated, originalScene);
  });

  test("hydrate strips created_at/deleted_at from scene_head", () => {
    const scene = buildMinimalScene({ objects: [] });
    const records = decomposeIngestedCaptureForStorage(buildIngested(scene));
    const hydrated = hydrateSceneFromStoredRecords(records);
    assert.ok(!("created_at" in hydrated.head));
    assert.ok(!("deleted_at" in hydrated.head));
  });

  test("hydrated bookmarks drop scene_id field", () => {
    const scene = buildMinimalScene({ objects: [] });
    scene.bookmarks = [
      {
        bookmark_id: "bm:1",
        name: "door view",
        camera_pose: { position: { x: 0, y: 0, z: 1.6 }, yaw_degrees: 0 },
        fov: 65,
        created_at: scene.head.updated_at,
        updated_at: scene.head.updated_at,
      },
    ];
    const records = decomposeIngestedCaptureForStorage(buildIngested(scene));
    const hydrated = hydrateSceneFromStoredRecords(records);
    assert.equal(hydrated.bookmarks.length, 1);
    assert.ok(!("scene_id" in hydrated.bookmarks[0]));
  });
});
