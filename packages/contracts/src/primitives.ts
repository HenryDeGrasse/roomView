export type ISO8601Timestamp = string;
export type EntityId = string;
export type SnapshotId = string;
export type SceneId = string;
export type JobId = string;
export type BookmarkId = string;
export type AssetId = string;

export const SCENE_SOURCE_VALUES = ["scanned"] as const;
export type SceneSource = (typeof SCENE_SOURCE_VALUES)[number];

export const UNITS_VALUES = ["m"] as const;
export type Units = (typeof UNITS_VALUES)[number];

export interface Point2D {
  x: number;
  y: number;
}

export interface Point3D {
  x: number;
  y: number;
  z: number;
}

export interface Vector3D {
  x: number;
  y: number;
  z: number;
}

export interface Polygon2D {
  vertices: Point2D[];
}

export interface RectOnSurface {
  min_u: number;
  min_v: number;
  width: number;
  height: number;
}

export interface Pose3D {
  position: Point3D;
  yaw_degrees: number;
}

export interface OBB3D {
  center: Point3D;
  size_x: number;
  size_y: number;
  size_z: number;
  yaw_degrees: number;
}

export const NORTH_SOURCE_VALUES = ["true_north", "scan_forward"] as const;
export type NorthSource = (typeof NORTH_SOURCE_VALUES)[number];

export interface RoomCoordinateFrame {
  origin: Point3D;
  x_axis: Vector3D;
  y_axis: Vector3D;
  z_axis: Vector3D;
  north_source: NorthSource;
}

export interface SurfaceFrame {
  origin: Point3D;
  u_axis: Vector3D;
  v_axis: Vector3D;
  normal: Vector3D;
}

export interface MaterialState {
  category: string;
  color: string;
  finish: string | null;
  pattern: string | null;
  reference_asset_id: AssetId | null;
}

export const PROVENANCE_SOURCE_KIND_VALUES = [
  "measured",
  "inferred",
  "generated",
  "user_authored",
] as const;
export type ProvenanceSourceKind = (typeof PROVENANCE_SOURCE_KIND_VALUES)[number];

export interface Provenance {
  source_kind: ProvenanceSourceKind;
  confidence: number;
  source_ref: string | null;
  updated_at: ISO8601Timestamp;
}
