import type {
  CameraBookmark,
  CapturedFrame,
  DerivedState,
  HandoffGrantRecord,
  ISO8601Timestamp,
  PhotorealEntry,
  Scene,
  SceneHead,
  SceneId,
  SceneSnapshot,
  SplatAssetRecord,
  VideoUploadTokenRecord,
} from "@roomview/contracts";

import type { IngestedCaptureArtifacts } from "./roomplan-ingest";

export interface PersistedSceneHeadRecord extends SceneHead {
  created_at: ISO8601Timestamp;
  deleted_at: ISO8601Timestamp | null;
}

export interface PersistedDerivedStateCacheRecord {
  snapshot_id: string;
  scene_id: SceneId;
  scene_version: number;
  derived_state: DerivedState;
  created_at: ISO8601Timestamp;
  updated_at: ISO8601Timestamp;
}

export interface PersistedCameraBookmarkRecord extends CameraBookmark {
  scene_id: SceneId;
}

export interface PersistedPhotorealEntryRecord extends PhotorealEntry {
  scene_id: SceneId;
}

export type PersistedCapturedFrameRecord = CapturedFrame;

export interface PersistedInitialSceneRecords {
  scene_head: PersistedSceneHeadRecord;
  scene_snapshot: SceneSnapshot;
  derived_state_cache: PersistedDerivedStateCacheRecord | null;
  camera_bookmarks: PersistedCameraBookmarkRecord[];
  photoreal_entries: PersistedPhotorealEntryRecord[];
  captured_frames: PersistedCapturedFrameRecord[];
  splat_asset_record: SplatAssetRecord | null;
  handoff_grant: HandoffGrantRecord;
  video_upload_token_record: VideoUploadTokenRecord | null;
}

export function decomposeIngestedCaptureForStorage(
  artifacts: IngestedCaptureArtifacts
): PersistedInitialSceneRecords {
  const scene = structuredClone(artifacts.scene);
  const createdAt = scene.snapshot.created_at;

  return {
    scene_head: {
      ...scene.head,
      created_at: createdAt,
      deleted_at: null,
    },
    scene_snapshot: structuredClone(scene.snapshot),
    derived_state_cache: scene.derived_state_cache
      ? {
          snapshot_id: scene.snapshot.snapshot_id,
          scene_id: scene.head.scene_id,
          scene_version: scene.head.current_scene_version,
          derived_state: structuredClone(scene.derived_state_cache),
          created_at: createdAt,
          updated_at: scene.head.updated_at,
        }
      : null,
    camera_bookmarks: scene.bookmarks.map((bookmark) => ({
      ...structuredClone(bookmark),
      scene_id: scene.head.scene_id,
    })),
    photoreal_entries: scene.photoreal_gallery.map((entry) => ({
      ...structuredClone(entry),
      scene_id: scene.head.scene_id,
    })),
    captured_frames: (scene.captured_frames ?? []).map((frame) => structuredClone(frame)),
    splat_asset_record: scene.splat ? structuredClone(scene.splat) : null,
    handoff_grant: structuredClone(artifacts.handoff_grant),
    video_upload_token_record: artifacts.video_upload_token_record
      ? structuredClone(artifacts.video_upload_token_record)
      : null,
  };
}

export function hydrateSceneFromStoredRecords(records: PersistedInitialSceneRecords): Scene {
  const head = structuredClone(records.scene_head);
  const { created_at: _createdAt, deleted_at: _deletedAt, ...sceneHead } = head;

  return {
    head: sceneHead,
    snapshot: structuredClone(records.scene_snapshot),
    derived_state_cache: records.derived_state_cache
      ? structuredClone(records.derived_state_cache.derived_state)
      : null,
    bookmarks: records.camera_bookmarks.map(({ scene_id: _sceneId, ...bookmark }) => structuredClone(bookmark)),
    photoreal_gallery: records.photoreal_entries.map(({ scene_id: _sceneId, ...entry }) => structuredClone(entry)),
    splat: records.splat_asset_record ? structuredClone(records.splat_asset_record) : null,
    captured_frames: (records.captured_frames ?? []).map((frame) => structuredClone(frame)),
  };
}
