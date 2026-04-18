import { createHash } from "node:crypto";

import type {
  AddObjectOperation,
  ApplyPlanRequest,
  ConstraintSpec,
  EditableObjectClass,
  EntityId,
  FixedElement,
  LockEntityOperation,
  MaterialState,
  MoveObjectOperation,
  ObjectClass,
  ObjectMobility,
  OBB3D,
  Opening,
  OperationPlanPreview,
  Point2D,
  Point3D,
  Polygon2D,
  Pose3D,
  ReasonCode,
  RepaintSurfaceOperation,
  ResizeObjectOperation,
  ReplaceObjectOperation,
  RotateObjectOperation,
  Scene,
  SceneApplyResponse,
  SceneEditOperation,
  SceneObject,
  ScenePreviewRequest,
  ScenePreviewResponse,
  Surface,
  SwapFlooringOperation,
  UnlockEntityOperation,
} from "../../../packages/contracts/src/index.ts";
import {
  CURATED_ASSET_MANIFEST,
  createCuratedAssetManifestIndex,
  selectCuratedAssetForFootprint,
} from "../../../packages/contracts/src/index.ts";

const DEFAULT_CLEARANCE_WIDTH_M = 0.76;
const MAX_OPS_PER_PREVIEW = 5;
const RESIZABLE_OBJECT_CLASSES = new Set<EditableObjectClass>([
  "bed",
  "nightstand",
  "desk",
  "chair",
  "table",
  "dresser",
  "bookshelf",
  "sofa",
  "rug",
  "storage",
]);

export interface MutationValidationSummary extends SceneApplyResponse["validation_summary"] {}

export interface MutationSimulationResult {
  simulated_scene: Scene;
  validation_summary: MutationValidationSummary;
}

export class SceneMutationError extends Error {
  public readonly reason_code: ReasonCode;
  public readonly validation_summary: MutationValidationSummary | null;

  public constructor(
    reason_code: ReasonCode,
    message: string,
    validation_summary: MutationValidationSummary | null = null
  ) {
    super(message);
    this.name = "SceneMutationError";
    this.reason_code = reason_code;
    this.validation_summary = validation_summary;
  }
}

export function simulateScenePreview(
  scene: Scene,
  request: ScenePreviewRequest,
  now: string
): MutationSimulationResult {
  if (!request.request_id || !request.idempotency_key) {
    throw new SceneMutationError("INVALID_CAPTURE", "request_id and idempotency_key are required.");
  }
  if (!Array.isArray(request.ops) || request.ops.length === 0 || request.ops.length > MAX_OPS_PER_PREVIEW) {
    throw new SceneMutationError(
      "INVALID_CAPTURE",
      `Preview requests must contain between 1 and ${MAX_OPS_PER_PREVIEW} operations.`
    );
  }
  if (request.expected_scene_version !== scene.head.current_scene_version) {
    throw new SceneMutationError(
      "VERSION_CONFLICT",
      `Expected scene version ${request.expected_scene_version} does not match current version ${scene.head.current_scene_version}.`
    );
  }

  const draft = structuredClone(scene);
  draft.snapshot.state.room.objects = [...draft.snapshot.state.room.objects];
  draft.snapshot.state.room.shell.surfaces = [...draft.snapshot.state.room.shell.surfaces];
  draft.snapshot.state.room.shell.openings = [...draft.snapshot.state.room.shell.openings];
  draft.snapshot.state.room.shell.fixed_elements = [...draft.snapshot.state.room.shell.fixed_elements];
  draft.snapshot.editing_asset_refs = [...draft.snapshot.editing_asset_refs];

  for (const operation of request.ops) {
    applyOperation(draft, operation, now);
  }

  draft.snapshot.state.style_tags = deriveSceneStyleTags(draft.snapshot.state.room.objects);
  draft.derived_state_cache = deriveDerivedStateCache(
    draft.snapshot.state.room,
    draft.snapshot.state.room.shell.openings,
    draft.snapshot.state.room.objects,
    draft.snapshot.state.room.shell.fixed_elements
  );

  const validation_summary: MutationValidationSummary = {
    hard_violations: draft.derived_state_cache.hard_violations,
    soft_scores: draft.derived_state_cache.soft_scores,
  };
  if (validation_summary.hard_violations.length > 0) {
    const reasonCode = firstReasonCode(validation_summary.hard_violations);
    throw new SceneMutationError(
      reasonCode,
      `Preview simulation failed with ${reasonCode}.`,
      validation_summary
    );
  }

  return {
    simulated_scene: draft,
    validation_summary,
  };
}

export function createPreviewResponse(
  scene: Scene,
  request: ScenePreviewRequest,
  now: string,
  preview_id: string,
  apply_token: string,
  apply_token_expires_at: string
): ScenePreviewResponse {
  const simulation = simulateScenePreview(scene, request, now);
  const preview: OperationPlanPreview = {
    request_id: request.request_id,
    preview_id,
    based_on_scene_version: scene.head.current_scene_version,
    ops: structuredClone(request.ops),
    explanation: request.explanation,
    canonical_plan_hash: createCanonicalPlanHash(request.ops),
    apply_token,
    apply_token_expires_at,
    idempotency_key: request.idempotency_key,
  };

  return {
    preview,
    simulated_scene: simulation.simulated_scene,
    validation_summary: simulation.validation_summary,
  };
}

export function createCanonicalPlanHash(ops: SceneEditOperation[]): string {
  return createHash("sha256").update(JSON.stringify(ops)).digest("hex");
}

export function hashOpaqueToken(secret: string, token: string): string {
  return createHash("sha256").update(secret).update(":").update(token).digest("hex");
}

