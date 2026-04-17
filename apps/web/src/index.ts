import type { FixtureManifest, Scene } from "@roomview/contracts";

export {
  createRoomViewEditorServer,
  DEFAULT_WEB_EDITOR_PORT,
} from "./server";
export type {
  EditorFixtureSource,
  RoomViewEditorServerOptions,
} from "./server";

export const DEFAULT_FIXTURE_SCENE_ID = "fixture-bedroom-primary";

export interface EditorShellBootstrap {
  readonly fixtureSceneId: string;
  readonly fixtureManifestPath: string;
  readonly initialScene: Scene | null;
}

export const editorShellBootstrap: EditorShellBootstrap = {
  fixtureSceneId: DEFAULT_FIXTURE_SCENE_ID,
  fixtureManifestPath: "fixtures/manifest.json",
  initialScene: null,
};

export type EditorFixtureScene = Scene;
export type EditorFixtureManifest = FixtureManifest;
