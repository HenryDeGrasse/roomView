import type {
  ClarificationRequest,
  CommandKind,
  CommandRequestResponse,
  MaterialState,
  NamedWallRef,
  OperationPlanRequest,
  PlannerResponse,
  ReasonCode,
  RejectionResponse,
  Scene,
  SceneObject,
  ScenePreviewRequest,
  Surface,
} from "@roomview/contracts";

interface PreviewRequestResult {
  response_kind: "preview_request";
  preview_request: ScenePreviewRequest;
}

export type DeterministicPlannerResult = PlannerResponse | PreviewRequestResult;

const OBJECT_CLASS_KEYWORDS: Array<{ phrases: string[]; className: SceneObject["class"] }> = [
  { phrases: ["nightstand", "side table", "bedside table"], className: "nightstand" },
  { phrases: ["bookshelf", "bookcase"], className: "bookshelf" },
  { phrases: ["television", "tv"], className: "television" },
  { phrases: ["dresser"], className: "dresser" },
  { phrases: ["storage"], className: "storage" },
  { phrases: ["desk"], className: "desk" },
  { phrases: ["chair", "seat"], className: "chair" },
  { phrases: ["table"], className: "table" },
  { phrases: ["sofa", "couch"], className: "sofa" },
  { phrases: ["rug", "carpet"], className: "rug" },
  { phrases: ["lamp", "light"], className: "lamp" },
  { phrases: ["bed"], className: "bed" },
  { phrases: ["generic obstacle", "obstacle"], className: "generic_obstacle" },
];

const STYLE_TAG_KEYWORDS: Array<{ phrase: string; tag: string }> = [
  { phrase: "warm", tag: "warm" },
  { phrase: "earthy", tag: "earthy" },
  { phrase: "cozy", tag: "cozy" },
  { phrase: "modern", tag: "modern" },
  { phrase: "neutral", tag: "neutral" },
  { phrase: "workspace", tag: "workspace" },
  { phrase: "storage", tag: "storage" },
  { phrase: "light wood", tag: "light_wood" },
  { phrase: "wood", tag: "light_wood" },
];

const COLOR_KEYWORDS = [
  "warm white",
  "soft white",
  "white",
  "blue",
  "navy",
  "green",
  "sage",
  "charcoal",
  "taupe",
  "terracotta",
  "oak",
  "walnut",
  "black",
  "cream",
  "gray",
  "grey",
];

const PRONOUN_PATTERN = /\b(this|that|it|selected)\b/;

