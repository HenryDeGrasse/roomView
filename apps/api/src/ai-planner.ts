import type {
  CommandKind,
  EditableObjectClass,
  MaterialState,
  OperationPlanRequest,
  PlannerConversationMessage,
  PlannerResponse,
  ReasonCode,
  Scene,
  SceneEditOperation,
  ScenePreviewRequest,
} from "../../../packages/contracts/src/index.ts";
import { REASON_CODE_VALUES } from "../../../packages/contracts/src/index.ts";

import { SceneMutationError, simulateScenePreview } from "./mutation-engine";

export interface PreviewRequestResult {
  response_kind: "preview_request";
  preview_request: ScenePreviewRequest;
}

export type AiPlannerResult = PlannerResponse | PreviewRequestResult;

export interface OpenRouterPlannerOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  siteUrl?: string;
  appName?: string;
  timeoutMs?: number;
  maxRounds?: number;
}

interface ChatCompletionToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

interface ChatCompletionMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null;
  tool_calls?: ChatCompletionToolCall[];
  tool_call_id?: string;
}

interface OpenRouterChatCompletionResponse {
  choices?: Array<{
    message?: ChatCompletionMessage;
  }>;
  error?: {
    message?: string;
  };
}

const REASON_CODE_SET = new Set<string>(REASON_CODE_VALUES);
const DEFAULT_OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const DEFAULT_OPENROUTER_MODEL = "openai/gpt-4o-mini";
const DEFAULT_TIMEOUT_MS = 25_000;
const DEFAULT_MAX_ROUNDS = 6;

export class OpenRouterPlanner {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly siteUrl: string;
  private readonly appName: string;
  private readonly timeoutMs: number;
  private readonly maxRounds: number;

  public constructor(options: OpenRouterPlannerOptions) {
    this.apiKey = options.apiKey;
    this.model = options.model ?? DEFAULT_OPENROUTER_MODEL;
    this.baseUrl = options.baseUrl ?? DEFAULT_OPENROUTER_BASE_URL;
    this.siteUrl = options.siteUrl ?? "http://127.0.0.1:3000";
    this.appName = options.appName ?? "RoomView MVP Local";
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRounds = options.maxRounds ?? DEFAULT_MAX_ROUNDS;
  }

  public async plan(scene: Scene, request: OperationPlanRequest, now: string): Promise<AiPlannerResult> {
    const guarded = maybeHandleGuardrail(scene, request);
    if (guarded) {
      return guarded;
    }

    const messages: ChatCompletionMessage[] = [
      {
        role: "system",
        content: buildSystemPrompt(),
      },
      {
        role: "user",
        content: buildUserPrompt(scene, request),
      },
    ];

    for (let round = 0; round < this.maxRounds; round += 1) {
      const assistantMessage = await this.complete(messages);
      if (!assistantMessage) {
        throw new Error("OpenRouter returned no assistant message.");
      }

      if (!Array.isArray(assistantMessage.tool_calls) || assistantMessage.tool_calls.length === 0) {
        throw new Error("OpenRouter planner did not use a planning tool.");
      }

      messages.push({
        role: "assistant",
        content: assistantMessage.content ?? "",
        tool_calls: assistantMessage.tool_calls,
      });

      for (const toolCall of assistantMessage.tool_calls) {
        const execution = executeToolCall(toolCall, scene, request, now);
        if (execution.final) {
          return execution.final;
        }
        messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: JSON.stringify(execution.payload),
        });
      }
    }

    throw new Error(`OpenRouter planner exceeded ${this.maxRounds} tool rounds without finishing.`);
  }

  private async complete(messages: ChatCompletionMessage[]): Promise<ChatCompletionMessage | null> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
          "HTTP-Referer": this.siteUrl,
          "X-Title": this.appName,
        },
        body: JSON.stringify({
          model: this.model,
          temperature: 0.15,
          messages,
          tools: buildToolDefinitions(),
          tool_choice: "auto",
          parallel_tool_calls: false,
        }),
        signal: controller.signal,
      });

      const payload = (await response.json()) as OpenRouterChatCompletionResponse;
      if (!response.ok) {
        throw new Error(payload.error?.message ?? `OpenRouter request failed with status ${response.status}.`);
      }
      return payload.choices?.[0]?.message ?? null;
    } finally {
      clearTimeout(timeout);
    }
  }
}

