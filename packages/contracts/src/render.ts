import type { AssetId, EntityId, OBB3D, Pose3D } from "./primitives";
import type { AssetKind, EditableObjectClass, MaterialState, ObjectClass, Scene, SurfaceType } from "./scene";

export type CuratedAssetTargetClass = EditableObjectClass | "generic_obstacle" | "fixed_element";

export interface CuratedAssetManifestEntry {
  asset_id: AssetId;
  kind: AssetKind;
  uri: string;
  object_class: CuratedAssetTargetClass;
  style_tags: string[];
  material_state: MaterialState | null;
  preferred_size_xy: { x: number; y: number } | null;
  max_relative_error: number | null;
}

export interface CuratedAssetManifest {
  manifest_version: string;
  assets: CuratedAssetManifestEntry[];
}

export interface QuickRenderAssetBinding {
  bound_to: EntityId;
  requested_asset_id: AssetId | null;
  resolved_asset_id: AssetId;
  resolved_kind: AssetKind;
  uri: string;
  used_fallback: boolean;
  fallback_reason: "requested_asset_missing" | "missing_asset_ref" | null;
}

export interface QuickRenderObject {
  object_id: EntityId;
  class: ObjectClass;
  pose: Pose3D;
  obb: OBB3D;
  requested_asset_id: AssetId | null;
  resolved_asset_id: AssetId;
  resolved_kind: AssetKind;
  uri: string;
  used_fallback: boolean;
  fallback_reason: QuickRenderAssetBinding["fallback_reason"];
  style_tags: string[];
  parent_id: EntityId | null;
  user_locked: boolean;
}

export interface QuickRenderFixedElement {
  fixed_element_id: EntityId;
  class: string;
  pose: Pose3D;
  obb: OBB3D;
  proxy_asset_id: AssetId;
  proxy_kind: AssetKind;
  uri: string;
}

export interface QuickRenderSurface {
  surface_id: EntityId;
  type: SurfaceType;
  geometry_ref: string;
  material_state: MaterialState;
  user_locked: boolean;
}

export interface QuickRenderDiagnostics {
  proxy_fallback_count: number;
  fallback_misses: Array<{
    bound_to: EntityId;
    requested_asset_id: AssetId | null;
    resolved_asset_id: AssetId;
    reason: Exclude<QuickRenderAssetBinding["fallback_reason"], null>;
  }>;
}

export interface QuickRenderScene {
  scene_id: string;
  scene_version: number;
  scene_snapshot_id: string;
  selection_context_summary: string;
  asset_bindings: QuickRenderAssetBinding[];
  surfaces: QuickRenderSurface[];
  objects: QuickRenderObject[];
  fixed_elements: QuickRenderFixedElement[];
  diagnostics: QuickRenderDiagnostics;
}

export const CURATED_ASSET_MANIFEST_VERSION = "2026-04-17";