export function planDeterministicTurn(scene: Scene, request: OperationPlanRequest): DeterministicPlannerResult {
  if (request.scene_id !== scene.head.scene_id) {
    return createRejection(request.request_id, "SCENE_ACCESS_DENIED", `Planner request is not valid for scene ${scene.head.scene_id}.`);
  }
  if (request.expected_scene_version !== scene.head.current_scene_version) {
    return createRejection(
      request.request_id,
      "VERSION_CONFLICT",
      `Expected scene version ${request.expected_scene_version} does not match current version ${scene.head.current_scene_version}.`
    );
  }

  const prompt = normalizePrompt(request.user_prompt);
  if (!prompt) {
    return createRejection(request.request_id, "INVALID_CAPTURE", "Enter an edit request before asking the planner to act.");
  }

  if (matchesUndo(prompt)) {
    return createCommandResponse(request, "undo_last_change", `Preview an undo of the last committed editable change for scene ${scene.head.scene_id}.`);
  }

  if (matchesPhotoreal(prompt)) {
    return createCommandResponse(request, "generate_photoreal", `Route a photoreal generation command for scene ${scene.head.scene_id}.`);
  }

  if (matchesUnlock(prompt)) {
    return buildLockPreview(scene, request, false, prompt);
  }

  if (matchesLock(prompt)) {
    return buildLockPreview(scene, request, true, prompt);
  }

  if (matchesFlooringSwap(prompt)) {
    const floor = scene.snapshot.state.room.shell.surfaces.find((surface) => surface.type === "floor");
    if (!floor) {
      return createRejection(request.request_id, "TARGET_NOT_FOUND", "The scene has no editable floor surface.");
    }
    const material_state = buildFloorMaterial(prompt);
    return createPreviewRequest(request, `Swap the flooring on the canonical floor surface to ${material_state.color}.`, [
      {
        op: "swap_flooring",
        surface_id: floor.surface_id,
        material_state,
      },
    ]);
  }

  if (matchesRepaint(prompt)) {
    const color = extractColor(prompt);
    if (!color) {
      return createClarification(request.request_id, "Which paint color should I use?", ["warm white", "sage", "navy", "charcoal"]);
    }
    const surfaceResolution = resolveSurfaceTarget(scene, request, prompt);
    if (surfaceResolution.kind !== "resolved") {
      return surfaceResolution.response;
    }
    return createPreviewRequest(request, `Repaint ${describeSurface(surfaceResolution.surface, scene)} ${color}.`, [
      {
        op: "repaint_surface",
        surface_id: surfaceResolution.surface.surface_id,
        color,
        finish: "eggshell",
      },
    ]);
  }

  if (matchesReplace(prompt)) {
    const targetResolution = resolveObjectTarget(scene, request, prompt);
    if (targetResolution.kind !== "resolved") {
      return targetResolution.response;
    }
    if (targetResolution.object.class === "generic_obstacle") {
      return createRejection(
        request.request_id,
        "UNSUPPORTED_CLASS",
        "generic_obstacle items participate in validation, but they cannot be replaced through chat in the MVP."
      );
    }
    const desiredClass = extractReplacementClass(prompt) ?? targetResolution.object.class;
    if (desiredClass === "generic_obstacle") {
      return createRejection(request.request_id, "UNSUPPORTED_CLASS", "generic_obstacle is not an editable replacement class.");
    }
    const styleTags = extractStyleTags(prompt, targetResolution.object.style_tags);
    return createPreviewRequest(
      request,
      `Replace ${describeObject(targetResolution.object)} with ${desiredClass}${styleTags.length > 0 ? ` using ${styleTags.join(", ")} styling` : ""}.`,
      [
        {
          op: "replace_object",
          object_id: targetResolution.object.object_id,
          desired_class: desiredClass,
          style_tags: styleTags,
        },
      ]
    );
  }

  if (matchesMove(prompt)) {
    const targetResolution = resolveObjectTarget(scene, request, prompt);
    if (targetResolution.kind !== "resolved") {
      return targetResolution.response;
    }
    if (targetResolution.object.class === "generic_obstacle") {
      return createRejection(request.request_id, "UNSUPPORTED_CLASS", "generic_obstacle items cannot be moved via chat in the MVP.");
    }

    const windowOpening = prompt.includes("window")
      ? scene.snapshot.state.room.shell.openings.find((opening) => opening.type === "window") ?? null
      : null;
    const namedWall = resolveNamedWall(scene, request, prompt, windowOpening?.host_surface_id ?? null);

    if (!windowOpening && !namedWall) {
      return createClarification(request.request_id, "Where should I place it?", [
        "under the window",
        "against the north wall",
        "against the south wall",
      ]);
    }

    const target_position =
      windowOpening && namedWall
        ? positionObjectNearWall(scene, targetResolution.object, namedWall, openingCenterCoordinate(windowOpening))
        : positionObjectNearWall(scene, targetResolution.object, namedWall ?? findCurrentWall(scene, targetResolution.object), null);

    return createPreviewRequest(
      request,
      `Move ${describeObject(targetResolution.object)}${windowOpening ? " under the window" : ` toward the ${namedWall?.name ?? "selected wall"}`}.`,
      [
        {
          op: "move_object",
          object_id: targetResolution.object.object_id,
          target_position,
          target_named_wall_ref_id: namedWall?.wall_ref_id ?? undefined,
          target_window_opening_id: windowOpening?.opening_id ?? undefined,
          include_children: false,
        },
      ]
    );
  }

  return createClarification(request.request_id, "I can help with deterministic edit previews. Which action do you want?", [
    "lock this",
    "paint this wall blue",
    "replace this rug with something warm and earthy",
    "move the desk under the window",
    "undo that",
  ]);
}

function createPreviewRequest(
  request: OperationPlanRequest,
  explanation: string,
  ops: ScenePreviewRequest["ops"]
): PreviewRequestResult {
  return {
    response_kind: "preview_request",
    preview_request: {
      request_id: request.request_id,
      idempotency_key: `planner-preview:${request.idempotency_key}`,
      expected_scene_version: request.expected_scene_version,
      explanation,
      ops,
    },
  };
}

function createRejection(request_id: string, reason_code: ReasonCode, message: string): RejectionResponse {
  return {
    response_kind: "rejection",
    request_id,
    reason_code,
    message,
  };
}