function applyOperation(scene: Scene, operation: SceneEditOperation, now: string): void {
  switch (operation.op) {
    case "move_object":
      applyMoveObject(scene, operation, now);
      return;
    case "rotate_object":
      applyRotateObject(scene, operation, now);
      return;
    case "replace_object":
      applyReplaceObject(scene, operation, now);
      return;
    case "resize_object":
      applyResizeObject(scene, operation, now);
      return;
    case "add_object":
      applyAddObject(scene, operation, now);
      return;
    case "remove_object":
      applyRemoveObject(scene, operation, now);
      return;
    case "lock_entity":
      applyLockEntity(scene, operation, true, now);
      return;
    case "unlock_entity":
      applyLockEntity(scene, operation, false, now);
      return;
    case "repaint_surface":
      applyRepaintSurface(scene, operation, now);
      return;
    case "swap_flooring":
      applySwapFlooring(scene, operation, now);
      return;
    default: {
      const exhaustiveCheck: never = operation;
      throw new SceneMutationError("INVALID_CAPTURE", `Unsupported operation ${(exhaustiveCheck as { op: string }).op}`);
    }
  }
}

function applyMoveObject(scene: Scene, operation: MoveObjectOperation, now: string): void {
  const room = scene.snapshot.state.room;
  const object = requireObject(room.objects, operation.object_id);
  ensureObjectUnlocked(object);
  enforceChildMovementPolicy(room.objects, object.object_id, operation.include_children === true);

  const delta = {
    x: roundNumber(operation.target_position.x - object.pose.position.x),
    y: roundNumber(operation.target_position.y - object.pose.position.y),
    z: roundNumber(operation.target_position.z - object.pose.position.z),
  };
  translateObject(object, delta, now);

  if (operation.target_named_wall_ref_id) {
    const wallRef = room.shell.named_wall_refs.find((candidate) => candidate.wall_ref_id === operation.target_named_wall_ref_id);
    if (!wallRef || wallRef.surface_ids.length === 0) {
      throw new SceneMutationError("TARGET_NOT_FOUND", `Named wall ${operation.target_named_wall_ref_id} was not found.`);
    }
    object.host = {
      relation_type: object.host?.relation_type ?? "flush_to_wall",
      host_surface_id: wallRef.surface_ids[0],
      anchor_rect: object.host?.anchor_rect ?? null,
    };
  }

  if (operation.target_window_opening_id) {
    const opening = room.shell.openings.find((candidate) => candidate.opening_id === operation.target_window_opening_id);
    if (!opening) {
      throw new SceneMutationError("TARGET_NOT_FOUND", `Opening ${operation.target_window_opening_id} was not found.`);
    }
    object.host = {
      relation_type: "flush_to_wall",
      host_surface_id: opening.host_surface_id,
      anchor_rect: object.host?.anchor_rect ?? null,
    };
  }

  if (operation.include_children === true) {
    for (const child of findDependentChildren(room.objects, object.object_id)) {
      ensureObjectUnlocked(child);
      translateObject(child, delta, now);
    }
  }
}

function applyRotateObject(scene: Scene, operation: RotateObjectOperation, now: string): void {
  const room = scene.snapshot.state.room;
  const object = requireObject(room.objects, operation.object_id);
  ensureObjectUnlocked(object);
  enforceChildMovementPolicy(room.objects, object.object_id, operation.include_children === true);

  const deltaYaw = roundNumber(operation.yaw_degrees - object.pose.yaw_degrees);
  rotateObjectInPlace(object, operation.yaw_degrees, now);

  if (operation.include_children === true) {
    for (const child of findDependentChildren(room.objects, object.object_id)) {
      ensureObjectUnlocked(child);
      rotateDescendantAroundParent(child, object.pose.position, deltaYaw, now);
    }
  }
}

function applyReplaceObject(scene: Scene, operation: ReplaceObjectOperation, now: string): void {
  const room = scene.snapshot.state.room;
  const object = requireObject(room.objects, operation.object_id);
  ensureObjectUnlocked(object);

  const manifestIndex = createCuratedAssetManifestIndex(CURATED_ASSET_MANIFEST);
  const explicitAsset = operation.asset_id ? manifestIndex.byAssetId.get(operation.asset_id) : null;
  if (operation.asset_id && !explicitAsset) {
    throw new SceneMutationError("ASSET_NOT_AVAILABLE", `Asset ${operation.asset_id} is unavailable.`);
  }

  const selectedAsset = explicitAsset ?? selectCuratedAssetForFootprint(operation.desired_class, object.obb, CURATED_ASSET_MANIFEST);
  object.class = operation.desired_class;
  object.asset_ref = selectedAsset.asset_id;
  object.style_tags = uniqueStrings(operation.style_tags.length > 0 ? operation.style_tags : selectedAsset.style_tags);
  object.material_state = selectedAsset.material_state ? structuredClone(selectedAsset.material_state) : null;
  object.mobility = object.host ? "anchored" : "movable";
  object.provenance = touchProvenance(object.provenance, now);

  upsertEditingAssetRef(scene, {
    asset_id: selectedAsset.asset_id,
    kind: selectedAsset.kind,
    uri: selectedAsset.uri,
    bound_to: object.object_id,
  });
}

function applyResizeObject(scene: Scene, operation: ResizeObjectOperation, now: string): void {
  const room = scene.snapshot.state.room;
  const object = requireObject(room.objects, operation.object_id);
  ensureObjectUnlocked(object);
  ensureObjectClassResizable(object.class);

  const nextSizeX = roundNumber(operation.size_x);
  const nextSizeY = roundNumber(operation.size_y);
  if (!Number.isFinite(nextSizeX) || !Number.isFinite(nextSizeY) || nextSizeX < 0.15 || nextSizeY < 0.15) {
    throw new SceneMutationError("INVALID_CAPTURE", "resize_object requires size_x and size_y to be at least 0.15 meters.");
  }
  if (nextSizeX > 8 || nextSizeY > 8) {
    throw new SceneMutationError("INVALID_CAPTURE", "resize_object sizes larger than 8 meters are not supported.");
  }

  object.obb.size_x = nextSizeX;
  object.obb.size_y = nextSizeY;
  if (object.support.support_kind === "floor") {
    object.support.contact_patch = footprintFromObb(object.obb);
  }
  const selectedAsset = selectCuratedAssetForFootprint(object.class, object.obb, CURATED_ASSET_MANIFEST);
  object.asset_ref = selectedAsset.asset_id;
  upsertEditingAssetRef(scene, {
    asset_id: selectedAsset.asset_id,
    kind: selectedAsset.kind,
    uri: selectedAsset.uri,
    bound_to: object.object_id,
  });
  object.provenance = touchProvenance(object.provenance, now);
}

