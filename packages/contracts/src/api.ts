import type {
  AssetId,
  EntityId,
  ISO8601Timestamp,
  JobId,
  OBB3D,
  Point3D,
  Polygon2D,
  Pose3D,
  RectOnSurface,
  SceneId,
  SnapshotId,
  Vector3D,
} from "./primitives";
import type { MaterialState } from "./primitives";
import type { CameraBookmark, EditableObjectClass, Scene } from "./scene";
import type { CuratedAssetManifest, QuickRenderScene } from "./render";

export const COMMAND_KIND_VALUES = ["generate_photoreal", "undo_last_change"] as const;
export type CommandKind = (typeof COMMAND_KIND_VALUES)[number];

export const JOB_KIND_VALUES = ["photoreal", "splat"] as const;
export type JobKind = (typeof JOB_KIND_VALUES)[number];

export const JOB_STATUS_VALUES = ["queued", "processing", "ready", "failed"] as const;
export type JobStatus = (typeof JOB_STATUS_VALUES)[number];

export const HANDOFF_GRANT_STATUS_VALUES = ["issued", "redeemed", "expired", "revoked"] as const;
export type HandoffGrantStatus = (typeof HANDOFF_GRANT_STATUS_VALUES)[number];

export const VIDEO_UPLOAD_TOKEN_STATUS_VALUES = ["issued", "used", "expired", "revoked"] as const;
export type VideoUploadTokenStatus = (typeof VIDEO_UPLOAD_TOKEN_STATUS_VALUES)[number];

export const REASON_CODE_VALUES = [
  "AUTH_REQUIRED",
  "SCENE_ACCESS_DENIED",
  "HANDOFF_EXPIRED",
  "HANDOFF_ALREADY_USED",
  "AMBIGUOUS_TARGET",
  "TARGET_NOT_FOUND",
  "VERSION_CONFLICT",
  "APPLY_TOKEN_INVALID",
  "APPLY_TOKEN_EXPIRED",
  "IDEMPOTENCY_CONFLICT",
  "ENTITY_LOCKED",
  "OBJECT_OVERLAP",
  "OUT_OF_BOUNDS",
  "OPENING_BLOCKED",
  "CLEARANCE_VIOLATION",
  "ANCHOR_VIOLATION",
  "UNSUPPORTED_CLASS",
  "ASSET_NOT_AVAILABLE",
  "PARENT_MOVE_VIOLATION",
  "UNDO_NOT_AVAILABLE",
  "SCENE_DELETED",
  "PHOTOREAL_PROVIDER_ERROR",
  "INVALID_CAPTURE",
  "ROOM_TYPE_NOT_SUPPORTED",
  "MULTI_ROOM_NOT_SUPPORTED",
  "VIDEO_UPLOAD_TOKEN_INVALID",
  "VIDEO_UPLOAD_TOKEN_EXPIRED",
  "VIDEO_UPLOAD_TOKEN_ALREADY_USED",
] as const;
export type ReasonCode = (typeof REASON_CODE_VALUES)[number];

export interface RoomPlanCaptureRequest {
  request_id: string;
  client_capture_id: string;
  roomplan_payload: RoomPlanPayload;
  capture_metadata: CaptureMetadata;
  supplementary_detections: SupplementaryDetection[] | null;
}

export interface RoomPlanPayload {
  schema_version: string;
  room_type: "bedroom" | string;
  coordinate_frame: {
    origin: Point3D;
    x_axis: Vector3D;
    y_axis: Vector3D;
    z_axis: Vector3D;
    north_source: "true_north" | "scan_forward";
  };
  dimensions: {
    width_m: number;
    length_m: number;
    ceiling_height_m: number;
  };
  surfaces: RoomPlanSurfaceSeed[];
  openings: RoomPlanOpeningSeed[];
  objects: RoomPlanObjectSeed[];
  fixed_elements?: RoomPlanFixedElementSeed[] | null;
  room_count?: number | null;
}

