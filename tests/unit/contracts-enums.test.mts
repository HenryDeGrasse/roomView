/**
 * Contract enum constants unit tests.
 *
 * Pin the set of allowed values for every exported *_VALUES tuple so that
 * accidental additions/deletions have to be intentional.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  ASSET_KIND_VALUES,
  CHILD_MOVEMENT_POLICY_VALUES,
  COMMAND_KIND_VALUES,
  CONSTRAINT_KIND_VALUES,
  CONSTRAINT_SEVERITY_VALUES,
  EDITABLE_OBJECT_CLASS_VALUES,
  FOCAL_ELEMENT_ROLE_VALUES,
  FOCAL_ELEMENT_TYPE_VALUES,
  HANDOFF_GRANT_STATUS_VALUES,
  HOST_RELATION_TYPE_VALUES,
  JOB_KIND_VALUES,
  JOB_STATUS_VALUES,
  MUTATION_KIND_VALUES,
  NORTH_SOURCE_VALUES,
  OBJECT_MOBILITY_VALUES,
  OPENING_TYPE_VALUES,
  PROVENANCE_SOURCE_KIND_VALUES,
  REASON_CODE_VALUES,
  ROOM_TYPE_VALUES,
  SCENE_SOURCE_VALUES,
  SPLAT_STATUS_VALUES,
  SUPPORT_KIND_VALUES,
  SURFACE_MASK_GENERATOR_KIND_VALUES,
  SURFACE_TYPE_VALUES,
  UNITS_VALUES,
  VIDEO_UPLOAD_TOKEN_STATUS_VALUES,
} from "../../packages/contracts/src/index.ts";

describe("Contract enum constants", () => {
  test("MUTATION_KIND_VALUES", () => {
    assert.deepEqual([...MUTATION_KIND_VALUES].sort(), ["edit_plan", "initial_ingest", "undo_restore"]);
  });

  test("ROOM_TYPE_VALUES — MVP ships bedroom-only; adding a type requires explicit PR", () => {
    assert.deepEqual([...ROOM_TYPE_VALUES], ["bedroom"]);
  });

  test("SURFACE_TYPE_VALUES", () => {
    assert.deepEqual([...SURFACE_TYPE_VALUES].sort(), ["ceiling", "floor", "wall"]);
  });

  test("OPENING_TYPE_VALUES includes door / window / closet_door", () => {
    for (const expected of ["door", "window", "closet_door"]) {
      assert.ok(OPENING_TYPE_VALUES.includes(expected as never), `missing ${expected}`);
    }
  });

  test("OBJECT_MOBILITY_VALUES — three-way split", () => {
    assert.deepEqual([...OBJECT_MOBILITY_VALUES].sort(), ["anchored", "fixed", "movable"]);
  });

  test("CHILD_MOVEMENT_POLICY_VALUES", () => {
    assert.deepEqual([...CHILD_MOVEMENT_POLICY_VALUES].sort(), ["independent", "move_with_parent"]);
  });

  test("HOST_RELATION_TYPE_VALUES — four relation kinds", () => {
    assert.deepEqual([...HOST_RELATION_TYPE_VALUES].sort(), [
      "ceiling_mounted",
      "embedded_in_wall",
      "flush_to_wall",
      "mounted_to_wall",
    ]);
  });

  test("SUPPORT_KIND_VALUES", () => {
    assert.deepEqual([...SUPPORT_KIND_VALUES].sort(), ["ceiling", "floor", "object", "wall"]);
  });

  test("FOCAL_ELEMENT_TYPE_VALUES", () => {
    assert.deepEqual([...FOCAL_ELEMENT_TYPE_VALUES].sort(), [
      "fixed_element",
      "object",
      "opening",
      "surface",
    ]);
  });

  test("FOCAL_ELEMENT_ROLE_VALUES", () => {
    assert.deepEqual([...FOCAL_ELEMENT_ROLE_VALUES].sort(), ["primary", "secondary"]);
  });

  test("CONSTRAINT_KIND_VALUES covers the expected constraint catalog", () => {
    for (const expected of [
      "opening_preserved",
      "walkway_clearance",
      "no_overlap_in_bounds",
      "anchor_integrity",
      "sofa_faces_focal_element",
      "primary_path_not_serpentine",
    ]) {
      assert.ok(
        CONSTRAINT_KIND_VALUES.includes(expected as never),
        `CONSTRAINT_KIND_VALUES missing ${expected}`
      );
    }
  });

  test("CONSTRAINT_SEVERITY_VALUES is hard|soft", () => {
    assert.deepEqual([...CONSTRAINT_SEVERITY_VALUES].sort(), ["hard", "soft"]);
  });

  test("ASSET_KIND_VALUES", () => {
    assert.deepEqual([...ASSET_KIND_VALUES].sort(), ["gltf", "proxy_gltf"]);
  });

  test("SPLAT_STATUS_VALUES matches the job lifecycle", () => {
    assert.deepEqual([...SPLAT_STATUS_VALUES].sort(), ["failed", "processing", "queued", "ready"]);
  });

  test("SURFACE_MASK_GENERATOR_KIND_VALUES covers the Showcase mask routes", () => {
    assert.deepEqual(
      [...SURFACE_MASK_GENERATOR_KIND_VALUES].sort(),
      ["click_sam2", "deterministic_stub", "geometric_projection", "sam2_refined"],
    );
  });

  test("EDITABLE_OBJECT_CLASS_VALUES has exactly the 12 MVP classes (add-on via stretch)", () => {
    assert.equal(EDITABLE_OBJECT_CLASS_VALUES.length, 12);
    for (const expected of ["bed", "desk", "chair", "sofa", "rug", "lamp"]) {
      assert.ok(EDITABLE_OBJECT_CLASS_VALUES.includes(expected as never));
    }
  });

  test("COMMAND_KIND_VALUES", () => {
    assert.deepEqual([...COMMAND_KIND_VALUES].sort(), ["generate_photoreal", "undo_last_change"]);
  });

  test("JOB_KIND_VALUES", () => {
    assert.deepEqual([...JOB_KIND_VALUES].sort(), ["capture_pipeline", "photoreal", "splat"]);
  });

  test("JOB_STATUS_VALUES", () => {
    assert.deepEqual([...JOB_STATUS_VALUES].sort(), ["failed", "processing", "queued", "ready"]);
  });

  test("HANDOFF_GRANT_STATUS_VALUES includes all four lifecycle states", () => {
    assert.deepEqual(
      [...HANDOFF_GRANT_STATUS_VALUES].sort(),
      ["expired", "issued", "redeemed", "revoked"]
    );
  });

  test("VIDEO_UPLOAD_TOKEN_STATUS_VALUES", () => {
    assert.deepEqual(
      [...VIDEO_UPLOAD_TOKEN_STATUS_VALUES].sort(),
      ["expired", "issued", "revoked", "used"]
    );
  });

  test("REASON_CODE_VALUES includes every error path the MVP can emit", () => {
    for (const expected of [
      "AUTH_REQUIRED",
      "SCENE_ACCESS_DENIED",
      "HANDOFF_EXPIRED",
      "HANDOFF_ALREADY_USED",
      "TARGET_NOT_FOUND",
      "VERSION_CONFLICT",
      "ENTITY_LOCKED",
      "OBJECT_OVERLAP",
      "OUT_OF_BOUNDS",
      "OPENING_BLOCKED",
      "ANCHOR_VIOLATION",
      "UNSUPPORTED_CLASS",
      "ASSET_NOT_AVAILABLE",
      "PARENT_MOVE_VIOLATION",
      "INVALID_CAPTURE",
      "ROOM_TYPE_NOT_SUPPORTED",
      "MULTI_ROOM_NOT_SUPPORTED",
    ]) {
      assert.ok(
        REASON_CODE_VALUES.includes(expected as never),
        `REASON_CODE_VALUES missing ${expected}`
      );
    }
  });

  test("PROVENANCE_SOURCE_KIND_VALUES", () => {
    assert.deepEqual(
      [...PROVENANCE_SOURCE_KIND_VALUES].sort(),
      ["generated", "inferred", "measured", "user_authored"]
    );
  });

  test("NORTH_SOURCE_VALUES", () => {
    assert.deepEqual([...NORTH_SOURCE_VALUES].sort(), ["scan_forward", "true_north"]);
  });

  test("UNITS_VALUES is meters-only", () => {
    assert.deepEqual([...UNITS_VALUES], ["m"]);
  });

  test("SCENE_SOURCE_VALUES is scanned-only (stretch: synthetic|template)", () => {
    assert.deepEqual([...SCENE_SOURCE_VALUES], ["scanned"]);
  });
});
