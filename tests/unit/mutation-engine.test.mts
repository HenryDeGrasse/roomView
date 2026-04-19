/**
 * mutation-engine unit tests.
 *
 * Covers the deterministic preview simulator on small, hand-built scenes.
 * The verify:mutation-pipeline script exercises apply/undo on golden fixtures;
 * these tests fill in the isolated branches:
 *   - each op kind's happy path
 *   - lock/unlock enforcement (ENTITY_LOCKED)
 *   - version conflict / invalid-capture guards
 *   - plan-hash stability (same ops → same hash; order-sensitive)
 *   - dependent-children enforcement (PARENT_MOVE_VIOLATION)
 *   - out-of-bounds and object-overlap hard violations
 *   - asset fallback and upsert behavior on replace_object
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  createCanonicalPlanHash,
  hashOpaqueToken,
  SceneMutationError,
  simulateScenePreview,
} from "../../apps/api/src/mutation-engine.ts";
import type { SceneEditOperation, ScenePreviewRequest } from "../../packages/contracts/src/index.ts";
import { buildMinimalScene } from "../helpers/scene-builder.mts";

const NOW = "2026-04-17T01:00:00.000Z";

function buildPreviewRequest(
  ops: SceneEditOperation[],
  overrides: Partial<ScenePreviewRequest> = {}
): ScenePreviewRequest {
  return {
    request_id: "req-test",
    idempotency_key: "idem-test",
    expected_scene_version: 1,
    ops,
    explanation: "test",
    ...overrides,
  };
}

describe("simulateScenePreview — guards", () => {
  test("rejects empty ops array", () => {
    const scene = buildMinimalScene({ objects: [] });
    assert.throws(
      () => simulateScenePreview(scene, buildPreviewRequest([]), NOW),
      (error: Error) =>
        error instanceof SceneMutationError && error.reason_code === "INVALID_CAPTURE"
    );
  });

  test("rejects more than 5 ops per preview", () => {
    const scene = buildMinimalScene({ objects: [] });
    const ops: SceneEditOperation[] = Array.from({ length: 6 }, (_, i) => ({
      op: "lock_entity",
      entity_id: `obj:${i}`,
      entity_type: "object",
    }));
    assert.throws(
      () => simulateScenePreview(scene, buildPreviewRequest(ops), NOW),
      /between 1 and 5 operations/
    );
  });

  test("rejects version mismatch with VERSION_CONFLICT", () => {
    const scene = buildMinimalScene({ objects: [] });
    assert.throws(
      () =>
        simulateScenePreview(
          scene,
          buildPreviewRequest([{ op: "lock_entity", entity_id: "x", entity_type: "object" }], {
            expected_scene_version: 999,
          }),
          NOW
        ),
      (error: Error) =>
        error instanceof SceneMutationError && error.reason_code === "VERSION_CONFLICT"
    );
  });

  test("rejects missing request_id / idempotency_key", () => {
    const scene = buildMinimalScene({ objects: [] });
    assert.throws(
      () =>
        simulateScenePreview(
          scene,
          buildPreviewRequest([{ op: "lock_entity", entity_id: "x", entity_type: "object" }], {
            request_id: "",
          }),
          NOW
        ),
      /request_id and idempotency_key/
    );
  });
});

describe("simulateScenePreview — lock / unlock", () => {
  test("lock_entity sets user_locked=true on the target object", () => {
    const scene = buildMinimalScene({
      objects: [{ object_id: "obj:1", class: "bed", pose: { position: { x: 0, y: 0, z: 0 }, yaw_degrees: 0 } }],
    });
    const result = simulateScenePreview(
      scene,
      buildPreviewRequest([{ op: "lock_entity", entity_id: "obj:1", entity_type: "object" }]),
      NOW
    );
    const object = result.simulated_scene.snapshot.state.room.objects[0];
    assert.equal(object.user_locked, true);
  });

  test("locked object cannot be moved (ENTITY_LOCKED)", () => {
    const scene = buildMinimalScene({
      objects: [
        {
          object_id: "obj:1",
          class: "bed",
          user_locked: true,
          pose: { position: { x: 0, y: 0, z: 0 }, yaw_degrees: 0 },
          obb: { center: { x: 0, y: 0, z: 0.3 }, size_x: 1.6, size_y: 2.0, size_z: 0.6, yaw_degrees: 0 },
        },
      ],
    });
    assert.throws(
      () =>
        simulateScenePreview(
          scene,
          buildPreviewRequest([
            {
              op: "move_object",
              object_id: "obj:1",
              target_position: { x: 0.5, y: 0, z: 0 },
            },
          ]),
          NOW
        ),
      (error: Error) => error instanceof SceneMutationError && error.reason_code === "ENTITY_LOCKED"
    );
  });

  test("locked surface cannot be repainted", () => {
    const scene = buildMinimalScene({
      objects: [],
      north_wall_locked: true,
    });
    assert.throws(
      () =>
        simulateScenePreview(
          scene,
          buildPreviewRequest([
            {
              op: "repaint_surface",
              surface_id: "surf:wall:north",
              color: "sage",
            },
          ]),
          NOW
        ),
      (error: Error) => error instanceof SceneMutationError && error.reason_code === "ENTITY_LOCKED"
    );
  });

  test("unlock_entity clears user_locked", () => {
    const scene = buildMinimalScene({
      objects: [
        { object_id: "obj:1", class: "bed", user_locked: true },
      ],
    });
    const result = simulateScenePreview(
      scene,
      buildPreviewRequest([{ op: "unlock_entity", entity_id: "obj:1", entity_type: "object" }]),
      NOW
    );
    assert.equal(result.simulated_scene.snapshot.state.room.objects[0].user_locked, false);
  });
});

describe("simulateScenePreview — move_object", () => {
  test("translates the pose by the requested delta and updates the OBB", () => {
    const scene = buildMinimalScene({
      objects: [
        {
          object_id: "obj:1",
          class: "bed",
          pose: { position: { x: 0, y: 0, z: 0 }, yaw_degrees: 0 },
          obb: { center: { x: 0, y: 0, z: 0.3 }, size_x: 1.6, size_y: 2.0, size_z: 0.6, yaw_degrees: 0 },
        },
      ],
    });
    const result = simulateScenePreview(
      scene,
      buildPreviewRequest([
        {
          op: "move_object",
          object_id: "obj:1",
          target_position: { x: 0.3, y: -0.2, z: 0 },
        },
      ]),
      NOW
    );
    const object = result.simulated_scene.snapshot.state.room.objects[0];
    assert.equal(object.pose.position.x, 0.3);
    assert.equal(object.pose.position.y, -0.2);
    assert.equal(object.obb.center.x, 0.3);
    assert.equal(object.obb.center.y, -0.2);
    // z should stay the same (center was 0.3, delta_z=0 → still 0.3)
    assert.equal(object.obb.center.z, 0.3);
  });

  test("missing object_id rejects with TARGET_NOT_FOUND", () => {
    const scene = buildMinimalScene({ objects: [] });
    assert.throws(
      () =>
        simulateScenePreview(
          scene,
          buildPreviewRequest([
            {
              op: "move_object",
              object_id: "obj:ghost",
              target_position: { x: 0, y: 0, z: 0 },
            },
          ]),
          NOW
        ),
      (error: Error) => error instanceof SceneMutationError && error.reason_code === "TARGET_NOT_FOUND"
    );
  });

  test("move out of bounds raises a hard validation error", () => {
    const scene = buildMinimalScene({
      objects: [
        {
          object_id: "obj:1",
          class: "bed",
          pose: { position: { x: 0, y: 0, z: 0 }, yaw_degrees: 0 },
          obb: { center: { x: 0, y: 0, z: 0.3 }, size_x: 1.6, size_y: 2.0, size_z: 0.6, yaw_degrees: 0 },
        },
      ],
    });
    // Room is 4×3. Push the bed to x=5 → OBB extends beyond the floor polygon.
    assert.throws(
      () =>
        simulateScenePreview(
          scene,
          buildPreviewRequest([
            {
              op: "move_object",
              object_id: "obj:1",
              target_position: { x: 5, y: 0, z: 0 },
            },
          ]),
          NOW
        ),
      (error: Error) =>
        error instanceof SceneMutationError &&
        // OUT_OF_BOUNDS is the first hard violation we expect
        (error.reason_code === "OUT_OF_BOUNDS" ||
          error.validation_summary?.hard_violations.some(
            (v) => (v as { reason_code?: string }).reason_code === "OUT_OF_BOUNDS"
          ))
    );
  });

  test("dependent child blocks move unless include_children=true", () => {
    const scene = buildMinimalScene({
      objects: [
        { object_id: "obj:bed", class: "bed" },
        {
          object_id: "obj:pillow",
          class: "lamp", // any class, but marked as moves_with_parent
          parent_id: "obj:bed",
          child_movement_policy: "move_with_parent",
        },
      ],
    });
    assert.throws(
      () =>
        simulateScenePreview(
          scene,
          buildPreviewRequest([
            {
              op: "move_object",
              object_id: "obj:bed",
              target_position: { x: 0.1, y: 0.1, z: 0 },
              include_children: false,
            },
          ]),
          NOW
        ),
      (error: Error) =>
        error instanceof SceneMutationError && error.reason_code === "PARENT_MOVE_VIOLATION"
    );
  });
});

describe("simulateScenePreview — rotate_object", () => {
  test("sets yaw_degrees on pose and OBB", () => {
    const scene = buildMinimalScene({
      objects: [
        {
          object_id: "obj:1",
          class: "chair",
          pose: { position: { x: 0, y: 0, z: 0 }, yaw_degrees: 0 },
          obb: { center: { x: 0, y: 0, z: 0.45 }, size_x: 0.5, size_y: 0.5, size_z: 0.9, yaw_degrees: 0 },
        },
      ],
    });
    const result = simulateScenePreview(
      scene,
      buildPreviewRequest([
        { op: "rotate_object", object_id: "obj:1", yaw_degrees: 90 },
      ]),
      NOW
    );
    const object = result.simulated_scene.snapshot.state.room.objects[0];
    assert.equal(object.pose.yaw_degrees, 90);
    assert.equal(object.obb.yaw_degrees, 90);
  });
});

describe("simulateScenePreview — resize_object", () => {
  test("updates footprint dimensions and refreshes the bound asset ref", () => {
    const scene = buildMinimalScene({
      objects: [
        {
          object_id: "obj:desk",
          class: "desk",
          pose: { position: { x: 0, y: 0, z: 0 }, yaw_degrees: 0 },
          obb: { center: { x: 0, y: 0, z: 0.37 }, size_x: 1.2, size_y: 0.6, size_z: 0.74, yaw_degrees: 0 },
          asset_ref: "asset-desk-compact-01",
        },
      ],
      editing_asset_refs: [
        {
          asset_id: "asset-desk-compact-01",
          kind: "gltf",
          uri: "asset://furniture/desk/compact-01.glb",
          bound_to: "obj:desk",
        },
      ],
    });
    const result = simulateScenePreview(
      scene,
      buildPreviewRequest([
        { op: "resize_object", object_id: "obj:desk", size_x: 1.8, size_y: 0.8 },
      ]),
      NOW
    );
    const object = result.simulated_scene.snapshot.state.room.objects[0];
    assert.equal(object.obb.size_x, 1.8);
    assert.equal(object.obb.size_y, 0.8);
    assert.equal(object.support.support_kind, "floor");
    assert.equal(object.asset_ref, "asset-desk-proxy-01");
    assert.equal(result.simulated_scene.snapshot.editing_asset_refs[0]?.asset_id, "asset-desk-proxy-01");
  });

  test("rejects unsupported classes", () => {
    const scene = buildMinimalScene({
      objects: [{ object_id: "obj:tv", class: "television" }],
    });
    assert.throws(
      () =>
        simulateScenePreview(
          scene,
          buildPreviewRequest([
            { op: "resize_object", object_id: "obj:tv", size_x: 1.2, size_y: 0.2 },
          ]),
          NOW
        ),
      (error: Error) => error instanceof SceneMutationError && error.reason_code === "UNSUPPORTED_CLASS"
    );
  });
});

describe("simulateScenePreview — repaint_surface / swap_flooring", () => {
  test("repaint_surface updates color", () => {
    const scene = buildMinimalScene({ objects: [] });
    const result = simulateScenePreview(
      scene,
      buildPreviewRequest([
        { op: "repaint_surface", surface_id: "surf:wall:north", color: "sage" },
      ]),
      NOW
    );
    const surface = result.simulated_scene.snapshot.state.room.shell.surfaces.find((s) => s.surface_id === "surf:wall:north")!;
    assert.equal(surface.material_state.color, "sage");
  });

  test("repaint_surface optional finish overrides when provided", () => {
    const scene = buildMinimalScene({ objects: [] });
    const result = simulateScenePreview(
      scene,
      buildPreviewRequest([
        { op: "repaint_surface", surface_id: "surf:wall:north", color: "sage", finish: "matte" },
      ]),
      NOW
    );
    const surface = result.simulated_scene.snapshot.state.room.shell.surfaces.find((s) => s.surface_id === "surf:wall:north")!;
    assert.equal(surface.material_state.finish, "matte");
  });

  test("swap_flooring replaces material_state wholesale", () => {
    const scene = buildMinimalScene({ objects: [] });
    const result = simulateScenePreview(
      scene,
      buildPreviewRequest([
        {
          op: "swap_flooring",
          surface_id: "surf:floor",
          material_state: {
            category: "flooring",
            color: "walnut",
            finish: "satin",
            pattern: "herringbone",
            reference_asset_id: "asset-floor-walnut-01",
          },
        },
      ]),
      NOW
    );
    const floor = result.simulated_scene.snapshot.state.room.shell.surfaces.find((s) => s.surface_id === "surf:floor")!;
    assert.equal(floor.material_state.color, "walnut");
    assert.equal(floor.material_state.pattern, "herringbone");
  });
});

describe("simulateScenePreview — add / remove / replace object", () => {
  test("add_object appends a new object + asset ref", () => {
    const scene = buildMinimalScene({ objects: [] });
    const result = simulateScenePreview(
      scene,
      buildPreviewRequest([
        {
          op: "add_object",
          object_id: "obj:new",
          object_class: "chair",
          style_tags: ["modern"],
        },
      ]),
      NOW
    );
    const objects = result.simulated_scene.snapshot.state.room.objects;
    assert.equal(objects.length, 1);
    assert.equal(objects[0].object_id, "obj:new");
    assert.equal(objects[0].class, "chair");

    const refs = result.simulated_scene.snapshot.editing_asset_refs;
    assert.equal(refs.length, 1);
    assert.equal(refs[0].bound_to, "obj:new");
  });

  test("add_object rejects duplicate object_id", () => {
    const scene = buildMinimalScene({
      objects: [{ object_id: "obj:dup", class: "bed" }],
    });
    assert.throws(
      () =>
        simulateScenePreview(
          scene,
          buildPreviewRequest([
            {
              op: "add_object",
              object_id: "obj:dup",
              object_class: "chair",
              style_tags: [],
            },
          ]),
          NOW
        ),
      /already exists/
    );
  });

  test("remove_object deletes the object + its editing asset ref", () => {
    const scene = buildMinimalScene({
      objects: [{ object_id: "obj:1", class: "chair" }],
      editing_asset_refs: [
        {
          asset_id: "asset-chair-upholstered-01",
          kind: "gltf",
          uri: "asset://furniture/chair/upholstered-01.glb",
          bound_to: "obj:1",
        },
      ],
    });
    const result = simulateScenePreview(
      scene,
      buildPreviewRequest([{ op: "remove_object", object_id: "obj:1" }]),
      NOW
    );
    assert.equal(result.simulated_scene.snapshot.state.room.objects.length, 0);
    assert.equal(result.simulated_scene.snapshot.editing_asset_refs.length, 0);
  });

  test("remove_object blocked by dependent child", () => {
    const scene = buildMinimalScene({
      objects: [
        { object_id: "obj:parent", class: "bed" },
        { object_id: "obj:child", class: "lamp", parent_id: "obj:parent" },
      ],
    });
    assert.throws(
      () =>
        simulateScenePreview(
          scene,
          buildPreviewRequest([{ op: "remove_object", object_id: "obj:parent" }]),
          NOW
        ),
      (error: Error) =>
        error instanceof SceneMutationError && error.reason_code === "PARENT_MOVE_VIOLATION"
    );
  });

  test("replace_object picks a curated asset and rewrites class + asset_ref", () => {
    const scene = buildMinimalScene({
      objects: [
        {
          object_id: "obj:1",
          class: "chair",
          obb: { center: { x: 0, y: 0, z: 0.5 }, size_x: 1.1, size_y: 0.6, size_z: 0.74, yaw_degrees: 0 },
        },
      ],
    });
    const result = simulateScenePreview(
      scene,
      buildPreviewRequest([
        {
          op: "replace_object",
          object_id: "obj:1",
          desired_class: "desk",
          style_tags: ["workspace"],
        },
      ]),
      NOW
    );
    const obj = result.simulated_scene.snapshot.state.room.objects[0];
    assert.equal(obj.class, "desk");
    assert.ok(obj.asset_ref && obj.asset_ref.startsWith("asset-"));
  });

  test("replace_object rejects unknown asset_id with ASSET_NOT_AVAILABLE", () => {
    const scene = buildMinimalScene({
      objects: [{ object_id: "obj:1", class: "chair" }],
    });
    assert.throws(
      () =>
        simulateScenePreview(
          scene,
          buildPreviewRequest([
            {
              op: "replace_object",
              object_id: "obj:1",
              desired_class: "desk",
              style_tags: [],
              asset_id: "asset-does-not-exist",
            },
          ]),
          NOW
        ),
      (error: Error) =>
        error instanceof SceneMutationError && error.reason_code === "ASSET_NOT_AVAILABLE"
    );
  });
});

describe("simulateScenePreview — idempotency / purity", () => {
  test("simulation does not mutate the input scene", () => {
    const scene = buildMinimalScene({
      objects: [{ object_id: "obj:1", class: "bed" }],
    });
    const before = JSON.stringify(scene);
    simulateScenePreview(
      scene,
      buildPreviewRequest([{ op: "lock_entity", entity_id: "obj:1", entity_type: "object" }]),
      NOW
    );
    assert.equal(JSON.stringify(scene), before);
  });

  test("same ops produce the same canonical_plan_hash", () => {
    const ops: SceneEditOperation[] = [
      { op: "lock_entity", entity_id: "obj:1", entity_type: "object" },
    ];
    assert.equal(createCanonicalPlanHash(ops), createCanonicalPlanHash(ops));
  });

  test("canonical_plan_hash is order-sensitive", () => {
    const left: SceneEditOperation[] = [
      { op: "lock_entity", entity_id: "obj:1", entity_type: "object" },
      { op: "repaint_surface", surface_id: "surf:wall:north", color: "sage" },
    ];
    const right: SceneEditOperation[] = [left[1]!, left[0]!];
    assert.notEqual(createCanonicalPlanHash(left), createCanonicalPlanHash(right));
  });
});

describe("hashOpaqueToken", () => {
  test("is deterministic for identical inputs", () => {
    assert.equal(hashOpaqueToken("secret", "t1"), hashOpaqueToken("secret", "t1"));
  });

  test("differs across different secrets", () => {
    assert.notEqual(hashOpaqueToken("a", "t"), hashOpaqueToken("b", "t"));
  });

  test("differs across different tokens", () => {
    assert.notEqual(hashOpaqueToken("s", "t1"), hashOpaqueToken("s", "t2"));
  });

  test("returns a 64-char hex string (sha256)", () => {
    const hash = hashOpaqueToken("s", "t");
    assert.match(hash, /^[0-9a-f]{64}$/);
  });
});