const CURATED_ASSET_ENTRIES: CuratedAssetManifestEntry[] = [
  {
    asset_id: "asset-bed-queen-ash-01",
    kind: "gltf",
    uri: "asset://furniture/bed/queen-ash-01.glb",
    object_class: "bed",
    style_tags: ["modern", "light_wood"],
    material_state: {
      category: "fabric",
      color: "oatmeal",
      finish: "woven",
      pattern: null,
      reference_asset_id: null,
    },
    preferred_size_xy: { x: 2.0, y: 1.6 },
    max_relative_error: 0.3,
  },
  {
    asset_id: "asset-nightstand-oak-01",
    kind: "gltf",
    uri: "asset://furniture/nightstand/oak-01.glb",
    object_class: "nightstand",
    style_tags: ["modern", "light_wood"],
    material_state: {
      category: "wood",
      color: "oak",
      finish: "matte",
      pattern: null,
      reference_asset_id: null,
    },
    preferred_size_xy: { x: 0.5, y: 0.5 },
    max_relative_error: 0.35,
  },
  {
    asset_id: "asset-desk-compact-01",
    kind: "gltf",
    uri: "asset://furniture/desk/compact-01.glb",
    object_class: "desk",
    style_tags: ["modern", "workspace"],
    material_state: {
      category: "wood",
      color: "oak",
      finish: "matte",
      pattern: null,
      reference_asset_id: null,
    },
    preferred_size_xy: { x: 1.2, y: 0.6 },
    max_relative_error: 0.3,
  },
  {
    asset_id: "asset-desk-proxy-01",
    kind: "proxy_gltf",
    uri: "asset://proxies/desk/simple-rect.glb",
    object_class: "desk",
    style_tags: ["workspace", "proxy"],
    material_state: {
      category: "wood",
      color: "ash",
      finish: "matte",
      pattern: null,
      reference_asset_id: null,
    },
    preferred_size_xy: { x: 1.1, y: 0.6 },
    max_relative_error: 0.65,
  },
  {
    asset_id: "asset-chair-upholstered-01",
    kind: "gltf",
    uri: "asset://furniture/chair/upholstered-01.glb",
    object_class: "chair",
    style_tags: ["modern", "workspace"],
    material_state: {
      category: "fabric",
      color: "charcoal",
      finish: "woven",
      pattern: null,
      reference_asset_id: null,
    },
    preferred_size_xy: { x: 0.55, y: 0.55 },
    max_relative_error: 0.35,
  },
  {
    asset_id: "asset-table-round-01",
    kind: "gltf",
    uri: "asset://furniture/table/round-01.glb",
    object_class: "table",
    style_tags: ["modern", "light_wood"],
    material_state: {
      category: "wood",
      color: "oak",
      finish: "matte",
      pattern: null,
      reference_asset_id: null,
    },
    preferred_size_xy: { x: 1.1, y: 1.1 },
    max_relative_error: 0.4,
  },
  {
    asset_id: "asset-dresser-6drawer-01",
    kind: "gltf",
    uri: "asset://furniture/dresser/6drawer-01.glb",
    object_class: "dresser",
    style_tags: ["modern", "storage"],
    material_state: {
      category: "wood",
      color: "walnut",
      finish: "satin",
      pattern: null,
      reference_asset_id: null,
    },
    preferred_size_xy: { x: 1.2, y: 0.5 },
    max_relative_error: 0.35,
  },
  {
    asset_id: "asset-bookshelf-tall-01",
    kind: "gltf",
    uri: "asset://furniture/bookshelf/tall-01.glb",
    object_class: "bookshelf",
    style_tags: ["storage", "modern"],
    material_state: {
      category: "wood",
      color: "oak",
      finish: "matte",
      pattern: null,
      reference_asset_id: null,
    },
    preferred_size_xy: { x: 0.9, y: 0.35 },
    max_relative_error: 0.4,
  },
  {
    asset_id: "asset-sofa-compact-01",
    kind: "gltf",
    uri: "asset://furniture/sofa/compact-01.glb",
    object_class: "sofa",
    style_tags: ["modern", "neutral"],
    material_state: {
      category: "fabric",
      color: "taupe",
      finish: "woven",
      pattern: null,
      reference_asset_id: null,
    },
    preferred_size_xy: { x: 1.9, y: 0.9 },
    max_relative_error: 0.35,
  },
  {
    asset_id: "asset-rug-neutral-01",
    kind: "proxy_gltf",
    uri: "asset://proxies/rug/neutral-rectangle.glb",
    object_class: "rug",
    style_tags: ["warm", "earthy"],
    material_state: {
      category: "textile",
      color: "sand",
      finish: null,
      pattern: "flatweave",
      reference_asset_id: null,
    },
    preferred_size_xy: { x: 2.4, y: 1.6 },
    max_relative_error: 0.5,
  },
  {
    asset_id: "asset-lamp-ceramic-01",
    kind: "gltf",
    uri: "asset://decor/lamp/ceramic-01.glb",
    object_class: "lamp",
    style_tags: ["ambient", "neutral"],
    material_state: {
      category: "ceramic",
      color: "ivory",
      finish: "gloss",
      pattern: null,
      reference_asset_id: null,
    },
    preferred_size_xy: { x: 0.2, y: 0.2 },
    max_relative_error: 0.55,
  },
  {
    asset_id: "asset-television-wall-01",
    kind: "gltf",
    uri: "asset://electronics/television/wall-01.glb",
    object_class: "television",
    style_tags: ["media", "modern"],
    material_state: {
      category: "metal_glass",
      color: "black",
      finish: "satin",
      pattern: null,
      reference_asset_id: null,
    },
    preferred_size_xy: { x: 1.1, y: 0.1 },
    max_relative_error: 0.45,
  },
  {
    asset_id: "asset-storage-cabinet-01",
    kind: "gltf",
    uri: "asset://furniture/storage/cabinet-01.glb",
    object_class: "storage",
    style_tags: ["storage", "modern"],
    material_state: {
      category: "wood",
      color: "oak",
      finish: "matte",
      pattern: null,
      reference_asset_id: null,
    },
    preferred_size_xy: { x: 1.0, y: 0.45 },
    max_relative_error: 0.4,
  },
  {
    asset_id: "asset-proxy-obstacle-box-01",
    kind: "proxy_gltf",
    uri: "asset://proxies/obstacle/box-01.glb",
    object_class: "generic_obstacle",
    style_tags: ["proxy", "obstacle"],
    material_state: null,
    preferred_size_xy: null,
    max_relative_error: null,
  },
  {
    asset_id: "asset-proxy-fixed-element-box-01",
    kind: "proxy_gltf",
    uri: "asset://proxies/fixed-element/box-01.glb",
    object_class: "fixed_element",
    style_tags: ["proxy", "fixed_element"],
    material_state: null,
    preferred_size_xy: null,
    max_relative_error: null,
  },
];

