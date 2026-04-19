/**
 * Deterministic planner unit tests.
 *
 * verify:planner covers scripted transcripts; these tests isolate each of the
 * planner's branches so changes to one keyword table surface immediately.
 *
 * Notable bug-hunt: `matchesFlooringSwap` has operator-precedence semantics
 * that bit my review — we verify the intended behavior here.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

import { RoomPlanCaptureService } from "../../apps/api/src/index.ts";
import { planDeterministicTurn } from "../../apps/api/src/planner.ts";
import type { OperationPlanRequest, RoomPlanCaptureRequest } from "../../packages/contracts/src/index.ts";
import { buildMinimalScene } from "../helpers/scene-builder.ts";

function buildRequest(
  overrides: Partial<OperationPlanRequest> = {},
  selectedEntityIds: string[] = []
): OperationPlanRequest {
  return {
    request_id: "req-1",
    idempotency_key: "idem-1",
    scene_id: "scene:test",
    expected_scene_version: 1,
    selection_context: { selected_entity_ids: selectedEntityIds },
    user_prompt: "",
    ...overrides,
  };
}

describe("planner — gating", () => {
  test("rejects requests targeting a different scene_id", () => {
    const scene = buildMinimalScene({});
    const result = planDeterministicTurn(
      scene,
      buildRequest({ scene_id: "scene:other", user_prompt: "undo" })
    );
    assert.equal(result.response_kind, "rejection");
    if (result.response_kind === "rejection") {
      assert.equal(result.reason_code, "SCENE_ACCESS_DENIED");
    }
  });

  test("rejects version mismatch", () => {
    const scene = buildMinimalScene({});
    const result = planDeterministicTurn(
      scene,
      buildRequest({ expected_scene_version: 999, user_prompt: "undo" })
    );
    assert.equal(result.response_kind, "rejection");
    if (result.response_kind === "rejection") {
      assert.equal(result.reason_code, "VERSION_CONFLICT");
    }
  });

  test("rejects empty/whitespace prompt", () => {
    const scene = buildMinimalScene({});
    const result = planDeterministicTurn(scene, buildRequest({ user_prompt: "   " }));
    assert.equal(result.response_kind, "rejection");
    if (result.response_kind === "rejection") {
      assert.equal(result.reason_code, "INVALID_CAPTURE");
    }
  });
});

describe("planner — commands (undo, photoreal)", () => {
  test("'undo that' returns a command_request for undo_last_change", () => {
    const scene = buildMinimalScene({});
    const result = planDeterministicTurn(scene, buildRequest({ user_prompt: "undo that" }));
    assert.equal(result.response_kind, "command_request");
    if (result.response_kind === "command_request") {
      assert.equal(result.command.command_kind, "undo_last_change");
      assert.ok(result.command.endpoint.endsWith("/undo"));
    }
  });

  test("'render this photoreal' returns a command_request for generate_photoreal", () => {
    const scene = buildMinimalScene({});
    const result = planDeterministicTurn(scene, buildRequest({ user_prompt: "render this photoreal" }));
    assert.equal(result.response_kind, "command_request");
    if (result.response_kind === "command_request") {
      assert.equal(result.command.command_kind, "generate_photoreal");
      assert.ok(result.command.endpoint.endsWith("/photoreal"));
    }
  });
});

describe("planner — clarification", () => {
  test("ambiguous intent asks what the user wants", () => {
    const scene = buildMinimalScene({});
    const result = planDeterministicTurn(scene, buildRequest({ user_prompt: "hello there" }));
    assert.equal(result.response_kind, "clarification_request");
    if (result.response_kind === "clarification_request") {
      assert.ok(result.options.length > 0);
    }
  });

  test("'repaint this' without a color asks for the color first", () => {
    const scene = buildMinimalScene({});
    const result = planDeterministicTurn(scene, buildRequest({ user_prompt: "paint this wall" }, ["surf:wall:north"]));
    assert.equal(result.response_kind, "clarification_request");
  });

  test("'move the chair' when there is no chair asks which object to use", () => {
    const scene = buildMinimalScene({ objects: [{ object_id: "obj:bed", class: "bed" }] });
    const result = planDeterministicTurn(scene, buildRequest({ user_prompt: "move the chair" }));
    assert.equal(result.response_kind, "clarification_request");
  });
});

describe("planner — lock / unlock preview", () => {
  test("'lock this' with a selected object creates a lock_entity preview request", () => {
    const scene = buildMinimalScene({
      objects: [{ object_id: "obj:bed", class: "bed" }],
    });
    const result = planDeterministicTurn(scene, buildRequest({ user_prompt: "lock this" }, ["obj:bed"]));
    // Returns the internal preview_request marker
    assert.equal(result.response_kind as unknown as string, "preview_request");
    if ("preview_request" in result) {
      assert.equal(result.preview_request.ops.length, 1);
      assert.equal(result.preview_request.ops[0].op, "lock_entity");
    }
  });

  test("'lock the north wall' resolves to a wall surface lock", () => {
    const scene = buildMinimalScene({ objects: [] });
    const result = planDeterministicTurn(scene, buildRequest({ user_prompt: "lock the north wall" }));
    assert.equal(result.response_kind as unknown as string, "preview_request");
    if ("preview_request" in result) {
      assert.equal(result.preview_request.ops[0].op, "lock_entity");
      if (result.preview_request.ops[0].op === "lock_entity") {
        assert.equal(result.preview_request.ops[0].entity_type, "surface");
      }
    }
  });

  test("'lock the generic obstacle' rejects with UNSUPPORTED_CLASS", () => {
    const scene = buildMinimalScene({
      objects: [{ object_id: "obj:1", class: "generic_obstacle" }],
    });
    const result = planDeterministicTurn(
      scene,
      buildRequest({ user_prompt: "lock the generic obstacle" }, ["obj:1"])
    );
    assert.equal(result.response_kind, "rejection");
    if (result.response_kind === "rejection") {
      assert.equal(result.reason_code, "UNSUPPORTED_CLASS");
    }
  });

  test("'unlock this' with a selected object issues an unlock_entity preview", () => {
    const scene = buildMinimalScene({
      objects: [{ object_id: "obj:bed", class: "bed", user_locked: true }],
    });
    const result = planDeterministicTurn(scene, buildRequest({ user_prompt: "unlock this" }, ["obj:bed"]));
    assert.equal(result.response_kind as unknown as string, "preview_request");
    if ("preview_request" in result) {
      assert.equal(result.preview_request.ops[0].op, "unlock_entity");
    }
  });
});

describe("planner — repaint", () => {
  test("'paint the north wall sage' produces a repaint_surface op", () => {
    const scene = buildMinimalScene({});
    const result = planDeterministicTurn(scene, buildRequest({ user_prompt: "paint the north wall sage" }));
    assert.equal(result.response_kind as unknown as string, "preview_request");
    if ("preview_request" in result) {
      const op = result.preview_request.ops[0];
      assert.equal(op.op, "repaint_surface");
      if (op.op === "repaint_surface") {
        assert.equal(op.color, "sage");
        assert.equal(op.finish, "eggshell");
      }
    }
  });

  test("'grey' is normalized to 'gray' in the color output", () => {
    const scene = buildMinimalScene({});
    const result = planDeterministicTurn(scene, buildRequest({ user_prompt: "paint the north wall grey" }));
    if ("preview_request" in result) {
      const op = result.preview_request.ops[0];
      if (op.op === "repaint_surface") {
        assert.equal(op.color, "gray");
      }
    }
  });
});

describe("planner — flooring swap", () => {
  test("'swap the flooring to walnut' triggers swap_flooring", () => {
    const scene = buildMinimalScene({});
    const result = planDeterministicTurn(scene, buildRequest({ user_prompt: "swap the flooring to walnut" }));
    assert.equal(result.response_kind as unknown as string, "preview_request");
    if ("preview_request" in result) {
      const op = result.preview_request.ops[0];
      assert.equal(op.op, "swap_flooring");
    }
  });

  test("'repaint the floor' goes to repaint_surface, not swap_flooring (precedence guard)", () => {
    // matchesFlooringSwap runs first but requires one of swap|change|replace.
    // "repaint the floor" should fall through to matchesRepaint.
    const scene = buildMinimalScene({});
    const result = planDeterministicTurn(scene, buildRequest({ user_prompt: "repaint the floor sage" }));
    if ("preview_request" in result) {
      const op = result.preview_request.ops[0];
      assert.equal(op.op, "repaint_surface");
    } else {
      assert.fail("expected a preview_request for repaint_surface");
    }
  });
});

describe("planner — replace_object", () => {
  test("'replace this rug with something warm' resolves the rug (rug keyword wins over no-class suffix)", () => {
    const scene = buildMinimalScene({
      objects: [{ object_id: "obj:rug", class: "rug" }],
    });
    const result = planDeterministicTurn(
      scene,
      buildRequest({ user_prompt: "replace this rug with something warm and earthy" }, ["obj:rug"])
    );
    assert.equal(result.response_kind as unknown as string, "preview_request");
    if ("preview_request" in result) {
      const op = result.preview_request.ops[0];
      assert.equal(op.op, "replace_object");
      if (op.op === "replace_object") {
        assert.equal(op.object_id, "obj:rug");
      }
    }
  });

  test("'replace this with a desk' + selected chair uses the selected object as target", () => {
    // With a pronoun ('this') + one selected object, resolveObjectTarget
    // prefers the selection even though 'desk' appears earlier in the
    // keyword table than 'chair'. Regression guard for the keyword ordering.
    const scene = buildMinimalScene({
      objects: [{ object_id: "obj:chair", class: "chair" }],
    });
    const result = planDeterministicTurn(
      scene,
      buildRequest({ user_prompt: "replace this with a desk" }, ["obj:chair"])
    );
    assert.equal(result.response_kind as unknown as string, "preview_request");
    if ("preview_request" in result) {
      const op = result.preview_request.ops[0];
      assert.equal(op.op, "replace_object");
      if (op.op === "replace_object") {
        assert.equal(op.object_id, "obj:chair");
        assert.equal(op.desired_class, "desk");
      }
    }
  });

  test("no pronoun + no selection + replacement-class keyword first → falls through to clarification", () => {
    // Documents the known planner quirk: keyword order in OBJECT_CLASS_KEYWORDS
    // can cause the replacement class to be matched as the target class; if
    // that class isn't present in the scene and nothing is selected, the
    // planner asks which object to use.
    const scene = buildMinimalScene({
      objects: [{ object_id: "obj:chair", class: "chair" }],
    });
    const result = planDeterministicTurn(
      scene,
      buildRequest({ user_prompt: "replace the chair with a desk" })
    );
    assert.equal(result.response_kind, "clarification_request");
  });

  test("'replace this' with a generic_obstacle selected is rejected", () => {
    const scene = buildMinimalScene({
      objects: [{ object_id: "obj:1", class: "generic_obstacle" }],
    });
    const result = planDeterministicTurn(
      scene,
      buildRequest({ user_prompt: "replace this with a desk" }, ["obj:1"])
    );
    assert.equal(result.response_kind, "rejection");
    if (result.response_kind === "rejection") {
      assert.equal(result.reason_code, "UNSUPPORTED_CLASS");
    }
  });

  test("multiple desks in the scene + ambiguous prompt asks for disambiguation", () => {
    const scene = buildMinimalScene({
      objects: [
        { object_id: "obj:desk:1", class: "desk" },
        { object_id: "obj:desk:2", class: "desk" },
      ],
    });
    const result = planDeterministicTurn(scene, buildRequest({ user_prompt: "replace the desk with a chair" }));
    assert.equal(result.response_kind, "clarification_request");
  });
});

describe("planner — move_object", () => {
  test("'move the chair against the north wall' builds a move_object op targeting north wall", () => {
    const scene = buildMinimalScene({
      objects: [{ object_id: "obj:chair", class: "chair" }],
    });
    const result = planDeterministicTurn(
      scene,
      buildRequest({ user_prompt: "move the chair against the north wall" })
    );
    if ("preview_request" in result) {
      const op = result.preview_request.ops[0];
      assert.equal(op.op, "move_object");
      if (op.op === "move_object") {
        assert.equal(op.object_id, "obj:chair");
        assert.equal(op.target_named_wall_ref_id, "wall:north");
      }
    } else {
      assert.fail("expected a preview_request");
    }
  });

  test("'move the chair' with no placement asks where to put it", () => {
    const scene = buildMinimalScene({
      objects: [{ object_id: "obj:chair", class: "chair" }],
    });
    const result = planDeterministicTurn(scene, buildRequest({ user_prompt: "move the chair" }));
    assert.equal(result.response_kind, "clarification_request");
  });

  test("'move the desk under the window' survives preview validation for a rotated desk", () => {
    const storageDirectory = mkdtempSync(join(tmpdir(), "roomview-planner-"));
    try {
      const service = new RoomPlanCaptureService({
        storage_directory: storageDirectory,
        token_secret: "planner-test-secret",
        handoff_base_url: "https://roomview.local/h",
      });
      const captureRequest = JSON.parse(
        readFileSync("./fixtures/roomplan/bedroom-primary/capture-request.json", "utf8")
      ) as RoomPlanCaptureRequest;
      const capture = service.postRoomPlanCapture(captureRequest);
      const scene = service.getScene(capture.scene_id);
      assert.ok(scene);

      const result = service.planSceneOperation(capture.scene_id, {
        request_id: "req-move-desk-under-window",
        idempotency_key: "idem-move-desk-under-window",
        scene_id: capture.scene_id,
        expected_scene_version: scene.head.current_scene_version,
        selection_context: { selected_entity_ids: [] },
        user_prompt: "Move the desk under the window.",
      });

      assert.equal(result.response_kind, "operation_plan_preview");
      if (result.response_kind === "operation_plan_preview") {
        assert.equal(result.preview.ops[0]?.op, "move_object");
      }
    } finally {
      rmSync(storageDirectory, { recursive: true, force: true });
    }
  });
});

describe("planner — resize_object", () => {
  test("'make this desk bigger' builds a resize_object op for the selected desk", () => {
    const scene = buildMinimalScene({
      objects: [{ object_id: "obj:desk", class: "desk" }],
    });
    const result = planDeterministicTurn(
      scene,
      buildRequest({ user_prompt: "make this desk bigger" }, ["obj:desk"])
    );
    assert.equal(result.response_kind as unknown as string, "preview_request");
    if ("preview_request" in result) {
      const op = result.preview_request.ops[0];
      assert.equal(op.op, "resize_object");
      if (op.op === "resize_object") {
        assert.equal(op.object_id, "obj:desk");
        assert.ok(op.size_x > 1);
        assert.ok(op.size_y > 1);
      }
    }
  });

  test("'make the rug 20% smaller' shrinks both footprint dimensions", () => {
    const scene = buildMinimalScene({
      objects: [{ object_id: "obj:rug", class: "rug", obb: { center: { x: 0, y: 0, z: 0.01 }, size_x: 2.4, size_y: 1.6, size_z: 0.02, yaw_degrees: 0 } }],
    });
    const result = planDeterministicTurn(scene, buildRequest({ user_prompt: "make the rug 20% smaller" }));
    assert.equal(result.response_kind as unknown as string, "preview_request");
    if ("preview_request" in result) {
      const op = result.preview_request.ops[0];
      assert.equal(op.op, "resize_object");
      if (op.op === "resize_object") {
        assert.equal(op.size_x, 1.92);
        assert.equal(op.size_y, 1.28);
      }
    }
  });
});