function applyAddObject(scene: Scene, operation: AddObjectOperation, now: string): void {
  const room = scene.snapshot.state.room;
  if (room.objects.some((object) => object.object_id === operation.object_id)) {
    throw new SceneMutationError("INVALID_CAPTURE", `Object ${operation.object_id} already exists.`);
  }

  const pose = operation.pose ? structuredClone(operation.pose) : derivePlacementPose(room, operation);
  const obb = createDefaultObbForClass(operation.object_class, pose);
  const asset = selectCuratedAssetForFootprint(operation.object_class, obb, CURATED_ASSET_MANIFEST);
  const hostSurfaceId = resolveHostSurfaceId(room, operation);
  const newObject: SceneObject = {
    object_id: operation.object_id,
    class: operation.object_class,
    attributes: [],
    parent_id: null,
    child_movement_policy: "independent",
    pose,
    obb,
    mobility: hostSurfaceId ? "anchored" : "movable",
    host: hostSurfaceId
      ? {
          relation_type: "flush_to_wall",
          host_surface_id: hostSurfaceId,
          anchor_rect: null,
        }
      : null,
    support: {
      support_kind: "floor",
      support_entity_id: requireFloorSurface(room.shell.surfaces).surface_id,
      contact_patch: footprintFromObb(obb),
    },
    asset_ref: asset.asset_id,
    style_tags: uniqueStrings(operation.style_tags.length > 0 ? operation.style_tags : asset.style_tags),
    material_state: asset.material_state ? structuredClone(asset.material_state) : null,
    user_locked: false,
    provenance: {
      source_kind: "user_authored",
      confidence: 1,
      source_ref: `preview:add:${operation.object_id}`,
      updated_at: now,
    },
  };

  room.objects.push(newObject);
  upsertEditingAssetRef(scene, {
    asset_id: asset.asset_id,
    kind: asset.kind,
    uri: asset.uri,
    bound_to: newObject.object_id,
  });
}

function applyRemoveObject(scene: Scene, operation: { object_id: EntityId }, now: string): void {
  const room = scene.snapshot.state.room;
  const object = requireObject(room.objects, operation.object_id);
  ensureObjectUnlocked(object);
  const dependents = room.objects.filter(
    (candidate) => candidate.parent_id === operation.object_id || candidate.support.support_entity_id === operation.object_id
  );
  if (dependents.length > 0) {
    throw new SceneMutationError(
      "PARENT_MOVE_VIOLATION",
      `Cannot remove ${operation.object_id} while dependent child/support objects still exist.`
    );
  }

  room.objects = room.objects.filter((candidate) => candidate.object_id !== operation.object_id);
  scene.snapshot.state.room.objects = room.objects;
  scene.snapshot.editing_asset_refs = scene.snapshot.editing_asset_refs.filter((assetRef) => assetRef.bound_to !== operation.object_id);
  object.provenance = touchProvenance(object.provenance, now);
}

function applyLockEntity(
  scene: Scene,
  operation: LockEntityOperation | UnlockEntityOperation,
  locked: boolean,
  now: string
): void {
  if (operation.entity_type === "object") {
    const object = requireObject(scene.snapshot.state.room.objects, operation.entity_id);
    object.user_locked = locked;
    object.provenance = touchProvenance(object.provenance, now);
    return;
  }
  const surface = requireSurface(scene.snapshot.state.room.shell.surfaces, operation.entity_id);
  surface.user_locked = locked;
  surface.provenance = touchProvenance(surface.provenance, now);
}

function applyRepaintSurface(scene: Scene, operation: RepaintSurfaceOperation, now: string): void {
  const surface = requireSurface(scene.snapshot.state.room.shell.surfaces, operation.surface_id);
  ensureSurfaceUnlocked(surface);
  surface.material_state.color = operation.color;
  surface.material_state.finish = operation.finish ?? surface.material_state.finish;
  surface.provenance = touchProvenance(surface.provenance, now);
}

function applySwapFlooring(scene: Scene, operation: SwapFlooringOperation, now: string): void {
  const surface = requireSurface(scene.snapshot.state.room.shell.surfaces, operation.surface_id);
  ensureSurfaceUnlocked(surface);
  surface.material_state = structuredClone(operation.material_state);
  surface.provenance = touchProvenance(surface.provenance, now);
}

function requireObject(objects: SceneObject[], objectId: EntityId): SceneObject {
  const object = objects.find((candidate) => candidate.object_id === objectId);
  if (!object) {
    throw new SceneMutationError("TARGET_NOT_FOUND", `Object ${objectId} was not found.`);
  }
  return object;
}

function requireSurface(surfaces: Surface[], surfaceId: EntityId): Surface {
  const surface = surfaces.find((candidate) => candidate.surface_id === surfaceId);
  if (!surface) {
    throw new SceneMutationError("TARGET_NOT_FOUND", `Surface ${surfaceId} was not found.`);
  }
  return surface;
}

function requireFloorSurface(surfaces: Surface[]): Surface {
  const floor = surfaces.find((surface) => surface.type === "floor");
  if (!floor) {
    throw new SceneMutationError("INVALID_CAPTURE", "Scene is missing a floor surface.");
  }
  return floor;
}

function ensureObjectUnlocked(object: SceneObject): void {
  if (object.user_locked) {
    throw new SceneMutationError("ENTITY_LOCKED", `Object ${object.object_id} is locked.`);
  }
}

function ensureObjectClassResizable(objectClass: ObjectClass): asserts objectClass is EditableObjectClass {
  if (!RESIZABLE_OBJECT_CLASSES.has(objectClass as EditableObjectClass)) {
    throw new SceneMutationError("UNSUPPORTED_CLASS", `${objectClass} cannot be resized in the MVP.`);
  }
}

function ensureSurfaceUnlocked(surface: Surface): void {
  if (surface.user_locked) {
    throw new SceneMutationError("ENTITY_LOCKED", `Surface ${surface.surface_id} is locked.`);
  }
}