function createClarification(request_id: string, prompt: string, options: string[]): ClarificationRequest {
  return {
    response_kind: "clarification_request",
    request_id,
    prompt,
    options,
  };
}

function createCommandResponse(
  request: OperationPlanRequest,
  command_kind: CommandKind,
  explanation: string
): CommandRequestResponse {
  return {
    response_kind: "command_request",
    command: {
      request_id: request.request_id,
      command_kind,
      endpoint: command_kind === "undo_last_change" ? `/scenes/${request.scene_id}/undo` : `/scenes/${request.scene_id}/photoreal`,
      explanation,
      idempotency_key: request.idempotency_key,
    },
  };
}

function buildLockPreview(
  scene: Scene,
  request: OperationPlanRequest,
  locked: boolean,
  prompt: string
): DeterministicPlannerResult {
  const surfaceTarget = prompt.includes("wall") || prompt.includes("floor") || prompt.includes("ceiling")
    ? resolveSurfaceTarget(scene, request, prompt)
    : null;
  if (surfaceTarget?.kind === "resolved") {
    return createPreviewRequest(request, `${locked ? "Lock" : "Unlock"} ${describeSurface(surfaceTarget.surface, scene)}.`, [
      {
        op: locked ? "lock_entity" : "unlock_entity",
        entity_id: surfaceTarget.surface.surface_id,
        entity_type: "surface",
      },
    ]);
  }
  if (surfaceTarget?.kind === "unresolved") {
    return surfaceTarget.response;
  }

  const objectTarget = resolveObjectTarget(scene, request, prompt);
  if (objectTarget.kind !== "resolved") {
    return objectTarget.response;
  }
  if (objectTarget.object.class === "generic_obstacle") {
    return createRejection(request.request_id, "UNSUPPORTED_CLASS", "generic_obstacle items cannot be locked through the chat workflow.");
  }
  return createPreviewRequest(request, `${locked ? "Lock" : "Unlock"} ${describeObject(objectTarget.object)}.`, [
    {
      op: locked ? "lock_entity" : "unlock_entity",
      entity_id: objectTarget.object.object_id,
      entity_type: "object",
    },
  ]);
}

function resolveObjectTarget(
  scene: Scene,
  request: OperationPlanRequest,
  prompt: string
): { kind: "resolved"; object: SceneObject } | { kind: "unresolved"; response: PlannerResponse } {
  const selectedObjects = request.selection_context.selected_entity_ids
    .map((entityId) => scene.snapshot.state.room.objects.find((candidate) => candidate.object_id === entityId) ?? null)
    .filter((candidate): candidate is SceneObject => Boolean(candidate));
  const mentionedClass = extractObjectClass(prompt);

  if (mentionedClass) {
    const matches = scene.snapshot.state.room.objects.filter((candidate) => candidate.class === mentionedClass);
    if (matches.length === 1) {
      return { kind: "resolved", object: matches[0] };
    }
    if (matches.length > 1) {
      const selectedMatch = selectedObjects.find((candidate) => candidate.class === mentionedClass);
      if (selectedMatch) {
        return { kind: "resolved", object: selectedMatch };
      }
      return {
        kind: "unresolved",
        response: createClarification(
          request.request_id,
          `I found more than one ${mentionedClass}. Which one do you mean?`,
          matches.map((candidate) => describeObject(candidate)).slice(0, 5)
        ),
      };
    }
  }

  if (selectedObjects.length === 1 && (PRONOUN_PATTERN.test(prompt) || !mentionedClass)) {
    return { kind: "resolved", object: selectedObjects[0] };
  }

  if (selectedObjects.length > 1) {
    return {
      kind: "unresolved",
      response: createClarification(request.request_id, "Which selected object should I use?", selectedObjects.map((candidate) => describeObject(candidate)).slice(0, 5)),
    };
  }

  return {
    kind: "unresolved",
    response: createClarification(
      request.request_id,
      "Which object should I use?",
      scene.snapshot.state.room.objects.map((candidate) => describeObject(candidate)).slice(0, 5)
    ),
  };
}