function buildSystemPrompt(): string {
  return [
    "You are the RoomView conversational planner.",
    "Your job is to understand the user's request, inspect the current room state with tools, and finish by calling exactly one final planning tool.",
    "The editable scene stays server-authoritative. Never invent scene ids, entity ids, or geometry.",
    "",
    "Supported scene-edit operations:",
    "- move_object",
    "- rotate_object",
    "- replace_object",
    "- add_object",
    "- remove_object",
    "- lock_entity",
    "- unlock_entity",
    "- repaint_surface",
    "- swap_flooring",
    "",
    "Important capability boundaries:",
    "- repaint_surface is only for wall/floor/ceiling surfaces.",
    "- swap_flooring is only for the floor surface.",
    "- There is no direct object recolor operation in the current schema.",
    "- If the user asks to recolor an object like a rug/chair/sofa, do NOT ask for a surface. Reject helpfully or suggest replace_object if that would actually satisfy the request.",
    "- If the user says 'this' or 'that', the selected entity ids are authoritative.",
    "- Use request_clarification only when a target or intent is truly ambiguous.",
    "- If the user already provided a concrete color like blue/green/white/black, do NOT ask for a shade variant.",
    "- Prefer concise explanations.",
    "",
    "Examples:",
    "- 'Paint the north wall blue' -> preview_scene_edit with repaint_surface using color='blue'.",
    "- 'Paint this wall blue' with a selected wall -> preview_scene_edit with repaint_surface using color='blue'.",
    "- 'Paint the rug green' -> reject_request explaining that rugs are objects and direct object recolor is not supported yet.",
    "- 'Make the floor green' -> preview_scene_edit using swap_flooring or repaint_surface on the floor, not a clarification about action.",
    "",
    "Workflow:",
    "1. Use get_scene_summary and get_entity_details when needed.",
    "2. When you think you have a valid edit plan, call preview_scene_edit.",
    "3. If preview_scene_edit returns a validation error, adjust, clarify, or reject.",
    "4. For photoreal or undo requests, call route_command.",
    "5. Always finish with exactly one of: preview_scene_edit, route_command, request_clarification, reject_request.",
  ].join("\n");
}

function buildUserPrompt(scene: Scene, request: OperationPlanRequest): string {
  const selectedEntityIds = request.selection_context.selected_entity_ids;
  const conversationHistory = request.conversation_history ?? [];
  const selectedEntities = summarizeSelectedEntities(scene, selectedEntityIds);
  const compactScene = {
    scene_id: scene.head.scene_id,
    current_scene_version: scene.head.current_scene_version,
    snapshot_id: scene.snapshot.snapshot_id,
    room_id: scene.snapshot.state.room.room_id,
    room_type: scene.snapshot.state.room.room_type,
    named_walls: scene.snapshot.state.room.shell.named_wall_refs.map((wallRef) => ({
      wall_ref_id: wallRef.wall_ref_id,
      name: wallRef.name,
      surface_ids: wallRef.surface_ids,
    })),
    counts: {
      surfaces: scene.snapshot.state.room.shell.surfaces.length,
      openings: scene.snapshot.state.room.shell.openings.length,
      objects: scene.snapshot.state.room.objects.length,
      fixed_elements: scene.snapshot.state.room.shell.fixed_elements.length,
    },
    selected_entity_ids: selectedEntityIds,
    selected_entities: selectedEntities,
  };

  return [
    `User prompt: ${request.user_prompt}`,
    `Selected entity ids: ${JSON.stringify(selectedEntityIds)}`,
    `Recent conversation: ${JSON.stringify(compactConversation(conversationHistory), null, 2)}`,
    `Compact scene summary: ${JSON.stringify(compactScene, null, 2)}`,
  ].join("\n\n");
}

