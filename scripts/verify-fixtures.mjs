import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDirectory, "..");
const manifestPath = resolve(repoRoot, "fixtures/manifest.json");

const EDITABLE_CLASSES = new Set([
  "bed",
  "nightstand",
  "desk",
  "chair",
  "table",
  "dresser",
  "bookshelf",
  "sofa",
  "rug",
  "lamp",
  "television",
  "storage",
]);

function fail(message) {
  throw new Error(message);
}

function readJson(relativePath) {
  const absolutePath = resolve(repoRoot, relativePath);
  if (!existsSync(absolutePath)) {
    fail(`Missing file: ${relativePath}`);
  }
  return JSON.parse(readFileSync(absolutePath, "utf8"));
}

function assert(condition, message) {
  if (!condition) {
    fail(message);
  }
}

const manifest = readJson("fixtures/manifest.json");
assert(Array.isArray(manifest.fixtures), "fixtures/manifest.json must contain a fixtures array");
assert(manifest.fixtures.length >= 2, "Expected at least two fixture descriptors");

const sceneIds = new Set();

for (const fixture of manifest.fixtures) {
  assert(typeof fixture.fixture_id === "string" && fixture.fixture_id.length > 0, "Each fixture needs a fixture_id");
  assert(typeof fixture.request_path === "string" && fixture.request_path.length > 0, `${fixture.fixture_id}: request_path is required`);
  assert(typeof fixture.scene_path === "string" && fixture.scene_path.length > 0, `${fixture.fixture_id}: scene_path is required`);

  const request = readJson(fixture.request_path);
  const scene = readJson(fixture.scene_path);

  assert(request.capture_metadata?.room_type_hint === "bedroom", `${fixture.fixture_id}: capture_metadata.room_type_hint must be bedroom`);
  assert(request.capture_metadata?.units === "m", `${fixture.fixture_id}: capture_metadata.units must be m`);
  assert(typeof request.roomplan_payload === "object" && request.roomplan_payload !== null, `${fixture.fixture_id}: roomplan_payload is required`);

  assert(scene.head?.source === "scanned", `${fixture.fixture_id}: scene.head.source must be scanned`);
  assert(scene.head?.units === "m", `${fixture.fixture_id}: scene.head.units must be m`);
  assert(scene.head?.scene_id === scene.snapshot?.scene_id, `${fixture.fixture_id}: scene.head.scene_id must match snapshot.scene_id`);
  assert(scene.head?.current_snapshot_id === scene.snapshot?.snapshot_id, `${fixture.fixture_id}: current snapshot id must match snapshot_id`);
  assert(scene.head?.current_scene_version === scene.snapshot?.scene_version, `${fixture.fixture_id}: scene versions must match`);
  assert(scene.snapshot?.mutation_kind === "initial_ingest", `${fixture.fixture_id}: initial fixtures must use mutation_kind=initial_ingest`);
  assert(scene.snapshot?.state?.room?.room_type === "bedroom", `${fixture.fixture_id}: room_type must be bedroom`);

  const sceneId = scene.head.scene_id;
  assert(!sceneIds.has(sceneId), `${fixture.fixture_id}: duplicate scene_id ${sceneId}`);
  sceneIds.add(sceneId);

  assert(Array.isArray(scene.snapshot?.state?.room?.objects), `${fixture.fixture_id}: objects array missing`);
  assert(Array.isArray(scene.snapshot?.editing_asset_refs), `${fixture.fixture_id}: editing_asset_refs array missing`);
  assert(Array.isArray(scene.bookmarks), `${fixture.fixture_id}: bookmarks must be an array`);
  assert(Array.isArray(scene.photoreal_gallery), `${fixture.fixture_id}: photoreal_gallery must be an array`);

  const objects = scene.snapshot.state.room.objects;
  const assetRefs = scene.snapshot.editing_asset_refs;
  const assetRefKeySet = new Set(assetRefs.map((assetRef) => `${assetRef.asset_id}:${assetRef.bound_to}`));

  for (const object of objects) {
    assert(typeof object.object_id === "string", `${fixture.fixture_id}: object missing object_id`);
    assert(typeof object.class === "string", `${fixture.fixture_id}: object ${object.object_id} missing class`);

    if (object.class === "generic_obstacle") {
      assert(object.asset_ref === null, `${fixture.fixture_id}: generic_obstacle ${object.object_id} should not have an asset_ref`);
    }

    if (object.asset_ref !== null) {
      const expectedKey = `${object.asset_ref}:${object.object_id}`;
      assert(assetRefKeySet.has(expectedKey), `${fixture.fixture_id}: missing editing_asset_ref for ${object.object_id}`);
    }

    if (object.class !== "generic_obstacle") {
      assert(EDITABLE_CLASSES.has(object.class), `${fixture.fixture_id}: unsupported object class ${object.class}`);
    }
  }

  if (request.capture_metadata.video_expected) {
    assert(scene.splat !== null, `${fixture.fixture_id}: expected a queued splat record when video_expected is true`);
    assert(scene.splat.scene_id === scene.head.scene_id, `${fixture.fixture_id}: splat scene_id must match scene`);
    assert(scene.splat.source_scene_version === scene.head.current_scene_version, `${fixture.fixture_id}: splat source_scene_version must match head version`);
  }

  if (fixture.fixture_id.includes("obstacle")) {
    assert(
      objects.some((object) => object.class === "generic_obstacle"),
      `${fixture.fixture_id}: expected a generic_obstacle object preserved from unsupported detection`
    );
    assert(
      Array.isArray(request.supplementary_detections) && request.supplementary_detections.length > 0,
      `${fixture.fixture_id}: expected supplementary_detections for obstacle fixture`
    );
  }
}

console.log(`Verified ${manifest.fixtures.length} fixture scene(s) from ${manifestPath}`);
