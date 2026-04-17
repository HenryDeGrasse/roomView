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
  assert(scene.head?.current_scene_version === 1, `${fixture.fixture_id}: initial ingest must create scene_version=1`);
  assert(scene.head?.undo_base_snapshot_id === null, `${fixture.fixture_id}: initial ingest must clear undo_base_snapshot_id`);
  assert(scene.snapshot?.based_on_snapshot_id === null, `${fixture.fixture_id}: initial snapshot must not have a base snapshot`);
  assert(scene.snapshot?.mutation_kind === "initial_ingest", `${fixture.fixture_id}: initial fixtures must use mutation_kind=initial_ingest`);
  assert(scene.snapshot?.state?.room?.room_type === "bedroom", `${fixture.fixture_id}: room_type must be bedroom`);
  assert(scene.derived_state_cache !== null, `${fixture.fixture_id}: derived_state_cache must be populated on initial ingest`);
  assert(
    typeof scene.derived_state_cache?.selection_context_summary === "string" && scene.derived_state_cache.selection_context_summary.length > 0,
    `${fixture.fixture_id}: derived_state_cache.selection_context_summary must be present`
  );

  const sceneId = scene.head.scene_id;
  assert(!sceneIds.has(sceneId), `${fixture.fixture_id}: duplicate scene_id ${sceneId}`);
  sceneIds.add(sceneId);

  assert(Array.isArray(scene.snapshot?.state?.room?.objects), `${fixture.fixture_id}: objects array missing`);
  assert(Array.isArray(scene.snapshot?.state?.room?.shell?.surfaces), `${fixture.fixture_id}: surfaces array missing`);
  assert(Array.isArray(scene.snapshot?.state?.room?.shell?.openings), `${fixture.fixture_id}: openings array missing`);
  assert(Array.isArray(scene.snapshot?.state?.room?.shell?.named_wall_refs), `${fixture.fixture_id}: named_wall_refs array missing`);
  assert(Array.isArray(scene.snapshot?.state?.room?.constraints), `${fixture.fixture_id}: constraints array missing`);
  assert(Array.isArray(scene.snapshot?.editing_asset_refs), `${fixture.fixture_id}: editing_asset_refs array missing`);
  assert(Array.isArray(scene.bookmarks), `${fixture.fixture_id}: bookmarks must be an array`);
  assert(scene.bookmarks.length >= 1, `${fixture.fixture_id}: at least one bookmark is required`);
  assert(Array.isArray(scene.photoreal_gallery), `${fixture.fixture_id}: photoreal_gallery must be an array`);

  const room = scene.snapshot.state.room;
  const objects = room.objects;
  const surfaces = room.shell.surfaces;
  const openings = room.shell.openings;
  const namedWallRefs = room.shell.named_wall_refs;
  const constraints = room.constraints;
  const assetRefs = scene.snapshot.editing_asset_refs;
  const assetRefKeySet = new Set(assetRefs.map((assetRef) => `${assetRef.asset_id}:${assetRef.bound_to}`));
  const surfaceIdSet = new Set(surfaces.map((surface) => surface.surface_id));

  assert(namedWallRefs.length >= 4, `${fixture.fixture_id}: expected at least four named wall refs`);
  for (const wallName of ["north wall", "east wall", "south wall", "west wall"]) {
    assert(namedWallRefs.some((wallRef) => wallRef.name === wallName), `${fixture.fixture_id}: missing named wall ref ${wallName}`);
  }

  const entityIds = new Set();

  for (const surface of surfaces) {
    assert(typeof surface.surface_id === "string" && surface.surface_id.length > 0, `${fixture.fixture_id}: surface missing surface_id`);
    assert(!entityIds.has(surface.surface_id), `${fixture.fixture_id}: duplicate entity id ${surface.surface_id}`);
    entityIds.add(surface.surface_id);
    if (surface.type === "wall") {
      assert(surface.named_wall_ref_id !== null, `${fixture.fixture_id}: wall surface ${surface.surface_id} must reference a named wall`);
    }
  }

  for (const opening of openings) {
    assert(typeof opening.opening_id === "string" && opening.opening_id.length > 0, `${fixture.fixture_id}: opening missing opening_id`);
    assert(!entityIds.has(opening.opening_id), `${fixture.fixture_id}: duplicate entity id ${opening.opening_id}`);
    entityIds.add(opening.opening_id);
    assert(surfaceIdSet.has(opening.host_surface_id), `${fixture.fixture_id}: opening ${opening.opening_id} references unknown host surface`);
  }

  for (const object of objects) {
    assert(typeof object.object_id === "string", `${fixture.fixture_id}: object missing object_id`);
    assert(typeof object.class === "string", `${fixture.fixture_id}: object ${object.object_id} missing class`);
    assert(!entityIds.has(object.object_id), `${fixture.fixture_id}: duplicate entity id ${object.object_id}`);
    entityIds.add(object.object_id);

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

  assert(
    constraints.some((constraint) => constraint.kind === "opening_preserved"),
    `${fixture.fixture_id}: initial ingest must include opening_preserved constraint`
  );
  assert(
    constraints.some((constraint) => constraint.kind === "no_overlap_in_bounds"),
    `${fixture.fixture_id}: initial ingest must include no_overlap_in_bounds constraint`
  );

  if (request.capture_metadata.video_expected) {
    assert(scene.splat !== null, `${fixture.fixture_id}: expected a queued splat record when video_expected is true`);
    assert(scene.splat.status === "queued", `${fixture.fixture_id}: initial splat sidecar must start queued`);
    assert(scene.splat.scene_id === scene.head.scene_id, `${fixture.fixture_id}: splat scene_id must match scene`);
    assert(scene.splat.source_scene_version === scene.head.current_scene_version, `${fixture.fixture_id}: splat source_scene_version must match head version`);
  } else {
    assert(scene.splat === null, `${fixture.fixture_id}: splat must be null when no video upload is expected`);
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