function enforceChildMovementPolicy(objects: SceneObject[], parentId: EntityId, includeChildren: boolean): void {
  const dependents = findDependentChildren(objects, parentId);
  if (dependents.length > 0 && !includeChildren) {
    throw new SceneMutationError(
      "PARENT_MOVE_VIOLATION",
      `Object ${parentId} has dependent children that require include_children=true.`
    );
  }
}

function findDependentChildren(objects: SceneObject[], parentId: EntityId): SceneObject[] {
  return objects.filter(
    (candidate) =>
      candidate.parent_id === parentId &&
      candidate.child_movement_policy === "move_with_parent"
  );
}

function translateObject(object: SceneObject, delta: Point3D, now: string): void {
  object.pose.position = {
    x: roundNumber(object.pose.position.x + delta.x),
    y: roundNumber(object.pose.position.y + delta.y),
    z: roundNumber(object.pose.position.z + delta.z),
  };
  object.obb.center = {
    x: roundNumber(object.obb.center.x + delta.x),
    y: roundNumber(object.obb.center.y + delta.y),
    z: roundNumber(object.obb.center.z + delta.z),
  };
  if (object.support.support_kind === "floor") {
    object.support.contact_patch = footprintFromObb(object.obb);
  }
  object.provenance = touchProvenance(object.provenance, now);
}

function rotateObjectInPlace(object: SceneObject, yawDegrees: number, now: string): void {
  object.pose.yaw_degrees = roundNumber(yawDegrees);
  object.obb.yaw_degrees = roundNumber(yawDegrees);
  if (object.support.support_kind === "floor") {
    object.support.contact_patch = footprintFromObb(object.obb);
  }
  object.provenance = touchProvenance(object.provenance, now);
}

function rotateDescendantAroundParent(child: SceneObject, parentPosition: Point3D, deltaYaw: number, now: string): void {
  const rotated = rotatePointAroundAnchor(
    { x: child.pose.position.x, y: child.pose.position.y },
    { x: parentPosition.x, y: parentPosition.y },
    deltaYaw
  );
  const centerRotated = rotatePointAroundAnchor(
    { x: child.obb.center.x, y: child.obb.center.y },
    { x: parentPosition.x, y: parentPosition.y },
    deltaYaw
  );
  child.pose.position = {
    x: rotated.x,
    y: rotated.y,
    z: child.pose.position.z,
  };
  child.pose.yaw_degrees = roundNumber(child.pose.yaw_degrees + deltaYaw);
  child.obb.center = {
    x: centerRotated.x,
    y: centerRotated.y,
    z: child.obb.center.z,
  };
  child.obb.yaw_degrees = roundNumber(child.obb.yaw_degrees + deltaYaw);
  if (child.support.support_kind === "floor") {
    child.support.contact_patch = footprintFromObb(child.obb);
  }
  child.provenance = touchProvenance(child.provenance, now);
}

function rotatePointAroundAnchor(point: Point2D, anchor: Point2D, deltaYaw: number): Point2D {
  const radians = degreesToRadians(deltaYaw);
  const dx = point.x - anchor.x;
  const dy = point.y - anchor.y;
  return {
    x: roundNumber(anchor.x + dx * Math.cos(radians) - dy * Math.sin(radians)),
    y: roundNumber(anchor.y + dx * Math.sin(radians) + dy * Math.cos(radians)),
  };
}

function touchProvenance<T extends { source_kind: string; confidence: number; source_ref: string | null; updated_at: string }>(
  provenance: T,
  now: string
): T {
  return {
    ...provenance,
    source_kind: "user_authored",
    confidence: 1,
    updated_at: now,
  };
}

function upsertEditingAssetRef(scene: Scene, assetRef: Scene["snapshot"]["editing_asset_refs"][number]): void {
  const existingIndex = scene.snapshot.editing_asset_refs.findIndex((candidate) => candidate.bound_to === assetRef.bound_to);
  if (existingIndex >= 0) {
    scene.snapshot.editing_asset_refs[existingIndex] = assetRef;
    return;
  }
  scene.snapshot.editing_asset_refs.push(assetRef);
  scene.snapshot.editing_asset_refs.sort((left, right) => left.bound_to.localeCompare(right.bound_to));
}

function resolveHostSurfaceId(sceneRoom: Scene["snapshot"]["state"]["room"], operation: AddObjectOperation): EntityId | null {
  if (!operation.placement_relation) {
    return null;
  }
  if (operation.placement_relation.relation === "named_wall") {
    const wallRef = sceneRoom.shell.named_wall_refs.find((candidate) => candidate.wall_ref_id === operation.placement_relation?.target_entity_id);
    if (!wallRef || wallRef.surface_ids.length === 0) {
      throw new SceneMutationError("TARGET_NOT_FOUND", `Named wall ${operation.placement_relation.target_entity_id} was not found.`);
    }
    return wallRef.surface_ids[0];
  }
  if (operation.placement_relation.relation === "window") {
    const opening = sceneRoom.shell.openings.find((candidate) => candidate.opening_id === operation.placement_relation?.target_entity_id);
    if (!opening) {
      throw new SceneMutationError("TARGET_NOT_FOUND", `Opening ${operation.placement_relation.target_entity_id} was not found.`);
    }
    return opening.host_surface_id;
  }
  return null;
}

