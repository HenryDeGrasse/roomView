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