export const CURATED_ASSET_MANIFEST: CuratedAssetManifest = {
  manifest_version: CURATED_ASSET_MANIFEST_VERSION,
  assets: CURATED_ASSET_ENTRIES,
};

interface CuratedAssetManifestIndex {
  byAssetId: Map<AssetId, CuratedAssetManifestEntry>;
  byObjectClass: Map<CuratedAssetTargetClass, CuratedAssetManifestEntry[]>;
}

export function createCuratedAssetManifestIndex(
  manifest: CuratedAssetManifest = CURATED_ASSET_MANIFEST
): CuratedAssetManifestIndex {
  const byAssetId = new Map<AssetId, CuratedAssetManifestEntry>();
  const byObjectClass = new Map<CuratedAssetTargetClass, CuratedAssetManifestEntry[]>();

  for (const asset of manifest.assets) {
    byAssetId.set(asset.asset_id, asset);
    const existing = byObjectClass.get(asset.object_class) ?? [];
    existing.push(asset);
    existing.sort((left, right) => left.asset_id.localeCompare(right.asset_id));
    byObjectClass.set(asset.object_class, existing);
  }

  return { byAssetId, byObjectClass };
}

export function selectCuratedAssetForFootprint(
  objectClass: EditableObjectClass,
  obb: OBB3D,
  manifest: CuratedAssetManifest = CURATED_ASSET_MANIFEST
): CuratedAssetManifestEntry {
  const index = createCuratedAssetManifestIndex(manifest);
  const library = index.byObjectClass.get(objectClass) ?? [];
  const footprint = normalizeFootprintDimensions(obb.size_x, obb.size_y);
  let best: CuratedAssetManifestEntry | null = null;
  let bestError = Number.POSITIVE_INFINITY;
  for (const candidate of library) {
    if (!candidate.preferred_size_xy || candidate.max_relative_error === null) {
      continue;
    }
    const candidateFootprint = normalizeFootprintDimensions(candidate.preferred_size_xy.x, candidate.preferred_size_xy.y);
    const error = relativeDimensionError(footprint.x, candidateFootprint.x) + relativeDimensionError(footprint.y, candidateFootprint.y);
    if (error <= candidate.max_relative_error * 2 && error < bestError) {
      best = candidate;
      bestError = error;
    }
  }
  return best ?? library[library.length - 1];
}