function derivePlacementPose(room: Scene["snapshot"]["state"]["room"], operation: AddObjectOperation): Pose3D {
  const bounds = polygonBounds(room.shell.floor_polygon);
  if (!operation.placement_relation) {
    return {
      position: {
        x: roundNumber((bounds.min_x + bounds.max_x) / 2),
        y: roundNumber((bounds.min_y + bounds.max_y) / 2),
        z: 0,
      },
      yaw_degrees: 0,
    };
  }

  if (operation.placement_relation.relation === "named_wall") {
    const wallRef = room.shell.named_wall_refs.find((candidate) => candidate.wall_ref_id === operation.placement_relation?.target_entity_id);
    if (!wallRef) {
      throw new SceneMutationError("TARGET_NOT_FOUND", `Named wall ${operation.placement_relation.target_entity_id} was not found.`);
    }
    const offset = operation.placement_relation.offset_meters ?? 0.2;
    const xMid = roundNumber((bounds.min_x + bounds.max_x) / 2);
    const yMid = roundNumber((bounds.min_y + bounds.max_y) / 2);
    switch (wallRef.name) {
      case "north wall":
        return { position: { x: xMid, y: roundNumber(bounds.max_y - 0.5 - offset), z: 0 }, yaw_degrees: 180 };
      case "south wall":
        return { position: { x: xMid, y: roundNumber(bounds.min_y + 0.5 + offset), z: 0 }, yaw_degrees: 0 };
      case "east wall":
        return { position: { x: roundNumber(bounds.max_x - 0.5 - offset), y: yMid, z: 0 }, yaw_degrees: 270 };
      default:
        return { position: { x: roundNumber(bounds.min_x + 0.5 + offset), y: yMid, z: 0 }, yaw_degrees: 90 };
    }
  }

  if (operation.placement_relation.relation === "window") {
    const opening = room.shell.openings.find((candidate) => candidate.opening_id === operation.placement_relation?.target_entity_id);
    if (!opening) {
      throw new SceneMutationError("TARGET_NOT_FOUND", `Opening ${operation.placement_relation.target_entity_id} was not found.`);
    }
    const anchor = openingAnchorPoint(opening);
    return {
      position: { x: anchor.x, y: roundNumber(anchor.y - 0.6), z: 0 },
      yaw_degrees: 180,
    };
  }

  const targetSurface = room.shell.surfaces.find((candidate) => candidate.surface_id === operation.placement_relation.target_entity_id);
  if (!targetSurface) {
    throw new SceneMutationError("TARGET_NOT_FOUND", `Surface ${operation.placement_relation.target_entity_id} was not found.`);
  }
  const center = polygonCenter(targetSurface.boundary);
  return {
    position: { x: center.x, y: center.y, z: 0 },
    yaw_degrees: 0,
  };
}

function createDefaultObbForClass(objectClass: EditableObjectClass, pose: Pose3D): OBB3D {
  const selectedAsset = selectCuratedAssetForFootprint(objectClass, {
    center: { x: pose.position.x, y: pose.position.y, z: 0.4 },
    size_x: defaultDimensionsForClass(objectClass).x,
    size_y: defaultDimensionsForClass(objectClass).y,
    size_z: defaultDimensionsForClass(objectClass).z,
    yaw_degrees: pose.yaw_degrees,
  });
  const defaultDimensions = defaultDimensionsForClass(objectClass, selectedAsset.preferred_size_xy ?? undefined);
  return {
    center: {
      x: pose.position.x,
      y: pose.position.y,
      z: roundNumber(defaultDimensions.z / 2),
    },
    size_x: defaultDimensions.x,
    size_y: defaultDimensions.y,
    size_z: defaultDimensions.z,
    yaw_degrees: pose.yaw_degrees,
  };
}

function defaultDimensionsForClass(
  objectClass: EditableObjectClass,
  preferredSize?: { x: number; y: number }
): { x: number; y: number; z: number } {
  const preferred = preferredSize ?? { x: 1, y: 1 };
  switch (objectClass) {
    case "bed":
      return { x: preferred.x, y: preferred.y, z: 0.6 };
    case "nightstand":
      return { x: preferred.x, y: preferred.y, z: 0.6 };
    case "desk":
      return { x: preferred.x, y: preferred.y, z: 0.74 };
    case "chair":
      return { x: preferred.x, y: preferred.y, z: 0.9 };
    case "dresser":
    case "storage":
    case "bookshelf":
      return { x: preferred.x, y: preferred.y, z: 1.0 };
    case "rug":
      return { x: preferred.x, y: preferred.y, z: 0.02 };
    case "lamp":
      return { x: preferred.x, y: preferred.y, z: 0.4 };
    default:
      return { x: preferred.x, y: preferred.y, z: 0.8 };
  }
}

function deriveSceneStyleTags(objects: SceneObject[]): string[] {
  const counts = new Map<string, number>();
  for (const object of objects) {
    for (const tag of object.style_tags) {
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  }
  return Array.from(counts.entries())
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 3)
    .map(([tag]) => tag);
}

