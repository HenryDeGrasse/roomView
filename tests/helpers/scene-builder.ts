/**
 * Minimal programmatic scene builder for unit tests.
 *
 * Unit tests want small, hand-crafted scenes that exercise one specific code
 * path. This helper provides a 4×3m bedroom with configurable objects so
 * individual tests can override exactly what they care about.
 */
import type {
  AssetRef,
  EditableObjectClass,
  FixedElement,
  HostRelation,
  MaterialState,
  NamedWallRef,
  OBB3D,
  ObjectClass,
  Opening,
  Polygon2D,
  Pose3D,
  Provenance,
  Scene,
  SceneHead,
  SceneObject,
  SceneSnapshot,
  SupportRelation,
  Surface,
} from "../../packages/contracts/src/index.ts";

const DEFAULT_NOW = "2026-04-17T00:00:00.000Z";

function defaultProvenance(now: string = DEFAULT_NOW): Provenance {
  return {
    source_kind: "measured",
    confidence: 1,
    source_ref: "test:fixture",
    updated_at: now,
  };
}

function defaultMaterial(): MaterialState {
  return {
    category: "paint",
    color: "warm_white",
    finish: "eggshell",
    pattern: null,
    reference_asset_id: null,
  };
}

function floorMaterial(): MaterialState {
  return {
    category: "flooring",
    color: "oak",
    finish: "matte",
    pattern: "plank",
    reference_asset_id: "asset-floor-oak-01",
  };
}

function rect(xMin: number, yMin: number, xMax: number, yMax: number): Polygon2D {
  return {
    vertices: [
      { x: xMin, y: yMin },
      { x: xMax, y: yMin },
      { x: xMax, y: yMax },
      { x: xMin, y: yMax },
    ],
  };
}

export interface MinimalObjectOverride {
  object_id: string;
  class: ObjectClass;
  pose?: Pose3D;
  obb?: OBB3D;
  parent_id?: string | null;
  asset_ref?: string | null;
  host?: HostRelation | null;
  support?: SupportRelation;
  style_tags?: string[];
  user_locked?: boolean;
  child_movement_policy?: "move_with_parent" | "independent";
  material_state?: MaterialState | null;
}

export interface BuildMinimalSceneOptions {
  now?: string;
  scene_id?: string;
  snapshot_id?: string;
  room_polygon?: Polygon2D;
  ceiling_height?: number;
  objects?: MinimalObjectOverride[];
  editing_asset_refs?: AssetRef[];
  openings?: Opening[];
  fixed_elements?: FixedElement[];
  head_override?: Partial<SceneHead>;
  snapshot_override?: Partial<SceneSnapshot>;
  floor_locked?: boolean;
  north_wall_locked?: boolean;
}

