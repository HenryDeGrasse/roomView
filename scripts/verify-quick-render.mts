import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { FixtureManifest, Scene } from "../packages/contracts/src/index.ts";
import { buildDeterministicQuickRender } from "../packages/contracts/src/index.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function readJson<T>(relativePath: string): T {
  return JSON.parse(readFileSync(resolve(repoRoot, relativePath), "utf8")) as T;
}

const manifest = readJson<FixtureManifest>("fixtures/manifest.json");

for (const fixture of manifest.fixtures) {
  const scene = readJson<Scene>(fixture.scene_path);
  const serializedBefore = JSON.stringify(scene);
  const quickRenderA = buildDeterministicQuickRender(scene);
  const quickRenderB = buildDeterministicQuickRender(scene);

  assert.equal(JSON.stringify(scene), serializedBefore, `${fixture.fixture_id}: quick render mutated the scene`);
  assert.deepEqual(quickRenderA, quickRenderB, `${fixture.fixture_id}: quick render is not deterministic`);
  assert.equal(
    quickRenderA.scene_version,
    scene.head.current_scene_version,
    `${fixture.fixture_id}: quick render scene version must match layout scene version`
  );
  assert.equal(
    quickRenderA.scene_snapshot_id,
    scene.snapshot.snapshot_id,
    `${fixture.fixture_id}: quick render snapshot id must match layout snapshot id`
  );
  assert.equal(
    quickRenderA.asset_bindings.length,
    scene.snapshot.state.room.objects.length,
    `${fixture.fixture_id}: quick render must produce one binding per object`
  );
}

const primaryScene = readJson<Scene>(manifest.fixtures[0].scene_path);
const missingAssetScene = JSON.parse(JSON.stringify(primaryScene)) as Scene;
missingAssetScene.snapshot.state.room.objects[0].asset_ref = "asset-missing-bed-01";
missingAssetScene.snapshot.editing_asset_refs[0].asset_id = "asset-missing-bed-01";
const fallbackRender = buildDeterministicQuickRender(missingAssetScene);
const fallbackBinding = fallbackRender.asset_bindings.find(
  (binding) => binding.bound_to === missingAssetScene.snapshot.state.room.objects[0].object_id
);
assert.ok(fallbackBinding, "fallback verification: expected a binding for the first object");
assert.equal(
  fallbackBinding.used_fallback,
  true,
  "fallback verification: missing exact asset should fall back to a proxy asset"
);
assert.equal(
  fallbackBinding.fallback_reason,
  "requested_asset_missing",
  "fallback verification: missing exact asset should be logged as requested_asset_missing"
);
assert.equal(
  fallbackRender.scene_version,
  missingAssetScene.head.current_scene_version,
  "fallback verification: quick render version must stay synchronized with layout"
);
assert.equal(
  fallbackRender.scene_snapshot_id,
  missingAssetScene.snapshot.snapshot_id,
  "fallback verification: quick render snapshot id must stay synchronized with layout"
);

console.log(`Verified quick render parity for ${manifest.fixtures.length} fixture scene(s) and proxy fallback behavior`);