function deriveDerivedStateCache(
  room: Scene["snapshot"]["state"]["room"],
  openings: Opening[],
  objects: SceneObject[],
  fixedElements: FixedElement[]
): Scene["derived_state_cache"] {
  const zones: Array<Record<string, unknown>> = [];
  const floorBounds = polygonBounds(room.shell.floor_polygon);

  for (const object of objects) {
    if (object.class === "bed") {
      zones.push({
        zone_id: `zone:${object.object_id}:bed_access`,
        kind: "bed_access",
        entity_id: object.object_id,
        polygon: accessZoneForObject(object, 0.9),
      });
    }
    if (object.class === "desk") {
      zones.push({
        zone_id: `zone:${object.object_id}:desk_pullout`,
        kind: "desk_pullout",
        entity_id: object.object_id,
        polygon: frontAccessZoneForObject(object, 0.9),
      });
    }
    if (object.class === "generic_obstacle") {
      zones.push({
        zone_id: `zone:${object.object_id}:obstacle_buffer`,
        kind: "obstacle_buffer",
        entity_id: object.object_id,
        polygon: expandPolygon(footprintFromObb(object.obb), 0.15),
      });
    }
  }

  const hardViolations: Array<Record<string, unknown>> = [];
  for (const object of objects) {
    if (!boundsContainBounds(floorBounds, polygonBounds(footprintFromObb(object.obb)))) {
      hardViolations.push({
        entity_id: object.object_id,
        reason_code: "OUT_OF_BOUNDS",
        message: `${object.class} extends outside the captured floor polygon.`,
      });
    }
    if (object.host) {
      const hostSurface = room.shell.surfaces.find((surface) => surface.surface_id === object.host?.host_surface_id) ?? null;
      if (!hostSurface || !hostSurface.surface_frame) {
        hardViolations.push({
          entity_id: object.object_id,
          reason_code: "ANCHOR_VIOLATION",
          message: `${object.object_id} has an invalid host surface.`,
        });
      } else {
        const distance = distanceToSurfacePlane(object.pose.position, hostSurface);
        if (distance > Math.max(object.obb.size_x, object.obb.size_y) / 2 + 0.35) {
          hardViolations.push({
            entity_id: object.object_id,
            reason_code: "ANCHOR_VIOLATION",
            message: `${object.object_id} moved too far from its anchored wall.`,
          });
        }
      }
    }
    if (object.support.support_kind === "object") {
      const supportObject = objects.find((candidate) => candidate.object_id === object.support.support_entity_id) ?? null;
      if (!supportObject) {
        hardViolations.push({
          entity_id: object.object_id,
          reason_code: "PARENT_MOVE_VIOLATION",
          message: `${object.object_id} lost its supporting parent object.`,
        });
      }
    }
  }

  for (let index = 0; index < objects.length; index += 1) {
    const left = objects[index];
    const leftBounds = polygonBounds(footprintFromObb(left.obb));
    for (let inner = index + 1; inner < objects.length; inner += 1) {
      const right = objects[inner];
      if (canObjectsLegallyOverlap(left, right)) {
        continue;
      }
      const rightBounds = polygonBounds(footprintFromObb(right.obb));
      const overlapArea = intersectionArea(leftBounds, rightBounds);
      const smallerArea = Math.min(boundsArea(leftBounds), boundsArea(rightBounds));
      const allowWallClusterOverlap =
        ((left.host?.host_surface_id && left.host.host_surface_id === right.host?.host_surface_id) ||
          [left.class, right.class].includes("nightstand") ||
          [left.class, right.class].includes("lamp")) &&
        smallerArea <= 0.35;
      if (intersectsBounds(leftBounds, rightBounds) && overlapArea > 0.18 && !allowWallClusterOverlap) {
        hardViolations.push({
          entity_ids: [left.object_id, right.object_id],
          reason_code: "OBJECT_OVERLAP",
          message: `${left.class} overlaps ${right.class}.`,
        });
      }
    }
  }

  for (const opening of openings) {
    if (opening.type !== "door" && opening.type !== "closet_door") {
      continue;
    }
    const keepout = opening.keepout_zone ? polygonBounds(opening.keepout_zone) : null;
    if (!keepout) {
      continue;
    }
    const blockedBy = objects
      .filter((object) => blocksFloorZones(object) && distance2D(openingAnchorPoint(opening), { x: object.pose.position.x, y: object.pose.position.y }) < 0.35)
      .map((object) => object.object_id);
    if (blockedBy.length > 0) {
      hardViolations.push({
        entity_id: opening.opening_id,
        reason_code: "OPENING_BLOCKED",
        blocked_by: blockedBy,
      });
    }
  }

  for (const fixedElement of fixedElements) {
    if (fixedElement.keepout_zone) {
      const keepout = polygonBounds(fixedElement.keepout_zone);
      const blockedBy = objects
        .filter(
          (object) =>
            blocksFloorZones(object) &&
            intersectionArea(keepout, polygonBounds(footprintFromObb(object.obb))) > 0.2
        )
        .map((object) => object.object_id);
      if (blockedBy.length > 0) {
        hardViolations.push({
          entity_id: fixedElement.fixed_element_id,
          reason_code: "OBJECT_OVERLAP",
          blocked_by: blockedBy,
        });
      }
    }
  }

  const clearance_paths: Array<Record<string, unknown>> = [];
  const door = openings.find((opening) => opening.type === "door" || opening.type === "closet_door") ?? null;
  if (door) {
    const start = openingAnchorPoint(door);
    for (const target of objects.filter((object) => ["bed", "desk", "storage", "dresser"].includes(object.class))) {
      const targetPoint = { x: target.pose.position.x, y: target.pose.position.y };
      const midPoint = { x: roundNumber((start.x + targetPoint.x) / 2), y: roundNumber((start.y + targetPoint.y) / 2) };
      const width_m = estimatePathWidth(start, targetPoint, objects, fixedElements, target.object_id);
      clearance_paths.push({
        path_id: `path:${door.opening_id}:${target.object_id}`,
        width_m,
        waypoints: [start, midPoint, targetPoint],
      });
      if (distance2D(start, targetPoint) < 0.4) {
        hardViolations.push({
          entity_id: target.object_id,
          reason_code: "CLEARANCE_VIOLATION",
          message: `Insufficient walkway width (${width_m}m) from door to ${target.class}.`,
        });
      }
    }
  }

  const soft_scores: Record<string, number> = {};
  const desk = objects.find((object) => object.class === "desk") ?? null;
  const window = openings.find((opening) => opening.type === "window") ?? null;
  if (desk && window) {
    const keepoutCenter = polygonCenter(window.keepout_zone ?? rectToFloorPolygon(window.rect));
    const distance = distance2D({ x: desk.pose.position.x, y: desk.pose.position.y }, keepoutCenter);
    soft_scores.desk_near_window = roundNumber(clamp01(1 - Math.max(distance - 0.75, 0) / 2));
  }

  const primaryTarget = objects.find((object) => object.class === "bed") ?? null;
  if (door && primaryTarget) {
    const pathStart = openingAnchorPoint(door);
    const pathEnd = { x: primaryTarget.pose.position.x, y: primaryTarget.pose.position.y };
    const directDistance = distance2D(pathStart, pathEnd);
    const actualDistance = clearance_paths[0]
      ? pathLength(clearance_paths[0].waypoints as Array<Point2D>)
      : directDistance;
    const tortuosity = directDistance === 0 ? 1 : actualDistance / directDistance;
    soft_scores.primary_path_not_serpentine = roundNumber(clamp01(1.4 - tortuosity));
  }

  const sofa = objects.find((object) => object.class === "sofa") ?? null;
  if (sofa && window) {
    const targetPoint = openingAnchorPoint(window);
    const angleToTarget = radiansToDegrees(Math.atan2(targetPoint.y - sofa.pose.position.y, targetPoint.x - sofa.pose.position.x));
    const angularError = normalizedAngleDifference(sofa.pose.yaw_degrees, angleToTarget);
    soft_scores.sofa_faces_focal_element = roundNumber(clamp01(1 - angularError / 90));
  }

  return {
    zones,
    clearance_paths,
    soft_scores,
    hard_violations: dedupeViolations(hardViolations),
    selection_context_summary: createSelectionSummary(objects, openings),
  };
}

