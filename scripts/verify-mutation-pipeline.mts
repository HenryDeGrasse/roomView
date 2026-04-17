import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ApplyPlanRequest, FixtureManifest, RoomPlanCaptureRequest, Scene, ScenePreviewRequest } from "../packages/contracts/src/index.ts";
import { RoomPlanCaptureError, RoomPlanCaptureService } from "../apps/api/src/index.ts";

interface MutationCaseManifest {
  cases: Array<{
    case_id: string;
    fixture_request_path: string;
    notes: string;
  }>;
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function createTempDirectory(): string {
  return mkdtempSync(join(tmpdir(), "roomview-mutation-"));
}

function createService(storageDirectory: string, handoffTtlMs = 15 * 60 * 1000): RoomPlanCaptureService {
  return new RoomPlanCaptureService({
    storage_directory: storageDirectory,
    token_secret: "mutation-test-secret",
    handoff_ttl_ms: handoffTtlMs,
    handoff_base_url: "https://roomview.local/h",
  });
}

function ingestFixtureScene(service: RoomPlanCaptureService, requestPath: string): { request: RoomPlanCaptureRequest; scene: Scene; sceneId: string } {
  const request = readJson<RoomPlanCaptureRequest>(requestPath);
  const capture = service.postRoomPlanCapture(request);
  const scene = service.getScene(capture.scene_id);
  assert.ok(scene, `expected scene ${capture.scene_id} to exist after capture ingest`);
  return { request, scene, sceneId: capture.scene_id };
}

function requireObject(scene: Scene, objectClass: string) {
  const object = scene.snapshot.state.room.objects.find((candidate) => candidate.class === objectClass);
  assert.ok(object, `expected scene to contain object class ${objectClass}`);
  return object;
}

const observedReasonCodes = new Set<string>();
const requiredReasonCodes = [
  "APPLY_TOKEN_EXPIRED",
  "APPLY_TOKEN_INVALID",
  "ANCHOR_VIOLATION",
  "ASSET_NOT_AVAILABLE",
  "CLEARANCE_VIOLATION",
  "ENTITY_LOCKED",
  "IDEMPOTENCY_CONFLICT",
  "INVALID_CAPTURE",
  "OBJECT_OVERLAP",
  "OPENING_BLOCKED",
  "OUT_OF_BOUNDS",
  "PARENT_MOVE_VIOLATION",
  "TARGET_NOT_FOUND",
  "UNDO_NOT_AVAILABLE",
  "VERSION_CONFLICT",
] as const;

function expectReasonCode(action: () => unknown, expectedReasonCode: string): void {
  assert.throws(
    action,
    (error: unknown) => {
      assert.ok(error instanceof RoomPlanCaptureError, "expected a RoomPlanCaptureError");
      assert.equal(error.reason_code, expectedReasonCode);
      observedReasonCodes.add(expectedReasonCode);
      return true;
    },
    `expected ${expectedReasonCode}`
  );
}

function createLockPreviewRequest(scene: Scene, objectId: string, idempotencyKey: string): ScenePreviewRequest {
  return {
    request_id: `request-${idempotencyKey}`,
    idempotency_key: idempotencyKey,
    expected_scene_version: scene.head.current_scene_version,
    explanation: "Lock the selected object.",
    ops: [{ op: "lock_entity", entity_id: objectId, entity_type: "object" }],
  };
}

function createApplyRequest(preview: { preview: { preview_id: string; apply_token: string; canonical_plan_hash: string; based_on_scene_version: number } }, idempotencyKey: string): ApplyPlanRequest {
  return {
    preview_id: preview.preview.preview_id,
    apply_token: preview.preview.apply_token,
    canonical_plan_hash: preview.preview.canonical_plan_hash,
    expected_scene_version: preview.preview.based_on_scene_version,
    idempotency_key: idempotencyKey,
  };
}

const mutationCases = readJson<MutationCaseManifest>("./fixtures/mutations/step-8-cases.json");
assert.equal(mutationCases.cases.length, 4, "expected four mutation verification cases");

{
  const storageDirectory = createTempDirectory();
  try {
    const serviceA = createService(storageDirectory);
    const { scene, sceneId } = ingestFixtureScene(serviceA, mutationCases.cases[0].fixture_request_path);
    const bed = requireObject(scene, "bed");
    const preview = serviceA.createScenePreview(sceneId, createLockPreviewRequest(scene, bed.object_id, "preview-happy"));

    const reloadedBeforeApply = createService(storageDirectory);
    expectReasonCode(
      () =>
        reloadedBeforeApply.applyScenePreview(sceneId, {
          ...createApplyRequest(preview, "apply-invalid-token"),
          apply_token: `${preview.preview.apply_token}-tampered`,
        }),
      "APPLY_TOKEN_INVALID"
    );

    const applied = reloadedBeforeApply.applyScenePreview(sceneId, createApplyRequest(preview, "apply-happy"));
    assert.equal(applied.applied_scene_version, 2, "apply should create scene version 2");
    assert.equal(applied.scene.head.undo_base_snapshot_id, scene.snapshot.snapshot_id, "apply should set one-step undo base");
    assert.equal(requireObject(applied.scene, "bed").user_locked, true, "apply should commit the lock state");

    const applyRetry = reloadedBeforeApply.applyScenePreview(sceneId, createApplyRequest(preview, "apply-happy"));
    assert.deepEqual(applyRetry, applied, "idempotent apply retries must return the original response");

    const reloadedBeforeUndo = createService(storageDirectory);
    const undone = reloadedBeforeUndo.undoLastChange(sceneId, {
      expected_scene_version: applied.applied_scene_version,
      idempotency_key: "undo-happy",
    });
    assert.equal(undone.applied_scene_version, 3, "undo should create a new head snapshot with incremented version");
    assert.equal(undone.scene.head.undo_base_snapshot_id, null, "undo should clear one-step undo history");
    assert.equal(requireObject(undone.scene, "bed").user_locked, false, "undo should restore the prior editable state");
  } finally {
    rmSync(storageDirectory, { recursive: true, force: true });
  }
}

{
  const storageDirectory = createTempDirectory();
  try {
    const service = createService(storageDirectory);
    const { scene, sceneId } = ingestFixtureScene(service, mutationCases.cases[1].fixture_request_path);
    const bed = requireObject(scene, "bed");
    const lockPreview = service.createScenePreview(sceneId, createLockPreviewRequest(scene, bed.object_id, "preview-lock-entity"));
    const applied = service.applyScenePreview(sceneId, createApplyRequest(lockPreview, "apply-lock-entity"));
    const lockedScene = applied.scene;
    expectReasonCode(
      () =>
        service.createScenePreview(sceneId, {
          request_id: "preview-move-locked-bed",
          idempotency_key: "preview-move-locked-bed",
          expected_scene_version: lockedScene.head.current_scene_version,
          explanation: "Try to move a locked bed.",
          ops: [
            {
              op: "move_object",
              object_id: bed.object_id,
              target_position: {
                ...requireObject(lockedScene, "bed").pose.position,
                x: requireObject(lockedScene, "bed").pose.position.x + 0.25,
              },
            },
          ],
        }),
      "ENTITY_LOCKED"
    );
  } finally {
    rmSync(storageDirectory, { recursive: true, force: true });
  }
}

{
  const storageDirectory = createTempDirectory();
  try {
    const service = createService(storageDirectory);
    const { scene, sceneId } = ingestFixtureScene(service, mutationCases.cases[2].fixture_request_path);
    const bed = requireObject(scene, "bed");

    expectReasonCode(
      () =>
        service.createScenePreview(sceneId, {
          request_id: "preview-version-conflict",
          idempotency_key: "preview-version-conflict",
          expected_scene_version: 99,
          explanation: "Stale preview request.",
          ops: [{ op: "lock_entity", entity_id: bed.object_id, entity_type: "object" }],
        }),
      "VERSION_CONFLICT"
    );

    const preview = service.createScenePreview(sceneId, createLockPreviewRequest(scene, bed.object_id, "preview-conflict"));

    expectReasonCode(
      () =>
        service.createScenePreview(sceneId, {
          request_id: "preview-conflict-different-request",
          idempotency_key: "preview-conflict",
          expected_scene_version: scene.head.current_scene_version,
          explanation: "Different request with same idempotency key.",
          ops: [{ op: "unlock_entity", entity_id: bed.object_id, entity_type: "object" }],
        }),
      "IDEMPOTENCY_CONFLICT"
    );

    expectReasonCode(
      () =>
        service.applyScenePreview(sceneId, {
          ...createApplyRequest(preview, "apply-invalid-hash"),
          canonical_plan_hash: "not-the-server-hash",
        }),
      "APPLY_TOKEN_INVALID"
    );
  } finally {
    rmSync(storageDirectory, { recursive: true, force: true });
  }

  const expiringStorageDirectory = createTempDirectory();
  try {
    const service = createService(expiringStorageDirectory, 1);
    const { scene, sceneId } = ingestFixtureScene(service, mutationCases.cases[2].fixture_request_path);
    const bed = requireObject(scene, "bed");
    const preview = service.createScenePreview(sceneId, createLockPreviewRequest(scene, bed.object_id, "preview-expired"));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expectReasonCode(() => service.applyScenePreview(sceneId, createApplyRequest(preview, "apply-expired")), "APPLY_TOKEN_EXPIRED");
  } finally {
    rmSync(expiringStorageDirectory, { recursive: true, force: true });
  }
}

{
  const storageDirectory = createTempDirectory();
  try {
    const service = createService(storageDirectory);
    const { scene, sceneId } = ingestFixtureScene(service, mutationCases.cases[3].fixture_request_path);
    const bed = requireObject(scene, "bed");
    const chair = requireObject(scene, "chair");
    const dresser = requireObject(scene, "dresser");
    const nightstand = requireObject(scene, "nightstand");
    const door = scene.snapshot.state.room.shell.openings.find((opening) => opening.type === "door");
    assert.ok(door, "expected a door opening for validation checks");

    expectReasonCode(
      () => service.undoLastChange(sceneId, { expected_scene_version: scene.head.current_scene_version, idempotency_key: "undo-none" }),
      "UNDO_NOT_AVAILABLE"
    );

    expectReasonCode(
      () =>
        service.createScenePreview(sceneId, {
          request_id: "preview-invalid-capture",
          idempotency_key: "preview-invalid-capture",
          expected_scene_version: scene.head.current_scene_version,
          explanation: "Reject an empty mutation batch.",
          ops: [],
        }),
      "INVALID_CAPTURE"
    );

    expectReasonCode(
      () =>
        service.createScenePreview(sceneId, {
          request_id: "preview-target-not-found",
          idempotency_key: "preview-target-not-found",
          expected_scene_version: scene.head.current_scene_version,
          explanation: "Reference a missing object.",
          ops: [
            {
              op: "move_object",
              object_id: "missing-object-id",
              target_position: { x: 0, y: 0, z: 0 },
            },
          ],
        }),
      "TARGET_NOT_FOUND"
    );

    expectReasonCode(
      () =>
        service.createScenePreview(sceneId, {
          request_id: "preview-asset-not-available",
          idempotency_key: "preview-asset-not-available",
          expected_scene_version: scene.head.current_scene_version,
          explanation: "Request a curated asset that does not exist.",
          ops: [
            {
              op: "replace_object",
              object_id: bed.object_id,
              desired_class: "bed",
              style_tags: [],
              asset_id: "missing-asset-id",
            },
          ],
        }),
      "ASSET_NOT_AVAILABLE"
    );

    expectReasonCode(
      () =>
        service.createScenePreview(sceneId, {
          request_id: "preview-overlap",
          idempotency_key: "preview-overlap",
          expected_scene_version: scene.head.current_scene_version,
          explanation: "Move the chair on top of the dresser.",
          ops: [
            {
              op: "move_object",
              object_id: chair.object_id,
              target_position: { ...dresser.pose.position },
            },
          ],
        }),
      "OBJECT_OVERLAP"
    );

    expectReasonCode(
      () =>
        service.createScenePreview(sceneId, {
          request_id: "preview-out-of-bounds",
          idempotency_key: "preview-out-of-bounds",
          expected_scene_version: scene.head.current_scene_version,
          explanation: "Move the bed outside the room shell.",
          ops: [
            {
              op: "move_object",
              object_id: bed.object_id,
              target_position: { ...bed.pose.position, x: -1 },
            },
          ],
        }),
      "OUT_OF_BOUNDS"
    );

    expectReasonCode(
      () =>
        service.createScenePreview(sceneId, {
          request_id: "preview-opening-blocked",
          idempotency_key: "preview-opening-blocked",
          expected_scene_version: scene.head.current_scene_version,
          explanation: "Move the chair into the door swing.",
          ops: [
            {
              op: "move_object",
              object_id: chair.object_id,
              target_position: { x: 0.65, y: 0.45, z: chair.pose.position.z },
            },
          ],
        }),
      "OPENING_BLOCKED"
    );

    expectReasonCode(
      () =>
        service.createScenePreview(sceneId, {
          request_id: "preview-clearance-violation",
          idempotency_key: "preview-clearance-violation",
          expected_scene_version: scene.head.current_scene_version,
          explanation: "Move the dresser close enough to the doorway to collapse the clearance path.",
          ops: [
            {
              op: "move_object",
              object_id: dresser.object_id,
              target_position: { x: 0.9, y: 0.8, z: dresser.pose.position.z },
            },
          ],
        }),
      "CLEARANCE_VIOLATION"
    );

    expectReasonCode(
      () =>
        service.createScenePreview(sceneId, {
          request_id: "preview-anchor-violation",
          idempotency_key: "preview-anchor-violation",
          expected_scene_version: scene.head.current_scene_version,
          explanation: "Move the desk too far away from its anchored wall.",
          ops: [
            {
              op: "move_object",
              object_id: requireObject(scene, "desk").object_id,
              target_position: { ...requireObject(scene, "desk").pose.position, y: 1.5 },
            },
          ],
        }),
      "ANCHOR_VIOLATION"
    );

    expectReasonCode(
      () =>
        service.createScenePreview(sceneId, {
          request_id: "preview-parent-move-violation",
          idempotency_key: "preview-parent-move-violation",
          expected_scene_version: scene.head.current_scene_version,
          explanation: "Move the nightstand without its dependent lamp.",
          ops: [
            {
              op: "move_object",
              object_id: nightstand.object_id,
              target_position: { ...nightstand.pose.position, x: nightstand.pose.position.x + 0.2 },
              include_children: false,
            },
          ],
        }),
      "PARENT_MOVE_VIOLATION"
    );
  } finally {
    rmSync(storageDirectory, { recursive: true, force: true });
  }
}

assert.deepEqual(
  [...observedReasonCodes].sort(),
  [...requiredReasonCodes].sort(),
  "expected the scripted mutation suite to independently exercise every implemented mutation-pipeline reason code"
);

console.log(`Verified deterministic mutation preview/apply/undo flow for ${mutationCases.cases.length} scripted case groups`);
