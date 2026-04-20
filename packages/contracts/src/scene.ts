import type {
  AssetId,
  BookmarkId,
  EntityId,
  ISO8601Timestamp,
  JobId,
  OBB3D,
  Point2D,
  Polygon2D,
  Pose3D,
  Provenance,
  RectOnSurface,
  RoomCoordinateFrame,
  SceneId,
  SnapshotId,
  SurfaceFrame,
  Units,
} from "./primitives";
import type { MaterialState } from "./primitives";

export const MUTATION_KIND_VALUES = ["initial_ingest", "edit_plan", "undo_restore"] as const;
export type MutationKind = (typeof MUTATION_KIND_VALUES)[number];

export const ROOM_TYPE_VALUES = ["bedroom"] as const;
export type RoomType = (typeof ROOM_TYPE_VALUES)[number];

export const SURFACE_TYPE_VALUES = ["wall", "floor", "ceiling"] as const;
export type SurfaceType = (typeof SURFACE_TYPE_VALUES)[number];

export const OPENING_TYPE_VALUES = ["door", "window", "closet_door"] as const;
export type OpeningType = (typeof OPENING_TYPE_VALUES)[number];

export const OBJECT_MOBILITY_VALUES = ["movable", "anchored", "fixed"] as const;
export type ObjectMobility = (typeof OBJECT_MOBILITY_VALUES)[number];

export const CHILD_MOVEMENT_POLICY_VALUES = ["move_with_parent", "independent"] as const;
export type ChildMovementPolicy = (typeof CHILD_MOVEMENT_POLICY_VALUES)[number];

export const HOST_RELATION_TYPE_VALUES = [
  "flush_to_wall",
  "mounted_to_wall",
  "embedded_in_wall",
  "ceiling_mounted",
] as const;
export type HostRelationType = (typeof HOST_RELATION_TYPE_VALUES)[number];

export const SUPPORT_KIND_VALUES = ["floor", "wall", "ceiling", "object"] as const;
export type SupportKind = (typeof SUPPORT_KIND_VALUES)[number];

export const FOCAL_ELEMENT_TYPE_VALUES = ["object", "opening", "fixed_element", "surface"] as const;
export type FocalElementType = (typeof FOCAL_ELEMENT_TYPE_VALUES)[number];

export const FOCAL_ELEMENT_ROLE_VALUES = ["primary", "secondary"] as const;
export type FocalElementRole = (typeof FOCAL_ELEMENT_ROLE_VALUES)[number];

export const CONSTRAINT_KIND_VALUES = [
  "opening_preserved",
  "walkway_clearance",
  "no_overlap_in_bounds",
  "anchor_integrity",
  "class_specific_clearance",
  "desk_near_window",
  "sofa_faces_focal_element",
  "primary_path_not_serpentine",
] as const;
export type ConstraintKind = (typeof CONSTRAINT_KIND_VALUES)[number];

export const CONSTRAINT_SEVERITY_VALUES = ["hard", "soft"] as const;
export type ConstraintSeverity = (typeof CONSTRAINT_SEVERITY_VALUES)[number];

export const ASSET_KIND_VALUES = ["gltf", "proxy_gltf"] as const;
export type AssetKind = (typeof ASSET_KIND_VALUES)[number];

export const SPLAT_STATUS_VALUES = ["queued", "processing", "ready", "failed"] as const;
export type SplatStatus = (typeof SPLAT_STATUS_VALUES)[number];

export const SURFACE_MASK_GENERATOR_KIND_VALUES = [
  "deterministic_stub",
  "geometric_projection",
  "sam2_refined",
  "click_sam2",
] as const;
export type SurfaceMaskGeneratorKind = (typeof SURFACE_MASK_GENERATOR_KIND_VALUES)[number];

export const EDITABLE_OBJECT_CLASS_VALUES = [
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
] as const;
export type EditableObjectClass = (typeof EDITABLE_OBJECT_CLASS_VALUES)[number];

export type ObjectClass = EditableObjectClass | "generic_obstacle";