function firstReasonCode(violations: Array<Record<string, unknown>>): ReasonCode {
  const first = violations.find((violation) => typeof violation.reason_code === "string");
  return (first?.reason_code as ReasonCode | undefined) ?? "OBJECT_OVERLAP";
}

function distanceToSurfacePlane(position: Point3D, surface: Surface): number {
  if (!surface.surface_frame) {
    return 0;
  }
  const normal = surface.surface_frame.normal;
  const planePoint = surface.surface_frame.origin;
  return Math.abs((position.x - planePoint.x) * normal.x + (position.y - planePoint.y) * normal.y);
}

function accessZoneForObject(object: SceneObject, depth: number): Polygon2D {
  const footprint = footprintFromObb(object.obb);
  const bounds = polygonBounds(footprint);
  const hostNormal = object.host ? hostSurfaceNormalToAccessDirection(object) : null;
  if (hostNormal) {
    return expandTowardDirection(boundsToPolygon(bounds), hostNormal, depth);
  }
  return expandTowardDirection(boundsToPolygon(bounds), { x: 1, y: 0 }, depth);
}

function frontAccessZoneForObject(object: SceneObject, depth: number): Polygon2D {
  return expandTowardDirection(footprintFromObb(object.obb), yawVector(object.pose.yaw_degrees), depth);
}

function hostSurfaceNormalToAccessDirection(object: SceneObject): Point2D | null {
  if (!object.host) {
    return null;
  }
  const yawVectorPoint = yawVector(object.pose.yaw_degrees);
  return { x: roundNumber(-yawVectorPoint.y), y: roundNumber(yawVectorPoint.x) };
}

function estimatePathWidth(
  start: Point2D,
  end: Point2D,
  objects: SceneObject[],
  fixedElements: FixedElement[],
  targetObjectId: string
): number {
  let width = 1.0;
  for (const object of objects) {
    if (!blocksFloorZones(object) || object.object_id === targetObjectId) {
      continue;
    }
    const bounds = polygonBounds(footprintFromObb(object.obb));
    if (pointInBounds(start, bounds) || pointInBounds(end, bounds)) {
      continue;
    }
    const distance = distancePointToBoundsSegment(start, end, bounds);
    width = Math.min(width, roundNumber(Math.max(distance * 2, 0.4)));
  }
  for (const fixedElement of fixedElements) {
    const keepout = fixedElement.keepout_zone ? polygonBounds(fixedElement.keepout_zone) : polygonBounds(footprintFromObb(fixedElement.obb));
    if (pointInBounds(start, keepout) || pointInBounds(end, keepout)) {
      continue;
    }
    const distance = distancePointToBoundsSegment(start, end, keepout);
    width = Math.min(width, roundNumber(Math.max(distance * 2, 0.4)));
  }
  return roundNumber(width);
}

function blocksFloorZones(object: SceneObject): boolean {
  return object.class !== "rug" && object.support.support_kind === "floor";
}

function canObjectsLegallyOverlap(left: SceneObject, right: SceneObject): boolean {
  if (left.support.support_kind !== "floor" || right.support.support_kind !== "floor") {
    return true;
  }
  if (left.class === "rug" || right.class === "rug") {
    return true;
  }
  if (left.parent_id === right.object_id || right.parent_id === left.object_id) {
    return true;
  }
  return false;
}

function createSelectionSummary(objects: SceneObject[], openings: Opening[]): string {
  const parts: string[] = [];
  const bed = objects.find((object) => object.class === "bed");
  const desk = objects.find((object) => object.class === "desk");
  const obstacle = objects.find((object) => object.class === "generic_obstacle");
  if (bed) {
    parts.push("Bed captured as primary sleep anchor.");
  }
  if (desk) {
    const nearWindow = openings.some(
      (opening) => opening.type === "window" && distance2D(openingAnchorPoint(opening), { x: desk.pose.position.x, y: desk.pose.position.y }) < 1.5
    );
    parts.push(nearWindow ? "Desk positioned near a window." : "Desk available as secondary target.");
  }
  if (obstacle) {
    parts.push("Unsupported detection preserved as generic obstacle.");
  }
  if (parts.length === 0) {
    parts.push("Editable scene updated from scripted mutation preview.");
  }
  return parts.join(" ");
}

function footprintFromObb(obb: OBB3D): Polygon2D {
  const halfX = obb.size_x / 2;
  const halfY = obb.size_y / 2;
  const radians = degreesToRadians(obb.yaw_degrees);
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const corners = [
    { x: -halfX, y: -halfY },
    { x: halfX, y: -halfY },
    { x: halfX, y: halfY },
    { x: -halfX, y: halfY },
  ].map((corner) => ({
    x: roundNumber(obb.center.x + corner.x * cos - corner.y * sin),
    y: roundNumber(obb.center.y + corner.x * sin + corner.y * cos),
  }));
  return { vertices: corners };
}

function openingAnchorPoint(opening: Opening): Point2D {
  if (opening.keepout_zone) {
    return polygonCenter(opening.keepout_zone);
  }
  return { x: roundNumber(opening.rect.min_u + opening.rect.width / 2), y: roundNumber(opening.rect.min_v + opening.rect.height / 2) };
}

function rectToFloorPolygon(rect: Opening["rect"]): Polygon2D {
  return {
    vertices: [
      { x: rect.min_u, y: rect.min_v },
      { x: rect.min_u + rect.width, y: rect.min_v },
      { x: rect.min_u + rect.width, y: rect.min_v + rect.height },
      { x: rect.min_u, y: rect.min_v + rect.height },
    ].map((point) => ({ x: roundNumber(point.x), y: roundNumber(point.y) })),
  };
}

function expandTowardDirection(polygon: Polygon2D, direction: Point2D, distance: number): Polygon2D {
  const normalized = normalizeVector2D(direction);
  return {
    vertices: polygon.vertices.map((vertex) => ({
      x: roundNumber(vertex.x + normalized.x * distance),
      y: roundNumber(vertex.y + normalized.y * distance),
    })),
  };
}