function resolveSurfaceTarget(
  scene: Scene,
  request: OperationPlanRequest,
  prompt: string
): { kind: "resolved"; surface: Surface } | { kind: "unresolved"; response: PlannerResponse } {
  const selectedSurfaces = request.selection_context.selected_entity_ids
    .map((entityId) => scene.snapshot.state.room.shell.surfaces.find((candidate) => candidate.surface_id === entityId) ?? null)
    .filter((candidate): candidate is Surface => Boolean(candidate));

  if (prompt.includes("floor") || prompt.includes("flooring")) {
    const floor = scene.snapshot.state.room.shell.surfaces.find((surface) => surface.type === "floor");
    return floor
      ? { kind: "resolved", surface: floor }
      : { kind: "unresolved", response: createRejection(request.request_id, "TARGET_NOT_FOUND", "The scene has no floor surface.") };
  }

  const namedWall = resolveNamedWall(scene, request, prompt, null);
  if (namedWall) {
    const surface = scene.snapshot.state.room.shell.surfaces.find((candidate) => candidate.surface_id === namedWall.surface_ids[0]);
    return surface
      ? { kind: "resolved", surface }
      : { kind: "unresolved", response: createRejection(request.request_id, "TARGET_NOT_FOUND", `The ${namedWall.name} is missing from the scene shell.`) };
  }

  if (selectedSurfaces.length === 1) {
    return { kind: "resolved", surface: selectedSurfaces[0] };
  }

  if (selectedSurfaces.length > 1) {
    return {
      kind: "unresolved",
      response: createClarification(request.request_id, "Which selected surface should I use?", selectedSurfaces.map((surface) => describeSurface(surface, scene)).slice(0, 5)),
    };
  }

  return {
    kind: "unresolved",
    response: createClarification(request.request_id, "Which surface should I use?", ["north wall", "south wall", "east wall", "west wall", "floor"]),
  };
}

function resolveNamedWall(scene: Scene, request: OperationPlanRequest, prompt: string, fallbackHostSurfaceId: string | null): NamedWallRef | null {
  for (const wallRef of scene.snapshot.state.room.shell.named_wall_refs) {
    if (prompt.includes(wallRef.name)) {
      return wallRef;
    }
  }

  const selectedSurface = request.selection_context.selected_entity_ids
    .map((entityId) => scene.snapshot.state.room.shell.surfaces.find((candidate) => candidate.surface_id === entityId) ?? null)
    .find((candidate): candidate is Surface => Boolean(candidate));
  if (selectedSurface?.named_wall_ref_id) {
    return scene.snapshot.state.room.shell.named_wall_refs.find((candidate) => candidate.wall_ref_id === selectedSurface.named_wall_ref_id) ?? null;
  }

  if (fallbackHostSurfaceId) {
    return scene.snapshot.state.room.shell.named_wall_refs.find((candidate) => candidate.surface_ids.includes(fallbackHostSurfaceId)) ?? null;
  }

  return null;
}

function findCurrentWall(scene: Scene, object: SceneObject): NamedWallRef | null {
  if (object.host?.host_surface_id) {
    return scene.snapshot.state.room.shell.named_wall_refs.find((candidate) => candidate.surface_ids.includes(object.host!.host_surface_id)) ?? null;
  }
  return resolveNamedWall(scene, { selection_context: { selected_entity_ids: [] } } as OperationPlanRequest, "north wall", null);
}

function positionObjectNearWall(
  scene: Scene,
  object: SceneObject,
  wallRef: NamedWallRef | null,
  preferredCoordinate: number | null
): { x: number; y: number; z: number } {
  const vertices = scene.snapshot.state.room.shell.floor_polygon.vertices;
  const minX = Math.min(...vertices.map((vertex) => vertex.x));
  const maxX = Math.max(...vertices.map((vertex) => vertex.x));
  const minY = Math.min(...vertices.map((vertex) => vertex.y));
  const maxY = Math.max(...vertices.map((vertex) => vertex.y));
  const halfWidth = object.obb.size_x / 2;
  const halfDepth = object.obb.size_y / 2;
  const margin = 0.15;
  const aligned = preferredCoordinate ?? (wallRef?.name === "north wall" || wallRef?.name === "south wall" ? object.pose.position.x : object.pose.position.y);

  switch (wallRef?.name) {
    case "north wall":
      return {
        x: clamp(aligned, minX + halfWidth + margin, maxX - halfWidth - margin),
        y: roundNumber(maxY - halfDepth - margin),
        z: object.pose.position.z,
      };
    case "south wall":
      return {
        x: clamp(aligned, minX + halfWidth + margin, maxX - halfWidth - margin),
        y: roundNumber(minY + halfDepth + margin),
        z: object.pose.position.z,
      };
    case "east wall":
      return {
        x: roundNumber(maxX - halfWidth - margin),
        y: clamp(aligned, minY + halfDepth + margin, maxY - halfDepth - margin),
        z: object.pose.position.z,
      };
    case "west wall":
      return {
        x: roundNumber(minX + halfWidth + margin),
        y: clamp(aligned, minY + halfDepth + margin, maxY - halfDepth - margin),
        z: object.pose.position.z,
      };
    default:
      return {
        x: object.pose.position.x,
        y: object.pose.position.y,
        z: object.pose.position.z,
      };
  }
}