export function buildDeterministicQuickRender(
  scene: Scene,
  manifest: CuratedAssetManifest = CURATED_ASSET_MANIFEST
): QuickRenderScene {
  const manifestIndex = createCuratedAssetManifestIndex(manifest);
  const room = scene.snapshot.state.room;
  const editingAssetRefByEntityId = new Map(
    scene.snapshot.editing_asset_refs.map((assetRef) => [assetRef.bound_to, assetRef.asset_id])
  );

  const assetBindings: QuickRenderAssetBinding[] = [];
  const objects: QuickRenderObject[] = [];
  const fallbackMisses: QuickRenderDiagnostics["fallback_misses"] = [];

  for (const object of [...room.objects].sort((left, right) => left.object_id.localeCompare(right.object_id))) {
    const requested_asset_id = object.asset_ref ?? editingAssetRefByEntityId.get(object.object_id) ?? null;
    const resolution = resolveAssetForObject(object.class, requested_asset_id, manifestIndex);
    const binding: QuickRenderAssetBinding = {
      bound_to: object.object_id,
      requested_asset_id,
      resolved_asset_id: resolution.asset.asset_id,
      resolved_kind: resolution.asset.kind,
      uri: resolution.asset.uri,
      used_fallback: resolution.fallback_reason !== null,
      fallback_reason: resolution.fallback_reason,
    };
    assetBindings.push(binding);
    if (binding.fallback_reason) {
      fallbackMisses.push({
        bound_to: binding.bound_to,
        requested_asset_id: binding.requested_asset_id,
        resolved_asset_id: binding.resolved_asset_id,
        reason: binding.fallback_reason,
      });
    }
    objects.push({
      object_id: object.object_id,
      class: object.class,
      pose: object.pose,
      obb: object.obb,
      requested_asset_id,
      resolved_asset_id: resolution.asset.asset_id,
      resolved_kind: resolution.asset.kind,
      uri: resolution.asset.uri,
      used_fallback: resolution.fallback_reason !== null,
      fallback_reason: resolution.fallback_reason,
      style_tags: resolution.asset.style_tags,
      parent_id: object.parent_id,
      user_locked: object.user_locked,
    });
  }

  const surfaces: QuickRenderSurface[] = [...room.shell.surfaces]
    .sort((left, right) => left.surface_id.localeCompare(right.surface_id))
    .map((surface) => ({
      surface_id: surface.surface_id,
      type: surface.type,
      geometry_ref: surface.geometry_ref,
      material_state: surface.material_state,
      user_locked: surface.user_locked,
    }));

  const fixedProxy = manifestIndex.byAssetId.get("asset-proxy-fixed-element-box-01");
  if (!fixedProxy) {
    throw new Error("Curated asset manifest is missing the fixed element proxy asset.");
  }

  const fixed_elements: QuickRenderFixedElement[] = [...room.shell.fixed_elements]
    .sort((left, right) => left.fixed_element_id.localeCompare(right.fixed_element_id))
    .map((element) => ({
      fixed_element_id: element.fixed_element_id,
      class: element.class,
      pose: element.pose,
      obb: element.obb,
      proxy_asset_id: fixedProxy.asset_id,
      proxy_kind: fixedProxy.kind,
      uri: fixedProxy.uri,
    }));

  return {
    scene_id: scene.head.scene_id,
    scene_version: scene.head.current_scene_version,
    scene_snapshot_id: scene.snapshot.snapshot_id,
    selection_context_summary: scene.derived_state_cache?.selection_context_summary ?? "",
    asset_bindings: assetBindings,
    surfaces,
    objects,
    fixed_elements,
    diagnostics: {
      proxy_fallback_count: fallbackMisses.length,
      fallback_misses: fallbackMisses,
    },
  };
}

function resolveAssetForObject(
  objectClass: ObjectClass,
  requestedAssetId: AssetId | null,
  manifestIndex: CuratedAssetManifestIndex
): { asset: CuratedAssetManifestEntry; fallback_reason: QuickRenderAssetBinding["fallback_reason"] } {
  if (requestedAssetId) {
    const exact = manifestIndex.byAssetId.get(requestedAssetId);
    if (exact) {
      return { asset: exact, fallback_reason: null };
    }
  }

  const fallbackReason: QuickRenderAssetBinding["fallback_reason"] = requestedAssetId
    ? "requested_asset_missing"
    : "missing_asset_ref";
  const proxy = selectProxyAsset(objectClass, manifestIndex);
  return { asset: proxy, fallback_reason: fallbackReason };
}

function selectProxyAsset(
  objectClass: ObjectClass,
  manifestIndex: CuratedAssetManifestIndex
): CuratedAssetManifestEntry {
  const classMatches = manifestIndex.byObjectClass.get(objectClass as CuratedAssetTargetClass) ?? [];
  const classProxy = classMatches.find((entry) => entry.kind === "proxy_gltf");
  if (classProxy) {
    return classProxy;
  }

  const obstacleProxy = manifestIndex.byObjectClass.get("generic_obstacle")?.find((entry) => entry.kind === "proxy_gltf");
  if (obstacleProxy) {
    return obstacleProxy;
  }

  throw new Error(`Curated asset manifest does not contain a proxy fallback for ${objectClass}.`);
}

function relativeDimensionError(actual: number, expected: number): number {
  return Math.abs(actual - expected) / Math.max(expected, 0.01);
}

function normalizeFootprintDimensions(x: number, y: number): { x: number; y: number } {
  return x >= y ? { x, y } : { x: y, y: x };
}
