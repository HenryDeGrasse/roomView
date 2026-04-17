import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildInitialSceneFromRoomPlanCapture } from "../apps/api/src/index.ts";

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

function writeJson(relativePath: string, value: unknown): void {
  writeFileSync(resolve(repoRoot, relativePath), `${JSON.stringify(value, null, 2)}\n`);
}

const manifest = readJson<FixtureManifest>("fixtures/manifest.json");

for (const fixture of manifest.fixtures) {
  const request = readJson(fixture.request_path);
  const { scene } = buildInitialSceneFromRoomPlanCapture(request);
  writeJson(fixture.scene_path, scene);
  console.log(`updated ${fixture.fixture_id} -> ${fixture.scene_path}`);
}
