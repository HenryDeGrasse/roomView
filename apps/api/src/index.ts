import type {
  FixtureManifest,
  RoomPlanCaptureRequest,
  RoomPlanCaptureResponse,
  Scene,
} from "@roomview/contracts";

export interface ApiWorkspaceBootstrap {
  migrationsDirectory: string;
  fixturesManifestPath: string;
}

export const apiWorkspaceBootstrap: ApiWorkspaceBootstrap = {
  migrationsDirectory: "apps/api/db/migrations",
  fixturesManifestPath: "fixtures/manifest.json",
};

export type IngestFixtureRequest = RoomPlanCaptureRequest;
export type CanonicalSceneFixture = Scene;
export type CaptureResponseShape = RoomPlanCaptureResponse;
export type SceneFixtureManifest = FixtureManifest;

export {
  buildInitialSceneFromRoomPlanCapture,
  ingestRoomPlanCaptureRequest,
  RoomPlanCaptureError,
  RoomPlanCaptureService,
} from "./roomplan-ingest";
export {
  createRoomPlanApiServer,
  DEFAULT_ROOMPLAN_CAPTURE_STORAGE_DIRECTORY,
} from "./server";
export {
  createAssetManifestResponse,
  createQuickRenderResponse,
} from "./quick-render";
export {
  createCanonicalPlanHash,
  createPreviewResponse,
  SceneMutationError,
  simulateScenePreview,
} from "./mutation-engine";
export type {
  BuildInitialSceneOptions,
  IngestedCaptureArtifacts,
  RoomPlanCaptureSceneArtifacts,
  RoomPlanCaptureServiceOptions,
} from "./roomplan-ingest";
export type { RoomPlanApiServerOptions } from "./server";
export {
  decomposeIngestedCaptureForStorage,
  hydrateSceneFromStoredRecords,
} from "./roomplan-persistence";
export type {
  PersistedCameraBookmarkRecord,
  PersistedDerivedStateCacheRecord,
  PersistedInitialSceneRecords,
  PersistedPhotorealEntryRecord,
  PersistedSceneHeadRecord,
} from "./roomplan-persistence";