export interface CaptureMetadata {
  room_type_hint: "bedroom";
  units: "m";
  device_model: string;
  captured_at: ISO8601Timestamp;
  video_expected: boolean;
}

export interface SupplementaryDetection {
  detection_id: string;
  label: string;
  obb: OBB3D;
  confidence: number;
}

export interface RoomPlanCaptureResponse {
  scene_id: SceneId;
  scene_version: number;
  scene_snapshot_id: SnapshotId;
  handoff_url: string;
  qr_payload: string;
  expires_at: ISO8601Timestamp;
  video_upload_token: string | null;
}

export interface HandoffRedeemRequest {
  handoff_token: string;
}

export interface HandoffRedeemResponse {
  scene_id: SceneId;
  session_id: string;
  redeemed_at: ISO8601Timestamp;
  expires_at: ISO8601Timestamp;
}

export interface OperationPlanRequest {
  request_id: string;
  idempotency_key: string;
  scene_id: SceneId;
  expected_scene_version: number;
  selection_context: {
    selected_entity_ids: EntityId[];
  };
  user_prompt: string;
}

export interface OperationPlanPreview {
  request_id: string;
  preview_id: string;
  based_on_scene_version: number;
  ops: SceneEditOperation[];
  explanation: string;
  canonical_plan_hash: string;
  apply_token: string;
  apply_token_expires_at: ISO8601Timestamp;
  idempotency_key: string;
}

export interface CommandRequest {
  request_id: string;
  command_kind: CommandKind;
  endpoint: string;
  explanation: string;
  idempotency_key: string;
}

export interface ApplyPlanRequest {
  preview_id: string;
  apply_token: string;
  canonical_plan_hash: string;
  expected_scene_version: number;
  idempotency_key: string;
}

export interface ClarificationRequest {
  response_kind: "clarification_request";
  request_id: string;
  prompt: string;
  options: string[];
}

export interface OperationPlanPreviewResponse {
  response_kind: "operation_plan_preview";
  preview: OperationPlanPreview;
}

export interface CommandRequestResponse {
  response_kind: "command_request";
  command: CommandRequest;
}

export interface RejectionResponse {
  response_kind: "rejection";
  request_id: string;
  reason_code: ReasonCode;
  message: string;
}

export type PlannerResponse =
  | ClarificationRequest
  | OperationPlanPreviewResponse
  | CommandRequestResponse
  | RejectionResponse;

export interface MoveObjectOperation {
  op: "move_object";
  object_id: EntityId;
  target_position: Point3D;
  target_named_wall_ref_id?: EntityId | null;
  target_window_opening_id?: EntityId | null;
  include_children?: boolean;
}

export interface RotateObjectOperation {
  op: "rotate_object";
  object_id: EntityId;
  yaw_degrees: number;
  include_children?: boolean;
}

export interface ReplaceObjectOperation {
  op: "replace_object";
  object_id: EntityId;
  desired_class: EditableObjectClass;
  style_tags: string[];
  asset_id?: AssetId | null;
}

export interface PlacementRelation {
  relation: "named_wall" | "window" | "surface_point";
  target_entity_id: EntityId;
  offset_meters?: number;
}

export interface AddObjectOperation {
  op: "add_object";
  object_id: EntityId;
  object_class: EditableObjectClass;
  style_tags: string[];
  placement_relation?: PlacementRelation | null;
  pose?: Pose3D | null;
}

export interface RemoveObjectOperation {
  op: "remove_object";
  object_id: EntityId;
}

export interface LockEntityOperation {
  op: "lock_entity";
  entity_id: EntityId;
  entity_type: "object" | "surface";
}

export interface UnlockEntityOperation {
  op: "unlock_entity";
  entity_id: EntityId;
  entity_type: "object" | "surface";
}

export interface RepaintSurfaceOperation {
  op: "repaint_surface";
  surface_id: EntityId;
  color: string;
  finish?: string | null;
}

