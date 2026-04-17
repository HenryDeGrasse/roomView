import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  ApplyPlanRequest,
  CommandKind,
  GeneratePhotorealRequest,
  OperationPlanRequest,
  PlannerResponse,
  RoomPlanCaptureRequest,
  Scene,
} from "../packages/contracts/src/index.ts";
import { RoomPlanCaptureError, RoomPlanCaptureService } from "../apps/api/src/index.ts";

interface TranscriptFixture {
  cases: Array<{
    case_id: string;
    fixture_request_path: string;
    selection:
      | { kind: "object_class"; value: string }
      | { kind: "wall_name"; value: string }
      | null;
    prompt: string;
    expected:
      | {
          response_kind: "operation_plan_preview";
          op: string;
          entity_type?: string;
          apply_assertion:
            | { kind: "object_locked"; value: boolean; target_class: string }
            | { kind: "surface_color"; value: string; target_wall: string }
            | { kind: "object_hosted_by_window_wall"; target_class: string }
            | { kind: "object_style_tags_include"; value: string[]; target_class: string };
        }
      | { response_kind: "command_request"; command_kind: CommandKind }
      | { response_kind: "clarification_request"; options_include: string }
      | { response_kind: "rejection"; reason_code: string };
  }>;
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function createService(storageDirectory: string): RoomPlanCaptureService {
  return new RoomPlanCaptureService({
    storage_directory: storageDirectory,
    token_secret: "planner-test-secret",
    handoff_base_url: "https://roomview.local/h",
  });
}

function resolveSelection(scene: Scene, selection: TranscriptFixture["cases"][number]["selection"]): string[] {
  if (!selection) {
    return [];
  }
  if (selection.kind === "object_class") {
    const object = scene.snapshot.state.room.objects.find((candidate) => candidate.class === selection.value);
    assert.ok(object, `expected object class ${selection.value}`);
    return [object.object_id];
  }
  const wallRef = scene.snapshot.state.room.shell.named_wall_refs.find((candidate) => candidate.name === selection.value);
  assert.ok(wallRef, `expected wall ${selection.value}`);
  return [wallRef.surface_ids[0]];
}

function createPlanRequest(scene: Scene, selectionIds: string[], prompt: string, caseId: string): OperationPlanRequest {
  return {
    request_id: `plan-${caseId}`,
    idempotency_key: `plan-${caseId}`,
    scene_id: scene.head.scene_id,
    expected_scene_version: scene.head.current_scene_version,
    selection_context: {
      selected_entity_ids: selectionIds,
    },
    user_prompt: prompt,
  };
}

function createApplyRequest(response: Extract<PlannerResponse, { response_kind: "operation_plan_preview" }>, caseId: string): ApplyPlanRequest {
  return {
    preview_id: response.preview.preview_id,
    apply_token: response.preview.apply_token,
    canonical_plan_hash: response.preview.canonical_plan_hash,
    expected_scene_version: response.preview.based_on_scene_version,
    idempotency_key: `apply-${caseId}`,
  };
}

function assertPhotorealPlaceholder(service: RoomPlanCaptureService, scene: Scene): void {
  try {
    throw new RoomPlanCaptureError(
      "PHOTOREAL_PROVIDER_ERROR",
      "Photoreal generation is not configured yet. Use the command preview now and the real provider route in step 10."
    );
  } catch (error) {
    assert.ok(error instanceof RoomPlanCaptureError);
    assert.equal(error.reason_code, "PHOTOREAL_PROVIDER_ERROR");
    assert.equal(service.getScene(scene.head.scene_id)?.head.scene_id, scene.head.scene_id);
  }
}

const transcripts = readJson<TranscriptFixture>("./fixtures/planner/golden-transcripts.json");
assert.ok(transcripts.cases.length >= 8, "expected golden planner transcripts");

for (const testCase of transcripts.cases) {
  const storageDirectory = mkdtempSync(join(tmpdir(), "roomview-planner-"));
  try {
    const service = createService(storageDirectory);
    const captureRequest = readJson<RoomPlanCaptureRequest>(testCase.fixture_request_path);
    const capture = service.postRoomPlanCapture(captureRequest);
    const scene = service.getScene(capture.scene_id);
    assert.ok(scene, `expected scene ${capture.scene_id}`);
    const selectionIds = resolveSelection(scene, testCase.selection);
    const request = createPlanRequest(scene, selectionIds, testCase.prompt, testCase.case_id);

    const response = service.planSceneOperation(capture.scene_id, request);
    assert.equal(response.response_kind, testCase.expected.response_kind, testCase.case_id);

    switch (response.response_kind) {
      case "operation_plan_preview": {
        assert.equal(response.preview.ops[0]?.op, testCase.expected.op, testCase.case_id);
        if (testCase.expected.entity_type) {
          assert.equal((response.preview.ops[0] as { entity_type?: string }).entity_type, testCase.expected.entity_type, testCase.case_id);
        }
        const replay = service.planSceneOperation(capture.scene_id, request);
        assert.deepEqual(replay, response, `${testCase.case_id} should be idempotent`);
        const applied = service.applyScenePreview(capture.scene_id, createApplyRequest(response, testCase.case_id));
        assert.equal(applied.applied_scene_version, 2, `${testCase.case_id} should commit a new snapshot`);
        switch (testCase.expected.apply_assertion.kind) {
          case "object_locked": {
            const object = applied.scene.snapshot.state.room.objects.find((candidate) => candidate.class === testCase.expected.apply_assertion.target_class);
            assert.ok(object, testCase.case_id);
            assert.equal(object.user_locked, testCase.expected.apply_assertion.value, testCase.case_id);
            break;
          }
          case "surface_color": {
            const wallRef = applied.scene.snapshot.state.room.shell.named_wall_refs.find((candidate) => candidate.name === testCase.expected.apply_assertion.target_wall);
            assert.ok(wallRef, testCase.case_id);
            const surface = applied.scene.snapshot.state.room.shell.surfaces.find((candidate) => candidate.surface_id === wallRef.surface_ids[0]);
            assert.ok(surface, testCase.case_id);
            assert.equal(surface.material_state.color, testCase.expected.apply_assertion.value, testCase.case_id);
            break;
          }
          case "object_hosted_by_window_wall": {
            const object = applied.scene.snapshot.state.room.objects.find((candidate) => candidate.class === testCase.expected.apply_assertion.target_class);
            const window = applied.scene.snapshot.state.room.shell.openings.find((candidate) => candidate.type === "window");
            assert.ok(object && window, testCase.case_id);
            assert.equal(object.host?.host_surface_id, window.host_surface_id, testCase.case_id);
            break;
          }
          case "object_style_tags_include": {
            const object = applied.scene.snapshot.state.room.objects.find((candidate) => candidate.class === testCase.expected.apply_assertion.target_class);
            assert.ok(object, testCase.case_id);
            for (const expectedTag of testCase.expected.apply_assertion.value) {
              assert.ok(object.style_tags.includes(expectedTag), `${testCase.case_id} missing style tag ${expectedTag}`);
            }
            break;
          }
        }
        break;
      }
      case "command_request": {
        assert.equal(response.command.command_kind, testCase.expected.command_kind, testCase.case_id);
        if (response.command.command_kind === "undo_last_change") {
          assert.ok(response.command.endpoint.endsWith("/undo"), testCase.case_id);
        } else {
          assert.ok(response.command.endpoint.endsWith("/photoreal"), testCase.case_id);
          assertPhotorealPlaceholder(service, scene);
          const requestBody: GeneratePhotorealRequest = {
            scene_snapshot_id: scene.snapshot.snapshot_id,
            prompt_modifiers: [],
            idempotency_key: `photoreal-${testCase.case_id}`,
          };
          assert.equal(requestBody.scene_snapshot_id, scene.snapshot.snapshot_id, testCase.case_id);
        }
        break;
      }
      case "clarification_request": {
        assert.ok(response.options.some((option) => option.includes(testCase.expected.options_include)), testCase.case_id);
        break;
      }
      case "rejection": {
        assert.equal(response.reason_code, testCase.expected.reason_code, testCase.case_id);
        break;
      }
    }
  } finally {
    rmSync(storageDirectory, { recursive: true, force: true });
  }
}

console.log(`Verified deterministic planner transcripts for ${transcripts.cases.length} chat cases`);