export interface SceneHead {
  scene_id: SceneId;
  source: "scanned";
  units: Units;
  current_snapshot_id: SnapshotId;
  current_scene_version: number;
  undo_base_snapshot_id: SnapshotId | null;
  updated_at: ISO8601Timestamp;
}

export interface SceneSnapshot {
  snapshot_id: SnapshotId;
  scene_id: SceneId;
  scene_version: number;
  based_on_snapshot_id: SnapshotId | null;
  mutation_kind: MutationKind;
  state: SceneState;
  editing_asset_refs: AssetRef[];
  created_at: ISO8601Timestamp;
}

export interface Scene {
  head: SceneHead;
  snapshot: SceneSnapshot;
  derived_state_cache: DerivedState | null;
  bookmarks: CameraBookmark[];
  photoreal_gallery: PhotorealEntry[];
  splat: SplatAssetRecord | null;
  captured_frames: CapturedFrame[];
}

export interface SceneState {
  style_tags: string[];
  room: Room;
}

export interface Room {
  room_id: EntityId;
  room_type: RoomType;
  coordinate_frame: RoomCoordinateFrame;
  shell: Shell;
  objects: SceneObject[];
  constraints: ConstraintSpec[];
  focal_elements: FocalElementRef[];
  section_hints: string[];
}

export interface Shell {
  floor_polygon: Polygon2D;
  ceiling_height: number;
  surfaces: Surface[];
  named_wall_refs: NamedWallRef[];
  openings: Opening[];
  fixed_elements: FixedElement[];
}

export interface Surface {
  surface_id: EntityId;
  type: SurfaceType;
  geometry_ref: string;
  boundary: Polygon2D;
  surface_frame: SurfaceFrame | null;
  named_wall_ref_id: EntityId | null;
  material_state: MaterialState;
  user_locked: boolean;
  provenance: Provenance;
}

export interface Opening {
  opening_id: EntityId;
  host_surface_id: EntityId;
  type: OpeningType;
  rect: RectOnSurface;
  swing_zone: Polygon2D | null;
  keepout_zone: Polygon2D | null;
  connects_to_room_id: EntityId | null;
  provenance: Provenance;
}

export interface ObjectFootprint {
  vertices: Polygon2D["vertices"];
  source: "tsdf_mesh_convex_hull" | "manual" | "fitted_rectangle";
  mesh_vertex_count?: number;
  generated_at?: ISO8601Timestamp;
}

export interface SceneObject {
  object_id: EntityId;
  class: ObjectClass;
  attributes: string[];
  parent_id: EntityId | null;
  child_movement_policy: ChildMovementPolicy;
  pose: Pose3D;
  obb: OBB3D;
  mobility: ObjectMobility;
  host: HostRelation | null;
  support: SupportRelation;
  asset_ref: AssetId | null;
  style_tags: string[];
  material_state: MaterialState | null;
  user_locked: boolean;
  provenance: Provenance;
  /**
   * Optional tight 2D footprint polygon (XY, +z up) derived from the
   * object's TSDF mesh. When present, validation and 2D rendering
   * prefer it over the OBB-rectangle footprint. CCW-ordered, no
   * closing vertex. Convex for v1 (scipy ConvexHull of mesh vertices).
   */
  footprint_polygon?: ObjectFootprint;
}

export interface FixedElement {
  fixed_element_id: EntityId;
  class: string;
  pose: Pose3D;
  obb: OBB3D;
  host: HostRelation | null;
  support: SupportRelation;
  keepout_zone: Polygon2D | null;
  provenance: Provenance;
}

export interface AssetRef {
  asset_id: AssetId;
  kind: AssetKind;
  uri: string;
  bound_to: EntityId;
  /**
   * Optional BOM metadata (stretch.md Track 3 v1.2 Furniture BOM). Populated
   * by the asset library when a retrieved glTF has retailer provenance; absent
   * otherwise. Purely additive — MVP ingest/mutation paths do not populate.
   */
  retailer_url?: string | null;
  retailer_name?: string | null;
  price_cents?: number | null;
  currency?: string | null;
}