export interface SwapFlooringOperation {
  op: "swap_flooring";
  surface_id: EntityId;
  material_state: MaterialState;
}

export type SceneEditOperation =
  | MoveObjectOperation
  | RotateObjectOperation
  | ReplaceObjectOperation
  | AddObjectOperation
  | RemoveObjectOperation
  | LockEntityOperation
  | UnlockEntityOperation
  | RepaintSurfaceOperation
  | SwapFlooringOperation;

export interface SceneReadResponse {
  scene: Scene;
}

export interface AssetManifestResponse {
  manifest: CuratedAssetManifest;
}

export interface QuickRenderResponse {
  render_scene: QuickRenderScene;
}

export interface SceneApplyResponse {
  scene: Scene;
  applied_snapshot_id: SnapshotId;
  applied_scene_version: number;
  validation_summary: {
    hard_violations: Array<Record<string, unknown>>;
    soft_scores: Record<string, number>;
  };
}

export interface GeneratePhotorealRequest {
  scene_snapshot_id: SnapshotId;
  bookmark_id?: string | null;
  camera_pose?: Pose3D | null;
  fov?: number | null;
  prompt_modifiers: string[];
  idempotency_key: string;
}

export interface UndoLastChangeRequest {
  expected_scene_version: number;
  idempotency_key: string;
}

export interface VideoUploadRequest {
  video_upload_token: string;
  content_type: string;
}

export interface VideoUploadResponse {
  job_id: JobId;
}

export interface DeleteSceneRequest {
  idempotency_key: string;
}

export interface JobRecord {
  job_id: JobId;
  scene_id: SceneId;
  job_kind: JobKind;
  status: JobStatus;
  source_scene_version: number | null;
  scene_snapshot_id: SnapshotId | null;
  created_at: ISO8601Timestamp;
  updated_at: ISO8601Timestamp;
  output_asset_id: AssetId | null;
  error_code: ReasonCode | null;
}

export interface HandoffGrantRecord {
  grant_id: string;
  scene_id: SceneId;
  token_hash: string;
  qr_payload: string;
  status: HandoffGrantStatus;
  expires_at: ISO8601Timestamp;
  redeemed_at: ISO8601Timestamp | null;
  redeemed_session_id?: string | null;
}

export interface VideoUploadTokenRecord {
  token_id: string;
  scene_id: SceneId;
  token_hash: string;
  status: VideoUploadTokenStatus;
  expires_at: ISO8601Timestamp;
  used_at: ISO8601Timestamp | null;
  created_at: ISO8601Timestamp;
}

export interface IdempotencyRecord {
  scope: string;
  idempotency_key: string;
  request_hash: string;
  response_status_code: number;
  response_body: Record<string, unknown>;
  scene_id: SceneId | null;
  created_at: ISO8601Timestamp;
  updated_at: ISO8601Timestamp;
}

export interface RoomPlanSurfaceSeed {
  id: string;
  category: "wall" | "floor" | "ceiling";
  polygon: Polygon2D;
  frame: {
    origin: Point3D;
    u_axis: Vector3D;
    v_axis: Vector3D;
    normal: Vector3D;
  } | null;
}

export interface RoomPlanOpeningSeed {
  id: string;
  category: "door" | "window" | "closet_door";
  host_surface_id: string;
  rect: RectOnSurface;
}

export interface RoomPlanObjectSeed {
  id: string;
  category: string;
  pose: Pose3D;
  obb: OBB3D;
  attributes: string[];
}

export interface RoomPlanFixedElementSeed {
  id: string;
  category: string;
  pose: Pose3D;
  obb: OBB3D;
  attributes?: string[];
  host_surface_id?: string | null;
}

export interface FixtureDescriptor {
  fixture_id: string;
  request_path: string;
  scene_path: string;
  notes: string;
}

export interface FixtureManifest {
  fixtures: FixtureDescriptor[];
}

export interface BookmarkSeed {
  bookmark: CameraBookmark;
}