function openingCenterCoordinate(opening: Scene["snapshot"]["state"]["room"]["shell"]["openings"][number]): number {
  return roundNumber(opening.rect.min_u + opening.rect.width / 2);
}

function buildFloorMaterial(prompt: string): MaterialState {
  const color = extractColor(prompt) ?? "oak";
  return {
    category: "flooring",
    color,
    finish: prompt.includes("gloss") ? "satin" : "matte",
    pattern: prompt.includes("herringbone") ? "herringbone" : "plank",
    reference_asset_id: color === "walnut" ? "asset-floor-walnut-01" : color === "oak" ? "asset-floor-oak-01" : null,
  };
}

function extractReplacementClass(prompt: string): SceneObject["class"] | null {
  const withMatch = prompt.match(/\bwith\s+(?:a|an)?\s*([a-z_ ]+)/);
  if (!withMatch) {
    return null;
  }
  return extractObjectClass(withMatch[1]);
}

function extractObjectClass(prompt: string): SceneObject["class"] | null {
  for (const entry of OBJECT_CLASS_KEYWORDS) {
    if (entry.phrases.some((phrase) => prompt.includes(phrase))) {
      return entry.className;
    }
  }
  return null;
}

function extractStyleTags(prompt: string, fallback: string[]): string[] {
  const tags = STYLE_TAG_KEYWORDS.filter((entry) => prompt.includes(entry.phrase)).map((entry) => entry.tag);
  return Array.from(new Set(tags.length > 0 ? tags : fallback));
}

function extractColor(prompt: string): string | null {
  for (const color of COLOR_KEYWORDS) {
    if (prompt.includes(color)) {
      return color.replace("grey", "gray");
    }
  }
  return null;
}

function matchesUndo(prompt: string): boolean {
  return /\bundo\b/.test(prompt);
}

function matchesPhotoreal(prompt: string): boolean {
  return prompt.includes("photoreal") || prompt.includes("actually look like") || prompt.includes("render this");
}

function matchesLock(prompt: string): boolean {
  return /(^|\s)lock(\s|$)/.test(prompt) || prompt.includes("don't touch") || prompt.includes("do not touch") || prompt.includes("keep this") || prompt.includes("leave this");
}

function matchesUnlock(prompt: string): boolean {
  return /(^|\s)unlock(\s|$)/.test(prompt) || prompt.includes("you can move this again") || prompt.includes("allow edits");
}

function matchesRepaint(prompt: string): boolean {
  return prompt.includes("paint") || prompt.includes("repaint");
}

function matchesFlooringSwap(prompt: string): boolean {
  return prompt.includes("flooring") || prompt.includes("floor") && (prompt.includes("swap") || prompt.includes("change") || prompt.includes("replace"));
}

function matchesReplace(prompt: string): boolean {
  return prompt.includes("replace") || prompt.includes("swap this") || prompt.includes("swap the");
}

function matchesMove(prompt: string): boolean {
  return prompt.includes("move") || prompt.includes("put") || prompt.includes("place");
}

function normalizePrompt(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function describeObject(object: SceneObject): string {
  return `${object.class} (${object.object_id})`;
}

function describeSurface(surface: Surface, scene: Scene): string {
  const wallRef = surface.named_wall_ref_id
    ? scene.snapshot.state.room.shell.named_wall_refs.find((candidate) => candidate.wall_ref_id === surface.named_wall_ref_id) ?? null
    : null;
  return wallRef ? `${wallRef.name} (${surface.surface_id})` : `${surface.type} surface (${surface.surface_id})`;
}

function clamp(value: number, min: number, max: number): number {
  return roundNumber(Math.min(max, Math.max(min, value)));
}

function roundNumber(value: number): number {
  return Math.round(value * 1000) / 1000;
}