export function buildMinimalScene(options: BuildMinimalSceneOptions = {}): Scene {
  const now = options.now ?? DEFAULT_NOW;
  const sceneId = options.scene_id ?? "scene:test";
  const snapshotId = options.snapshot_id ?? "snap:test:v1";

  // Default 4m (E–W) × 3m (N–S) bedroom centered at origin.
  const floorPolygon = options.room_polygon ?? rect(-2, -1.5, 2, 1.5);
  const ceilingHeight = options.ceiling_height ?? 2.6;

  const floorSurface: Surface = {
    surface_id: "surf:floor",
    type: "floor",
    geometry_ref: "geom:floor",
    boundary: floorPolygon,
    surface_frame: {
      origin: { x: 0, y: 0, z: 0 },
      u_axis: { x: 1, y: 0, z: 0 },
      v_axis: { x: 0, y: 1, z: 0 },
      normal: { x: 0, y: 0, z: 1 },
    },
    named_wall_ref_id: null,
    material_state: floorMaterial(),
    user_locked: options.floor_locked ?? false,
    provenance: defaultProvenance(now),
  };

  const ceilingSurface: Surface = {
    surface_id: "surf:ceiling",
    type: "ceiling",
    geometry_ref: "geom:ceiling",
    boundary: floorPolygon,
    surface_frame: {
      origin: { x: 0, y: 0, z: ceilingHeight },
      u_axis: { x: 1, y: 0, z: 0 },
      v_axis: { x: 0, y: 1, z: 0 },
      normal: { x: 0, y: 0, z: -1 },
    },
    named_wall_ref_id: null,
    material_state: defaultMaterial(),
    user_locked: false,
    provenance: defaultProvenance(now),
  };

  const northWall: Surface = {
    surface_id: "surf:wall:north",
    type: "wall",
    geometry_ref: "geom:wall:north",
    boundary: rect(-2, 1.5, 2, ceilingHeight), // u=x, v=z for wall
    surface_frame: {
      origin: { x: 0, y: 1.5, z: 0 },
      u_axis: { x: 1, y: 0, z: 0 },
      v_axis: { x: 0, y: 0, z: 1 },
      normal: { x: 0, y: -1, z: 0 },
    },
    named_wall_ref_id: "wall:north",
    material_state: defaultMaterial(),
    user_locked: options.north_wall_locked ?? false,
    provenance: defaultProvenance(now),
  };

  const southWall: Surface = {
    surface_id: "surf:wall:south",
    type: "wall",
    geometry_ref: "geom:wall:south",
    boundary: rect(-2, -1.5, 2, ceilingHeight),
    surface_frame: {
      origin: { x: 0, y: -1.5, z: 0 },
      u_axis: { x: 1, y: 0, z: 0 },
      v_axis: { x: 0, y: 0, z: 1 },
      normal: { x: 0, y: 1, z: 0 },
    },
    named_wall_ref_id: "wall:south",
    material_state: defaultMaterial(),
    user_locked: false,
    provenance: defaultProvenance(now),
  };

  const eastWall: Surface = {
    surface_id: "surf:wall:east",
    type: "wall",
    geometry_ref: "geom:wall:east",
    boundary: rect(-1.5, 0, 1.5, ceilingHeight),
    surface_frame: {
      origin: { x: 2, y: 0, z: 0 },
      u_axis: { x: 0, y: 1, z: 0 },
      v_axis: { x: 0, y: 0, z: 1 },
      normal: { x: -1, y: 0, z: 0 },
    },
    named_wall_ref_id: "wall:east",
    material_state: defaultMaterial(),
    user_locked: false,
    provenance: defaultProvenance(now),
  };

  const westWall: Surface = {
    surface_id: "surf:wall:west",
    type: "wall",
    geometry_ref: "geom:wall:west",
    boundary: rect(-1.5, 0, 1.5, ceilingHeight),
    surface_frame: {
      origin: { x: -2, y: 0, z: 0 },
      u_axis: { x: 0, y: 1, z: 0 },
      v_axis: { x: 0, y: 0, z: 1 },
      normal: { x: 1, y: 0, z: 0 },
    },
    named_wall_ref_id: "wall:west",
    material_state: defaultMaterial(),
    user_locked: false,
    provenance: defaultProvenance(now),
  };

  const namedWallRefs: NamedWallRef[] = [
    { wall_ref_id: "wall:north", name: "north wall", surface_ids: [northWall.surface_id], azimuth_degrees: 0, inward_normal_xy: { x: 0, y: -1 } },
    { wall_ref_id: "wall:south", name: "south wall", surface_ids: [southWall.surface_id], azimuth_degrees: 180, inward_normal_xy: { x: 0, y: 1 } },
    { wall_ref_id: "wall:east", name: "east wall", surface_ids: [eastWall.surface_id], azimuth_degrees: 90, inward_normal_xy: { x: -1, y: 0 } },
    { wall_ref_id: "wall:west", name: "west wall", surface_ids: [westWall.surface_id], azimuth_degrees: 270, inward_normal_xy: { x: 1, y: 0 } },
  ];

  const objects: SceneObject[] = (options.objects ?? []).map((override) => ({
    object_id: override.object_id,
    class: override.class,
    attributes: [],
    parent_id: override.parent_id ?? null,
    child_movement_policy: override.child_movement_policy ?? "independent",
    pose: override.pose ?? { position: { x: 0, y: 0, z: 0 }, yaw_degrees: 0 },
    obb:
      override.obb ?? {
        center: { x: override.pose?.position.x ?? 0, y: override.pose?.position.y ?? 0, z: 0.4 },
        size_x: 1,
        size_y: 1,
        size_z: 1,
        yaw_degrees: override.pose?.yaw_degrees ?? 0,
      },
    mobility: override.host ? "anchored" : "movable",
    host: override.host ?? null,
    support:
      override.support ?? {
        support_kind: "floor",
        support_entity_id: floorSurface.surface_id,
        contact_patch: null,
      },
    asset_ref: override.asset_ref === undefined ? `asset-${override.class}-default` : override.asset_ref,
    style_tags: override.style_tags ?? [],
    material_state: override.material_state ?? null,
    user_locked: override.user_locked ?? false,
    provenance: defaultProvenance(now),
  }));

  const scene: Scene = {
    head: {
      scene_id: sceneId,
      source: "scanned",
      units: "m",
      current_snapshot_id: snapshotId,
      current_scene_version: 1,
      undo_base_snapshot_id: null,
      updated_at: now,
      ...options.head_override,
    },
    snapshot: {
      snapshot_id: snapshotId,
      scene_id: sceneId,
      scene_version: 1,
      based_on_snapshot_id: null,
      mutation_kind: "initial_ingest",
      state: {
        style_tags: [],
        room: {
          room_id: "room:test",
          room_type: "bedroom",
          coordinate_frame: {
            origin: { x: 0, y: 0, z: 0 },
            x_axis: { x: 1, y: 0, z: 0 },
            y_axis: { x: 0, y: 1, z: 0 },
            z_axis: { x: 0, y: 0, z: 1 },
            north_source: "true_north",
          },
          shell: {
            floor_polygon: floorPolygon,
            ceiling_height: ceilingHeight,
            surfaces: [floorSurface, ceilingSurface, northWall, southWall, eastWall, westWall],
            named_wall_refs: namedWallRefs,
            openings: options.openings ?? [],
            fixed_elements: options.fixed_elements ?? [],
          },
          objects,
          constraints: [],
          focal_elements: [],
          section_hints: [],
        },
      },
      editing_asset_refs: options.editing_asset_refs ?? [],
      created_at: now,
      ...options.snapshot_override,
    },
    derived_state_cache: null,
    bookmarks: [],
    photoreal_gallery: [],
    splat: null,
  };

  return scene;
}

/**
 * Well-known editable class list for iteration in property tests. Kept local
 * so tests do not depend on a specific runtime re-export.
 */
export const EDITABLE_CLASSES: EditableObjectClass[] = [
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
];