export interface SplatAssetRecord {
  scene_id: SceneId;
  source_scene_version: number;
  status: SplatStatus;
  asset_id: AssetId | null;
  uri: string | null;
  job_id?: JobId | null;
  updated_at: ISO8601Timestamp;
}

export interface NamedWallRef {
  wall_ref_id: EntityId;
  name: string;
  surface_ids: EntityId[];
  azimuth_degrees: number;
  inward_normal_xy: Point2D;
}

export interface HostRelation {
  relation_type: HostRelationType;
  host_surface_id: EntityId;
  anchor_rect: RectOnSurface | null;
}

export interface SupportRelation {
  support_kind: SupportKind;
  support_entity_id: EntityId;
  contact_patch: Polygon2D | RectOnSurface | null;
}

export interface FocalElementRef {
  entity_id: EntityId;
  entity_type: FocalElementType;
  role: FocalElementRole;
  reason: string;
}

export interface ConstraintSpec {
  constraint_id: EntityId;
  kind: ConstraintKind;
  severity: ConstraintSeverity;
  target_entity_ids: EntityId[];
  params: Record<string, unknown>;
  reason_code_on_fail: string | null;
}

export interface CameraBookmark {
  bookmark_id: BookmarkId;
  name: string;
  camera_pose: Pose3D;
  fov: number;
  created_at: ISO8601Timestamp;
  updated_at: ISO8601Timestamp;
}

export interface CameraIntrinsics {
  fx: number;
  fy: number;
  cx: number;
  cy: number;
  width: number;
  height: number;
}

export interface CapturedFrameAsset {
  asset_id: AssetId;
  uri: string;
  content_type: string;
}

export interface CapturedFrame {
  frame_id: string;
  scene_id: SceneId;
  captured_at: ISO8601Timestamp;
  bookmark_id: BookmarkId | null;
  camera_pose: Pose3D;
  camera_transform: number[];
  intrinsics: CameraIntrinsics;
  rgb: CapturedFrameAsset;
  depth: CapturedFrameAsset;
  confidence: CapturedFrameAsset | null;
}

export interface PhotorealEntry {
  entry_id: EntityId;
  asset_id: AssetId;
  scene_version: number;
  scene_snapshot_id: SnapshotId;
  bookmark_id: BookmarkId | null;
  camera_pose: Pose3D;
  fov: number;
  prompt_modifiers: string[];
  provider_metadata?: Record<string, unknown>;
  created_at: ISO8601Timestamp;
  /**
   * Optional Showcase-phase fields. Group renders that share an edit so the
   * gallery can display multi-view consistency (same edit from three captured
   * viewpoints). Reference the captured frame when the render used that frame
   * as its reference RGB / depth source.
   */
  render_group_id?: string | null;
  captured_frame_id?: string | null;
  surface_mask_uri?: string | null;
}

/**
 * Showcase-phase artifact binding a 2D edit mask to a scene surface, from a
 * specific captured viewpoint. Produced by the mask service (Route C hybrid:
 * geometric-prior + SAM2 refinement). Consumed by the flux_inpaint_stack
 * provider as the inpaint region, and by the gallery so subsequent renders
 * of the same edit from the same viewpoint can reuse an identical mask.
 */
export interface SurfaceMask {
  mask_id: string;
  surface_id: EntityId;
  captured_frame_id: string;
  generator_kind: SurfaceMaskGeneratorKind;
  mask_uri: string;
  mask_bytes_sha256: string;
  mask_width: number;
  mask_height: number;
  generated_at: ISO8601Timestamp;
}

export interface DerivedState {
  zones: Array<Record<string, unknown>>;
  clearance_paths: Array<Record<string, unknown>>;
  soft_scores: Record<string, number>;
  hard_violations: Array<Record<string, unknown>>;
  selection_context_summary: string;
}

export interface OperationSummary {
  request_id: string;
  ops: Array<Record<string, unknown>>;
  timestamp: ISO8601Timestamp;
  user_message: string;
}

export type Object = SceneObject;