function expandPolygon(polygon: Polygon2D, amount: number): Polygon2D {
  const center = polygonCenter(polygon);
  return {
    vertices: polygon.vertices.map((vertex) => {
      const dx = vertex.x - center.x;
      const dy = vertex.y - center.y;
      const length = Math.hypot(dx, dy) || 1;
      return {
        x: roundNumber(vertex.x + (dx / length) * amount),
        y: roundNumber(vertex.y + (dy / length) * amount),
      };
    }),
  };
}

function polygonBounds(polygon: Polygon2D): { min_x: number; max_x: number; min_y: number; max_y: number } {
  let min_x = Number.POSITIVE_INFINITY;
  let max_x = Number.NEGATIVE_INFINITY;
  let min_y = Number.POSITIVE_INFINITY;
  let max_y = Number.NEGATIVE_INFINITY;
  for (const vertex of polygon.vertices) {
    min_x = Math.min(min_x, vertex.x);
    max_x = Math.max(max_x, vertex.x);
    min_y = Math.min(min_y, vertex.y);
    max_y = Math.max(max_y, vertex.y);
  }
  return { min_x, max_x, min_y, max_y };
}

function boundsArea(bounds: { min_x: number; max_x: number; min_y: number; max_y: number }): number {
  return roundNumber(Math.max(0, bounds.max_x - bounds.min_x) * Math.max(0, bounds.max_y - bounds.min_y));
}

function boundsContainBounds(
  outer: { min_x: number; max_x: number; min_y: number; max_y: number },
  inner: { min_x: number; max_x: number; min_y: number; max_y: number }
): boolean {
  return (
    inner.min_x >= outer.min_x &&
    inner.max_x <= outer.max_x &&
    inner.min_y >= outer.min_y &&
    inner.max_y <= outer.max_y
  );
}

function boundsToPolygon(bounds: { min_x: number; max_x: number; min_y: number; max_y: number }): Polygon2D {
  return {
    vertices: [
      { x: bounds.min_x, y: bounds.min_y },
      { x: bounds.max_x, y: bounds.min_y },
      { x: bounds.max_x, y: bounds.max_y },
      { x: bounds.min_x, y: bounds.max_y },
    ].map((vertex) => ({ x: roundNumber(vertex.x), y: roundNumber(vertex.y) })),
  };
}

function pointInBounds(point: Point2D, bounds: { min_x: number; max_x: number; min_y: number; max_y: number }): boolean {
  return point.x >= bounds.min_x && point.x <= bounds.max_x && point.y >= bounds.min_y && point.y <= bounds.max_y;
}

function intersectsBounds(
  left: { min_x: number; max_x: number; min_y: number; max_y: number },
  right: { min_x: number; max_x: number; min_y: number; max_y: number }
): boolean {
  return !(
    left.max_x <= right.min_x ||
    left.min_x >= right.max_x ||
    left.max_y <= right.min_y ||
    left.min_y >= right.max_y
  );
}

function intersectionArea(
  left: { min_x: number; max_x: number; min_y: number; max_y: number },
  right: { min_x: number; max_x: number; min_y: number; max_y: number }
): number {
  const overlapX = Math.max(0, Math.min(left.max_x, right.max_x) - Math.max(left.min_x, right.min_x));
  const overlapY = Math.max(0, Math.min(left.max_y, right.max_y) - Math.max(left.min_y, right.min_y));
  return roundNumber(overlapX * overlapY);
}

function polygonCenter(polygon: Polygon2D): Point2D {
  const total = polygon.vertices.reduce(
    (accumulator, vertex) => ({ x: accumulator.x + vertex.x, y: accumulator.y + vertex.y }),
    { x: 0, y: 0 }
  );
  return {
    x: roundNumber(total.x / polygon.vertices.length),
    y: roundNumber(total.y / polygon.vertices.length),
  };
}

function pathLength(points: Point2D[]): number {
  let total = 0;
  for (let index = 1; index < points.length; index += 1) {
    total += distance2D(points[index - 1], points[index]);
  }
  return total;
}

function distance2D(left: Point2D, right: Point2D): number {
  return roundNumber(Math.hypot(left.x - right.x, left.y - right.y));
}

function distancePointToBoundsSegment(
  start: Point2D,
  end: Point2D,
  bounds: { min_x: number; max_x: number; min_y: number; max_y: number }
): number {
  const samplePoints = [
    { x: bounds.min_x, y: bounds.min_y },
    { x: bounds.max_x, y: bounds.min_y },
    { x: bounds.max_x, y: bounds.max_y },
    { x: bounds.min_x, y: bounds.max_y },
  ];
  return samplePoints.reduce((best, point) => Math.min(best, distancePointToSegment(point, start, end)), Number.POSITIVE_INFINITY);
}

function distancePointToSegment(point: Point2D, start: Point2D, end: Point2D): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  if (dx === 0 && dy === 0) {
    return distance2D(point, start);
  }
  const t = clamp01(((point.x - start.x) * dx + (point.y - start.y) * dy) / (dx * dx + dy * dy));
  const projection = { x: start.x + t * dx, y: start.y + t * dy };
  return distance2D(point, projection);
}

function yawVector(yawDegrees: number): Point2D {
  const radians = degreesToRadians(yawDegrees);
  return { x: roundNumber(Math.cos(radians)), y: roundNumber(Math.sin(radians)) };
}

function normalizeVector2D(vector: Point2D): Point2D {
  const magnitude = Math.hypot(vector.x, vector.y) || 1;
  return { x: roundNumber(vector.x / magnitude), y: roundNumber(vector.y / magnitude) };
}

function normalizedAngleDifference(left: number, right: number): number {
  return roundNumber(Math.abs((((left - right) % 360) + 540) % 360 - 180));
}

function degreesToRadians(value: number): number {
  return (value * Math.PI) / 180;
}

function radiansToDegrees(value: number): number {
  return (value * 180) / Math.PI;
}

function roundNumber(value: number, precision = 3): number {
  const factor = 10 ** precision;
  return Math.round(value * factor) / factor;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.filter((value) => value.length > 0)));
}

function dedupeViolations(violations: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const seen = new Set<string>();
  const results: Array<Record<string, unknown>> = [];
  for (const violation of violations) {
    const key = JSON.stringify(violation);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    results.push(violation);
  }
  return results;
}