function buildToolDefinitions(): Array<Record<string, unknown>> {
  return [
    {
      type: "function",
      function: {
        name: "get_scene_summary",
        description: "Read the current room shell, objects, openings, named walls, constraints, and selection context.",
        parameters: {
          type: "object",
          properties: {
            include_constraints: {
              type: "boolean",
              description: "Whether to include the constraint list.",
            },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "get_entity_details",
        description: "Read full details for specific entity ids, including objects, surfaces, openings, fixed elements, and named wall refs.",
        parameters: {
          type: "object",
          properties: {
            entity_ids: {
              type: "array",
              items: { type: "string" },
              minItems: 1,
              maxItems: 8,
            },
          },
          required: ["entity_ids"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "preview_scene_edit",
        description: "Validate a proposed scene-edit plan. If valid, this finalizes the planner with a preview-ready result.",
        parameters: {
          type: "object",
          properties: {
            explanation: { type: "string" },
            ops: {
              type: "array",
              items: { type: "object" },
              minItems: 1,
              maxItems: 5,
            },
          },
          required: ["explanation", "ops"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "route_command",
        description: "Finish the planner with a dedicated command request such as photoreal generation or undo.",
        parameters: {
          type: "object",
          properties: {
            command_kind: {
              type: "string",
              enum: ["generate_photoreal", "undo_last_change"],
            },
            explanation: { type: "string" },
          },
          required: ["command_kind", "explanation"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "request_clarification",
        description: "Finish the planner by asking a clarifying question when a target or intent is ambiguous.",
        parameters: {
          type: "object",
          properties: {
            prompt: { type: "string" },
            options: {
              type: "array",
              items: { type: "string" },
              minItems: 1,
              maxItems: 6,
            },
          },
          required: ["prompt", "options"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "reject_request",
        description: "Finish the planner with a helpful machine-readable rejection.",
        parameters: {
          type: "object",
          properties: {
            reason_code: {
              type: "string",
              enum: [...REASON_CODE_VALUES],
            },
            message: { type: "string" },
          },
          required: ["reason_code", "message"],
        },
      },
    },
  ];
}

function executeToolCall(
  toolCall: ChatCompletionToolCall,
  scene: Scene,
  request: OperationPlanRequest,
  now: string
): { final?: AiPlannerResult; payload: Record<string, unknown> } {
  const args = parseToolArguments(toolCall.function.arguments);
  switch (toolCall.function.name) {
    case "get_scene_summary": {
      return {
        payload: {
          ok: true,
          scene: summarizeScene(scene, request.selection_context.selected_entity_ids, Boolean(args.include_constraints)),
        },
      };
    }
    case "get_entity_details": {
      const entityIds = Array.isArray(args.entity_ids) ? args.entity_ids.filter((value): value is string => typeof value === "string") : [];
      return {
        payload: {
          ok: true,
          entities: entityIds.map((entityId) => ({ entity_id: entityId, detail: findEntity(scene, entityId) })),
        },
      };
    }
    case "preview_scene_edit": {
      if (typeof args.explanation !== "string" || !Array.isArray(args.ops)) {
        return {
          payload: {
            ok: false,
            reason_code: "INVALID_CAPTURE",
            message: "preview_scene_edit requires an explanation string and an ops array.",
          },
        };
      }
      let normalizedOps: SceneEditOperation[];
      try {
        normalizedOps = normalizeOperations(scene, args.ops as Array<Record<string, unknown>>);
      } catch (error) {
        if (error instanceof SceneMutationError) {
          return {
            payload: {
              ok: false,
              reason_code: error.reason_code,
              message: error.message,
            },
          };
        }
        throw error;
      }
      const previewRequest: ScenePreviewRequest = {
        request_id: request.request_id,
        idempotency_key: `planner-preview:${request.idempotency_key}`,
        expected_scene_version: request.expected_scene_version,
        explanation: args.explanation,
        ops: normalizedOps,
      };
      try {
        const simulation = simulateScenePreview(scene, previewRequest, now);
        return {
          final: {
            response_kind: "preview_request",
            preview_request: previewRequest,
          },
          payload: {
            ok: true,
            explanation: previewRequest.explanation,
            validation_summary: simulation.validation_summary,
          },
        };
      } catch (error) {
        if (error instanceof SceneMutationError) {
          return {
            payload: {
              ok: false,
              reason_code: error.reason_code,
              message: error.message,
              validation_summary: error.validation_summary,
            },
          };
        }
        throw error;
      }
    }
    case "route_command": {
      const commandKind = args.command_kind === "undo_last_change" ? "undo_last_change" : args.command_kind === "generate_photoreal" ? "generate_photoreal" : null;
      if (!commandKind || typeof args.explanation !== "string") {
        return {
          payload: {
            ok: false,
            reason_code: "INVALID_CAPTURE",
            message: "route_command requires a supported command_kind and explanation.",
          },
        };
      }
      return {
        final: {
          response_kind: "command_request",
          command: {
            request_id: request.request_id,
            command_kind: commandKind,
            endpoint: commandKind === "undo_last_change" ? `/scenes/${request.scene_id}/undo` : `/scenes/${request.scene_id}/photoreal`,
            explanation: args.explanation,
            idempotency_key: request.idempotency_key,
          },
        },
        payload: {
          ok: true,
        },
      };
    }
    case "request_clarification": {
      const prompt = typeof args.prompt === "string" ? args.prompt : null;
      const options = Array.isArray(args.options) ? args.options.filter((value): value is string => typeof value === "string") : [];
      if (!prompt || options.length === 0) {
        return {
          payload: {
            ok: false,
            reason_code: "INVALID_CAPTURE",
            message: "request_clarification requires a prompt and at least one option.",
          },
        };
      }
      return {
        final: {
          response_kind: "clarification_request",
          request_id: request.request_id,
          prompt,
          options,
        },
        payload: {
          ok: true,
        },
      };
    }
    case "reject_request": {
      const reasonCode = normalizeReasonCode(args.reason_code);
      const message = typeof args.message === "string" ? args.message : null;
      if (!reasonCode || !message) {
        return {
          payload: {
            ok: false,
            reason_code: "INVALID_CAPTURE",
            message: "reject_request requires a supported reason_code and message.",
          },
        };
      }
      return {
        final: {
          response_kind: "rejection",
          request_id: request.request_id,
          reason_code: reasonCode,
          message,
        },
        payload: {
          ok: true,
        },
      };
    }
    default:
      return {
        payload: {
          ok: false,
          reason_code: "INVALID_CAPTURE",
          message: `Unknown tool ${toolCall.function.name}.`,
        },
      };
  }
}

function maybeHandleGuardrail(scene: Scene, request: OperationPlanRequest): AiPlannerResult | null {
  const prompt = normalizePrompt(request.user_prompt);
  if (!looksLikeColorChangeRequest(prompt)) {
    return null;
  }

  const selectedEntities = request.selection_context.selected_entity_ids
    .map((entityId) => findEntity(scene, entityId))
    .filter((entry): entry is { entity_type: string; value: Record<string, unknown> } => Boolean(entry));

  const selectedObject = selectedEntities.find((entry) => entry.entity_type === "object");
  if (selectedObject && (mentionsPronoun(prompt) || prompt.includes(String((selectedObject.value as { class?: string }).class ?? "")))) {
    const objectClass = String((selectedObject.value as { class?: string }).class ?? "object");
    return {
      response_kind: "rejection",
      request_id: request.request_id,
      reason_code: "UNSUPPORTED_CLASS",
      message: `${capitalize(objectClass)} is an object, not a paintable surface. Direct object recolor is not supported yet. Try replacing it with a different ${objectClass} style instead.`,
    };
  }

  const mentionedObjectClass = findMentionedObjectClass(prompt);
  if (mentionedObjectClass) {
    return {
      response_kind: "rejection",
      request_id: request.request_id,
      reason_code: "UNSUPPORTED_CLASS",
      message: `${capitalize(mentionedObjectClass)} is an object, not a paintable surface. Direct object recolor is not supported yet. Try replacing it with a different ${mentionedObjectClass} style instead.`,
    };
  }

  return null;
}

function normalizeOperations(scene: Scene, rawOps: Array<Record<string, unknown>>): SceneEditOperation[] {
  return rawOps.map((rawOperation) => normalizeOperation(scene, rawOperation));
}

function normalizeOperation(scene: Scene, rawOperation: Record<string, unknown>): SceneEditOperation {
  const op = typeof rawOperation.op === "string" ? rawOperation.op : null;
  if (!op) {
    throw new SceneMutationError("INVALID_CAPTURE", "Each operation must include an op field.");
  }

  switch (op) {
    case "repaint_surface": {
      const surface_id = requireStringField(rawOperation, "surface_id");
      return {
        op,
        surface_id,
        color: requireStringField(rawOperation, "color"),
        finish: optionalStringField(rawOperation, "finish"),
      };
    }
    case "swap_flooring": {
      const surface_id = requireStringField(rawOperation, "surface_id");
      return {
        op,
        surface_id,
        material_state: normalizeMaterialState(rawOperation),
      };
    }
    case "lock_entity":
    case "unlock_entity": {
      const entity_id = requireStringField(rawOperation, "entity_id");
      const entityType = typeof rawOperation.entity_type === "string"
        ? rawOperation.entity_type
        : inferEntityType(scene, entity_id);
      if (entityType !== "object" && entityType !== "surface") {
        throw new SceneMutationError("INVALID_CAPTURE", `${op} requires entity_type to be object or surface.`);
      }
      return {
        op,
        entity_id,
        entity_type: entityType,
      };
    }
    case "replace_object": {
      return {
        op,
        object_id: requireStringField(rawOperation, "object_id"),
        desired_class: requireEditableObjectClassField(rawOperation, "desired_class"),
        style_tags: Array.isArray(rawOperation.style_tags)
          ? rawOperation.style_tags.filter((value): value is string => typeof value === "string")
          : [],
        asset_id: optionalStringField(rawOperation, "asset_id"),
      };
    }
    case "move_object": {
      const targetPosition = rawOperation.target_position;
      if (!targetPosition || typeof targetPosition !== "object") {
        throw new SceneMutationError("INVALID_CAPTURE", "move_object requires target_position.");
      }
      return {
        op,
        object_id: requireStringField(rawOperation, "object_id"),
        target_position: {
          x: requireNumberField(targetPosition as Record<string, unknown>, "x"),
          y: requireNumberField(targetPosition as Record<string, unknown>, "y"),
          z: requireNumberField(targetPosition as Record<string, unknown>, "z"),
        },
        target_named_wall_ref_id: optionalStringField(rawOperation, "target_named_wall_ref_id"),
        target_window_opening_id: optionalStringField(rawOperation, "target_window_opening_id"),
        include_children: typeof rawOperation.include_children === "boolean" ? rawOperation.include_children : undefined,
      };
    }
    case "rotate_object": {
      return {
        op,
        object_id: requireStringField(rawOperation, "object_id"),
        yaw_degrees: requireNumberField(rawOperation, "yaw_degrees"),
        include_children: typeof rawOperation.include_children === "boolean" ? rawOperation.include_children : undefined,
      };
    }
    case "remove_object": {
      return {
        op,
        object_id: requireStringField(rawOperation, "object_id"),
      };
    }
    case "add_object": {
      const placement = rawOperation.placement_relation;
      const pose = rawOperation.pose;
      return {
        op,
        object_id: requireStringField(rawOperation, "object_id"),
        object_class: requireEditableObjectClassField(rawOperation, "object_class"),
        style_tags: Array.isArray(rawOperation.style_tags)
          ? rawOperation.style_tags.filter((value): value is string => typeof value === "string")
          : [],
        placement_relation: placement && typeof placement === "object" ? placement as any : undefined,
        pose: pose && typeof pose === "object" ? pose as any : undefined,
      };
    }
    default:
      throw new SceneMutationError("INVALID_CAPTURE", `Unsupported operation ${op}.`);
  }
}

function normalizeMaterialState(rawOperation: Record<string, unknown>): MaterialState {
  const materialState = rawOperation.material_state;
  if (materialState && typeof materialState === "object") {
    const record = materialState as Record<string, unknown>;
    return {
      category: requireStringField(record, "category"),
      color: requireStringField(record, "color"),
      finish: optionalNullableStringField(record, "finish"),
      pattern: optionalNullableStringField(record, "pattern"),
      reference_asset_id: optionalNullableStringField(record, "reference_asset_id"),
    };
  }

  const color = optionalStringField(rawOperation, "color");
  if (color) {
    return {
      category: "wood",
      color,
      finish: optionalStringField(rawOperation, "finish") ?? "matte",
      pattern: null,
      reference_asset_id: null,
    };
  }

  throw new SceneMutationError("INVALID_CAPTURE", "swap_flooring requires material_state or a color.");
}

function inferEntityType(scene: Scene, entityId: string): "object" | "surface" | null {
  const entity = findEntity(scene, entityId);
  if (!entity) {
    return null;
  }
  if (entity.entity_type === "object") {
    return "object";
  }
  if (entity.entity_type === "surface") {
    return "surface";
  }
  return null;
}

function requireStringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new SceneMutationError("INVALID_CAPTURE", `${key} must be a non-empty string.`);
  }
  return value;
}

function requireEditableObjectClassField(record: Record<string, unknown>, key: string): EditableObjectClass {
  const value = requireStringField(record, key);
  if (!EDITABLE_OBJECT_CLASS_SET.has(value)) {
    throw new SceneMutationError("UNSUPPORTED_CLASS", `${value} is not a supported editable object class.`);
  }
  return value as EditableObjectClass;
}

function optionalStringField(record: Record<string, unknown>, key: string): string | null | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new SceneMutationError("INVALID_CAPTURE", `${key} must be a string when provided.`);
  }
  return value;
}

function optionalNullableStringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new SceneMutationError("INVALID_CAPTURE", `${key} must be a string when provided.`);
  }
  return value;
}

function requireNumberField(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== "number" || Number.isNaN(value)) {
    throw new SceneMutationError("INVALID_CAPTURE", `${key} must be a number.`);
  }
  return value;
}

function summarizeScene(scene: Scene, selectedEntityIds: string[], includeConstraints: boolean): Record<string, unknown> {
  const room = scene.snapshot.state.room;
  return {
    scene_id: scene.head.scene_id,
    current_scene_version: scene.head.current_scene_version,
    snapshot_id: scene.snapshot.snapshot_id,
    style_tags: scene.snapshot.state.style_tags,
    selected_entity_ids: selectedEntityIds,
    selected_entities: summarizeSelectedEntities(scene, selectedEntityIds),
    named_walls: room.shell.named_wall_refs.map((wallRef) => ({
      wall_ref_id: wallRef.wall_ref_id,
      name: wallRef.name,
      surface_ids: wallRef.surface_ids,
    })),
    surfaces: room.shell.surfaces.map((surface) => ({
      surface_id: surface.surface_id,
      type: surface.type,
      named_wall_ref_id: surface.named_wall_ref_id,
      user_locked: surface.user_locked,
      material_state: surface.material_state,
    })),
    openings: room.shell.openings.map((opening) => ({
      opening_id: opening.opening_id,
      type: opening.type,
      host_surface_id: opening.host_surface_id,
      rect: opening.rect,
    })),
    objects: room.objects.map((object) => ({
      object_id: object.object_id,
      class: object.class,
      pose: object.pose,
      obb: object.obb,
      user_locked: object.user_locked,
      mobility: object.mobility,
      host: object.host,
      support: object.support,
      style_tags: object.style_tags,
      material_state: object.material_state,
      parent_id: object.parent_id,
    })),
    fixed_elements: room.shell.fixed_elements.map((element) => ({
      fixed_element_id: element.fixed_element_id,
      class: element.class,
      obb: element.obb,
      host: element.host,
      support: element.support,
    })),
    constraints: includeConstraints
      ? room.constraints.map((constraint) => ({
          constraint_id: constraint.constraint_id,
          kind: constraint.kind,
          severity: constraint.severity,
          target_entity_ids: constraint.target_entity_ids,
          reason_code_on_fail: constraint.reason_code_on_fail,
        }))
      : undefined,
  };
}

function summarizeSelectedEntities(scene: Scene, selectedEntityIds: string[]): Array<Record<string, unknown>> {
  return selectedEntityIds
    .map((entityId) => ({
      entity_id: entityId,
      detail: findEntity(scene, entityId),
    }))
    .filter((entry) => entry.detail !== null);
}

function compactConversation(history: PlannerConversationMessage[]): PlannerConversationMessage[] {
  return history.slice(-10).map((entry) => ({
    role: entry.role,
    content: entry.content.slice(-600),
  }));
}

function findEntity(scene: Scene, entityId: string): Record<string, unknown> | null {
  const room = scene.snapshot.state.room;
  const object = room.objects.find((candidate) => candidate.object_id === entityId);
  if (object) {
    return {
      entity_type: "object",
      value: object,
    };
  }
  const surface = room.shell.surfaces.find((candidate) => candidate.surface_id === entityId);
  if (surface) {
    return {
      entity_type: "surface",
      value: surface,
    };
  }
  const opening = room.shell.openings.find((candidate) => candidate.opening_id === entityId);
  if (opening) {
    return {
      entity_type: "opening",
      value: opening,
    };
  }
  const fixedElement = room.shell.fixed_elements.find((candidate) => candidate.fixed_element_id === entityId);
  if (fixedElement) {
    return {
      entity_type: "fixed_element",
      value: fixedElement,
    };
  }
  const namedWallRef = room.shell.named_wall_refs.find((candidate) => candidate.wall_ref_id === entityId);
  if (namedWallRef) {
    return {
      entity_type: "named_wall_ref",
      value: namedWallRef,
    };
  }
  return null;
}

function looksLikeColorChangeRequest(prompt: string): boolean {
  return /\b(paint|repaint)\b/.test(prompt)
    || (/\b(make|turn|change|set)\b/.test(prompt) && COLOR_WORDS.some((color) => prompt.includes(color)));
}

function mentionsPronoun(prompt: string): boolean {
  return /\b(this|that|it|selected)\b/.test(prompt);
}

function findMentionedObjectClass(prompt: string): string | null {
  for (const className of [
    "rug",
    "chair",
    "sofa",
    "desk",
    "table",
    "lamp",
    "bed",
    "dresser",
    "nightstand",
    "bookshelf",
    "storage",
    "television",
  ]) {
    if (prompt.includes(className)) {
      return className;
    }
  }
  return null;
}

function normalizePrompt(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function capitalize(value: string): string {
  return value.length > 0 ? value[0].toUpperCase() + value.slice(1) : value;
}

function parseToolArguments(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function normalizeReasonCode(value: unknown): ReasonCode | null {
  return typeof value === "string" && REASON_CODE_SET.has(value) ? value as ReasonCode : null;
}

const COLOR_WORDS = [
  "blue",
  "green",
  "white",
  "black",
  "gray",
  "grey",
  "sage",
  "navy",
  "charcoal",
  "cream",
  "terracotta",
  "oak",
  "walnut",
];

const EDITABLE_OBJECT_CLASS_SET = new Set<EditableObjectClass>([
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
