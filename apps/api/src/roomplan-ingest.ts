import { createHash, randomBytes } from "node:crypto";

import type {
  ApplyPlanRequest,
  AssetRef,
  CameraBookmark,
  ConstraintSpec,
  DerivedState,
  EditableObjectClass,
  FixedElement,
  HandoffGrantRecord,
  HandoffRedeemRequest,
  HandoffRedeemResponse,
  IdempotencyRecord,
  JobRecord,
  MaterialState,
  NamedWallRef,
  ObjectClass,
  Opening,
  OperationPlanPreview,
  Point2D,
  Point3D,
  Polygon2D,
  Pose3D,
  ReasonCode,
  RectOnSurface,
  Room,
  RoomPlanCaptureRequest,
  RoomPlanCaptureResponse,
  RoomPlanFixedElementSeed,
  RoomPlanObjectSeed,
  RoomPlanOpeningSeed,
  RoomPlanPayload,
  RoomPlanSurfaceSeed,
  Scene,
  SceneApplyResponse,
  SceneObject,
  ScenePreviewRequest,
  ScenePreviewResponse,
  SceneSnapshot,
  SupportRelation,
  Surface,
  SurfaceFrame,
  SplatAssetRecord,
  SupplementaryDetection,
  UndoLastChangeRequest,
  VideoUploadTokenRecord,
  VideoUploadRequest,
  VideoUploadResponse,
} from "@roomview/contracts";

import {
  decomposeIngestedCaptureForStorage,
  hydrateSceneFromStoredRecords,
} from "./roomplan-persistence";
import type {
  PersistedDerivedStateCacheRecord,
  PersistedInitialSceneRecords,
} from "./roomplan-persistence";
import {
  createCanonicalPlanHash,
  createPreviewResponse,
  SceneMutationError,
  simulateScenePreview,
} from "./mutation-engine";
import {
  FileSystemRoomPlanCaptureRecordStore,
} from "./roomplan-store";
import type {
  PersistedPreviewRecord,
  PersistedRoomPlanCaptureRecord,
  PersistedStoredIdempotencyRecord,
} from "./roomplan-store";

const EDITABLE_OBJECT_CLASSES = new Set<EditableObjectClass>([
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

const WALL_NAME_TO_AZIMUTH: Record<string, number> = {
  "north wall": 0,
  "east wall": 90,
  "south wall": 180,
  "west wall": 270,
};

const DEFAULT_HANDOFF_TTL_MS = 1000 * 60 * 15;
const DEFAULT_VIDEO_UPLOAD_TTL_MS = 1000 * 60 * 10;
const DEFAULT_SESSION_TTL_MS = 1000 * 60 * 60 * 8;
const DEFAULT_CLEARANCE_WIDTH_M = 0.76;

interface AssetTemplate {
  asset_id: string;
  kind: "gltf" | "proxy_gltf";
  uri: string;
  style_tags: string[];
  material_state: MaterialState | null;
  preferred_size_xy: { x: number; y: number };
  max_relative_error: number;
}

const DEFAULT_FLOOR_MATERIAL: MaterialState = {
  category: "flooring",
  color: "oak",
  finish: "matte",
  pattern: "plank",
  reference_asset_id: "asset-floor-oak-01",
};

const DEFAULT_WALL_MATERIAL: MaterialState = {
  category: "paint",
  color: "warm_white",
  finish: "eggshell",
  pattern: null,
  reference_asset_id: null,
};

const DEFAULT_CEILING_MATERIAL: MaterialState = {
  category: "paint",
  color: "soft_white",
  finish: "flat",
  pattern: null,
  reference_asset_id: null,
};

const ASSET_LIBRARY: Record<EditableObjectClass, AssetTemplate[]> = {
  bed: [
    {
      asset_id: "asset-bed-queen-ash-01",
      kind: "gltf",
      uri: "asset://furniture/bed/queen-ash-01.glb",
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
  ],
  nightstand: [
    {
      asset_id: "asset-nightstand-oak-01",
      kind: "gltf",
      uri: "asset://furniture/nightstand/oak-01.glb",
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
  ],
  desk: [
    {
      asset_id: "asset-desk-compact-01",
      kind: "gltf",
      uri: "asset://furniture/desk/compact-01.glb",
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
  ],
  chair: [
    {
      asset_id: "asset-chair-upholstered-01",
      kind: "gltf",
      uri: "asset://furniture/chair/upholstered-01.glb",
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
  ],
  table: [
    {
      asset_id: "asset-table-round-01",
      kind: "gltf",
      uri: "asset://furniture/table/round-01.glb",
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
  ],
  dresser: [
    {
      asset_id: "asset-dresser-6drawer-01",
      kind: "gltf",
      uri: "asset://furniture/dresser/6drawer-01.glb",
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
  ],
  bookshelf: [
    {
      asset_id: "asset-bookshelf-tall-01",
      kind: "gltf",
      uri: "asset://furniture/bookshelf/tall-01.glb",
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
  ],
  sofa: [
    {
      asset_id: "asset-sofa-compact-01",
      kind: "gltf",
      uri: "asset://furniture/sofa/compact-01.glb",
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
  ],
  rug: [
    {
      asset_id: "asset-rug-neutral-01",
      kind: "proxy_gltf",
      uri: "asset://proxies/rug/neutral-rectangle.glb",
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
  ],
  lamp: [
    {
      asset_id: "asset-lamp-ceramic-01",
      kind: "gltf",
      uri: "asset://decor/lamp/ceramic-01.glb",
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
  ],
  television: [
    {
      asset_id: "asset-television-wall-01",
      kind: "gltf",
      uri: "asset://electronics/television/wall-01.glb",
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
  ],
  storage: [
    {
      asset_id: "asset-storage-cabinet-01",
      kind: "gltf",
      uri: "asset://furniture/storage/cabinet-01.glb",
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
  ],
};

export interface RoomPlanCaptureSceneArtifacts {
  scene: Scene;
  scene_id: string;
  scene_snapshot_id: string;
}

export interface IngestedCaptureArtifacts extends RoomPlanCaptureSceneArtifacts {
  response: RoomPlanCaptureResponse;
  handoff_grant: HandoffGrantRecord;
  video_upload_token_record: VideoUploadTokenRecord | null;
}

export interface BuildInitialSceneOptions {
  now?: string;
  scene_id?: string;
  snapshot_id?: string;
}

export interface RoomPlanCaptureServiceOptions {
  handoff_base_url?: string;
  handoff_ttl_ms?: number;
  session_ttl_ms?: number;
  video_upload_ttl_ms?: number;
  now?: () => Date;
  token_secret?: string;
  storage_directory?: string;
}

interface StoredSceneRecord {
  request_fingerprint: string;
  request_id: string;
  client_capture_id: string;
  scene: Scene;
  persisted_records: PersistedInitialSceneRecords;
  snapshots: Map<string, SceneSnapshot>;
  derived_state_caches: Map<string, PersistedDerivedStateCacheRecord>;
  preview_records: Map<string, PersistedPreviewRecord>;
  idempotency_records: Map<string, PersistedStoredIdempotencyRecord>;
  handoff_grant: HandoffGrantRecord;
  handoff_token: string;
  video_upload_token_record: VideoUploadTokenRecord | null;
  video_upload_token: string | null;
}

interface ObjectBuildInput {
  id: string;
  category: string;
  pose: Pose3D;
  obb: RoomPlanObjectSeed["obb"];
  attributes: string[];
  source_ref: string;
  source_kind: "measured" | "generated";
  confidence: number;
  supplementary: boolean;
}

interface ObjectDraft {
  original_id: string;
  category: string;
  object: SceneObject;
  support_source: "floor" | "wall" | "object";
  host_distance_m: number | null;
  footprint: Polygon2D;
}

export class RoomPlanCaptureError extends Error {
  public readonly reason_code: ReasonCode;

  public constructor(reason_code: ReasonCode, message: string) {
    super(message);
    this.name = "RoomPlanCaptureError";
    this.reason_code = reason_code;
  }
}

export function buildInitialSceneFromRoomPlanCapture(
  request: RoomPlanCaptureRequest,
  options: BuildInitialSceneOptions = {}
): RoomPlanCaptureSceneArtifacts {
  validateRoomPlanCaptureRequest(request);

  const now = options.now ?? request.capture_metadata.captured_at;
  const sceneSeed = options.scene_id ?? makeStableId("scene", request.client_capture_id);
  const snapshotId = options.snapshot_id ?? makeStableId("snapshot", `${sceneSeed}:v1`);
  const roomId = makeStableId("room", request.client_capture_id);
  const payload = request.roomplan_payload;

  const surfaces = payload.surfaces.map((surfaceSeed) => ({
    seed: surfaceSeed,
    surface_id: makeStableId("surface", `${sceneSeed}:surface:${surfaceSeed.id}`),
  }));
  const surfaceIdBySeedId = new Map(surfaces.map((entry) => [entry.seed.id, entry.surface_id]));
  const wallNameBySurfaceId = createNamedWallMap(surfaces.map((entry) => entry.seed), sceneSeed);
  const namedWallRefs = Array.from(groupNamedWallRefs(wallNameBySurfaceId, surfaces.map((entry) => entry.seed), surfaceIdBySeedId, sceneSeed).values());
  const namedWallRefIdBySurfaceId = new Map<string, string>();
  for (const ref of namedWallRefs) {
    for (const surfaceId of ref.surface_ids) {
      namedWallRefIdBySurfaceId.set(surfaceId, ref.wall_ref_id);
    }
  }

  const canonicalSurfaces: Surface[] = surfaces.map(({ seed, surface_id }) => ({
    surface_id,
    type: seed.category,
    geometry_ref: seed.id,
    boundary: clonePolygon(seed.polygon),
    surface_frame: seed.frame ? cloneSurfaceFrame(seed.frame) : null,
    named_wall_ref_id: namedWallRefIdBySurfaceId.get(surface_id) ?? null,
    material_state: defaultMaterialForSurface(seed.category),
    user_locked: false,
    provenance: {
      source_kind: "measured",
      confidence: seed.category === "floor" ? 0.99 : 0.98,
      source_ref: `roomplan:${seed.id}`,
      updated_at: now,
    },
  }));

  const floorSurface = canonicalSurfaces.find((surface) => surface.type === "floor");
  if (!floorSurface) {
    throw new RoomPlanCaptureError("INVALID_CAPTURE", "A single floor surface is required for ingest.");
  }

  const wallSurfaces = canonicalSurfaces.filter((surface) => surface.type === "wall");
  const surfaceById = new Map(canonicalSurfaces.map((surface) => [surface.surface_id, surface]));

  const fixedElements = (payload.fixed_elements ?? []).map((seed) =>
    mapFixedElement(seed, {
      now,
      sceneSeed,
      floorSurfaceId: floorSurface.surface_id,
      hostSurfaceId: seed.host_surface_id ? surfaceIdBySeedId.get(seed.host_surface_id) ?? null : null,
    })
  );

  const canonicalOpenings = payload.openings.map((openingSeed) =>
    mapOpening(openingSeed, {
      now,
      sceneSeed,
      hostSurfaceId: mustGet(surfaceIdBySeedId, openingSeed.host_surface_id, "INVALID_CAPTURE", `Missing host surface for opening ${openingSeed.id}`),
      hostSurface: mustGet(
        surfaceById,
        mustGet(surfaceIdBySeedId, openingSeed.host_surface_id, "INVALID_CAPTURE", `Missing host surface for opening ${openingSeed.id}`),
        "INVALID_CAPTURE",
        `Missing canonical host surface for opening ${openingSeed.id}`
      ),
    })
  );

  const objectInputs: ObjectBuildInput[] = [
    ...payload.objects.map((objectSeed) => ({
      id: objectSeed.id,
      category: objectSeed.category,
      pose: clonePose(objectSeed.pose),
      obb: cloneObb(objectSeed.obb),
      attributes: [...objectSeed.attributes],
      source_ref: `roomplan:${objectSeed.id}`,
      source_kind: "measured" as const,
      confidence: 0.9,
      supplementary: false,
    })),
    ...(request.supplementary_detections ?? []).map((detection) => ({
      id: detection.detection_id,
      category: detection.label,
      pose: {
        position: {
          x: roundNumber(detection.obb.center.x),
          y: roundNumber(detection.obb.center.y),
          z: 0,
        },
        yaw_degrees: detection.obb.yaw_degrees,
      },
      obb: cloneObb(detection.obb),
      attributes: [normalizeCategory(detection.label), "supplementary_detection"],
      source_ref: `supplementary:${detection.detection_id}`,
      source_kind: "generated" as const,
      confidence: clamp01(detection.confidence),
      supplementary: true,
    })),
  ];

  const openingById = new Map(canonicalOpenings.map((opening) => [opening.opening_id, opening]));
  const objectDrafts = objectInputs.map((input) =>
    createObjectDraft(input, {
      now,
      sceneSeed,
      floorSurfaceId: floorSurface.surface_id,
      wallSurfaces,
      roomWidth: payload.dimensions.width_m,
      roomLength: payload.dimensions.length_m,
      ceilingHeight: payload.dimensions.ceiling_height_m,
    })
  );

  resolveObjectParentSupport(objectDrafts);

  const editingAssetRefs: AssetRef[] = [];
  for (const draft of objectDrafts) {
    const editableClass = draft.object.class === "generic_obstacle" ? null : draft.object.class;
    if (!editableClass) {
      continue;
    }
    const asset = selectInitialAsset(editableClass, draft.object.obb);
    draft.object.asset_ref = asset.asset_id;
    draft.object.style_tags = [...asset.style_tags];
    draft.object.material_state = asset.material_state ? cloneMaterialState(asset.material_state) : null;
    editingAssetRefs.push({
      asset_id: asset.asset_id,
      kind: asset.kind,
      uri: asset.uri,
      bound_to: draft.object.object_id,
    });
  }

  const roomObjects = objectDrafts.map((draft) => draft.object);
  const focalElements = deriveFocalElements(canonicalOpenings, roomObjects);
  const constraints = deriveConstraintSpecs(canonicalOpenings, roomObjects, fixedElements, focalElements, sceneSeed);
  const sectionHints = deriveSectionHints(roomObjects);
  const sceneStyleTags = deriveSceneStyleTags(roomObjects);

  const room: Room = {
    room_id: roomId,
    room_type: "bedroom",
    coordinate_frame: {
      origin: clonePoint3D(payload.coordinate_frame.origin),
      x_axis: cloneVector3D(payload.coordinate_frame.x_axis),
      y_axis: cloneVector3D(payload.coordinate_frame.y_axis),
      z_axis: cloneVector3D(payload.coordinate_frame.z_axis),
      north_source: payload.coordinate_frame.north_source,
    },
    shell: {
      floor_polygon: clonePolygon(floorSurface.boundary),
      ceiling_height: roundNumber(payload.dimensions.ceiling_height_m),
      surfaces: canonicalSurfaces,
      named_wall_refs: namedWallRefs,
      openings: canonicalOpenings,
      fixed_elements: fixedElements,
    },
    objects: roomObjects,
    constraints,
    focal_elements: focalElements,
    section_hints: sectionHints,
  };

  const scene: Scene = {
    head: {
      scene_id: sceneSeed,
      source: "scanned",
      units: "m",
      current_snapshot_id: snapshotId,
      current_scene_version: 1,
      undo_base_snapshot_id: null,
      updated_at: now,
    },
    snapshot: {
      snapshot_id: snapshotId,
      scene_id: sceneSeed,
      scene_version: 1,
      based_on_snapshot_id: null,
      mutation_kind: "initial_ingest",
      state: {
        style_tags: sceneStyleTags,
        room,
      },
      editing_asset_refs: editingAssetRefs,
      created_at: now,
    },
    derived_state_cache: deriveInitialStateCache(room, canonicalOpenings, roomObjects, fixedElements),
    bookmarks: createDefaultBookmarks(sceneSeed, room, openingById, now),
    photoreal_gallery: [],
    splat: request.capture_metadata.video_expected
      ? {
          scene_id: sceneSeed,
          source_scene_version: 1,
          status: "queued",
          asset_id: null,
          uri: null,
          updated_at: now,
        }
      : null,
  };

  return {
    scene,
    scene_id: sceneSeed,
    scene_snapshot_id: snapshotId,
  };
}

export function ingestRoomPlanCaptureRequest(
  request: RoomPlanCaptureRequest,
  options: BuildInitialSceneOptions & {
    handoff_base_url?: string;
    handoff_ttl_ms?: number;
    video_upload_ttl_ms?: number;
    token_secret?: string;
  } = {}
): IngestedCaptureArtifacts {
  const { scene, scene_id, scene_snapshot_id } = buildInitialSceneFromRoomPlanCapture(request, options);
  const now = options.now ?? request.capture_metadata.captured_at;
  const handoff = issueHandoffGrant(scene_id, now, {
    handoff_base_url: options.handoff_base_url,
    handoff_ttl_ms: options.handoff_ttl_ms,
    token_secret: options.token_secret,
  });
  const video = request.capture_metadata.video_expected
    ? issueVideoUploadToken(scene_id, now, {
        video_upload_ttl_ms: options.video_upload_ttl_ms,
        token_secret: options.token_secret,
      })
    : null;

  return {
    scene,
    scene_id,
    scene_snapshot_id,
    handoff_grant: handoff.record,
    video_upload_token_record: video?.record ?? null,
    response: {
      scene_id,
      scene_version: 1,
      scene_snapshot_id,
      handoff_url: handoff.url,
      qr_payload: handoff.record.qr_payload,
      expires_at: handoff.record.expires_at,
      video_upload_token: video?.token ?? null,
    },
  };
}

export class RoomPlanCaptureService {
  private readonly handoffBaseUrl: string;
  private readonly handoffTtlMs: number;
  private readonly sessionTtlMs: number;
  private readonly videoUploadTtlMs: number;
  private readonly nowFactory: () => Date;
  private readonly tokenSecret: string;
  private readonly durableStore: FileSystemRoomPlanCaptureRecordStore | null;

  private readonly scenesById = new Map<string, StoredSceneRecord>();
  private readonly sceneIdByClientCaptureId = new Map<string, string>();
  private readonly handoffTokenHashToSceneId = new Map<string, string>();
  private readonly videoTokenHashToSceneId = new Map<string, string>();
  private readonly jobsById = new Map<string, JobRecord>();

  public constructor(options: RoomPlanCaptureServiceOptions = {}) {
    this.handoffBaseUrl = options.handoff_base_url ?? "https://roomview.local/h";
    this.handoffTtlMs = options.handoff_ttl_ms ?? DEFAULT_HANDOFF_TTL_MS;
    this.sessionTtlMs = options.session_ttl_ms ?? DEFAULT_SESSION_TTL_MS;
    this.videoUploadTtlMs = options.video_upload_ttl_ms ?? DEFAULT_VIDEO_UPLOAD_TTL_MS;
    this.nowFactory = options.now ?? (() => new Date());
    this.tokenSecret = options.token_secret ?? randomBytes(32).toString("hex");
    this.durableStore = options.storage_directory
      ? new FileSystemRoomPlanCaptureRecordStore(options.storage_directory)
      : null;

    for (const record of this.durableStore?.loadAll() ?? []) {
      this.hydrateStoredScene(record);
    }
  }

  public postRoomPlanCapture(request: RoomPlanCaptureRequest): RoomPlanCaptureResponse {
    const existingSceneId = this.sceneIdByClientCaptureId.get(request.client_capture_id);
    const requestFingerprint = createRequestFingerprint(request);

    if (existingSceneId) {
      const existing = this.scenesById.get(existingSceneId);
      if (!existing) {
        throw new RoomPlanCaptureError("INVALID_CAPTURE", "Capture index is inconsistent with stored scenes.");
      }
      if (existing.request_fingerprint !== requestFingerprint) {
        throw new RoomPlanCaptureError(
          "INVALID_CAPTURE",
          `client_capture_id ${request.client_capture_id} has already been ingested with a different payload.`
        );
      }
      this.refreshAccessArtifacts(existing, request.capture_metadata.video_expected);
      this.persistStoredScene(existing);
      return this.toCaptureResponse(existing);
    }

    const now = this.nowIso();
    const ingested = ingestRoomPlanCaptureRequest(request, {
      now,
      handoff_base_url: this.handoffBaseUrl,
      handoff_ttl_ms: this.handoffTtlMs,
      video_upload_ttl_ms: this.videoUploadTtlMs,
      token_secret: this.tokenSecret,
    });

    const handoffToken = extractTokenFromQrPayload(ingested.handoff_grant.qr_payload);
    const videoToken = ingested.response.video_upload_token;
    const persistedRecords = decomposeIngestedCaptureForStorage(ingested);
    const stored: StoredSceneRecord = {
      request_fingerprint: requestFingerprint,
      request_id: request.request_id,
      client_capture_id: request.client_capture_id,
      scene: ingested.scene,
      persisted_records: persistedRecords,
      snapshots: new Map([[persistedRecords.scene_snapshot.snapshot_id, structuredClone(persistedRecords.scene_snapshot)]]),
      derived_state_caches: new Map(
        persistedRecords.derived_state_cache
          ? [[persistedRecords.derived_state_cache.snapshot_id, structuredClone(persistedRecords.derived_state_cache)]]
          : []
      ),
      preview_records: new Map(),
      idempotency_records: new Map(),
      handoff_grant: persistedRecords.handoff_grant,
      handoff_token: handoffToken,
      video_upload_token_record: persistedRecords.video_upload_token_record,
      video_upload_token: videoToken,
    };

    this.scenesById.set(ingested.scene_id, stored);
    this.sceneIdByClientCaptureId.set(request.client_capture_id, ingested.scene_id);
    this.handoffTokenHashToSceneId.set(ingested.handoff_grant.token_hash, ingested.scene_id);
    if (stored.video_upload_token_record) {
      this.videoTokenHashToSceneId.set(stored.video_upload_token_record.token_hash, ingested.scene_id);
    }
    this.persistStoredScene(stored);

    return ingested.response;
  }

  public getScene(scene_id: string): Scene | null {
    return this.scenesById.get(scene_id)?.scene ?? null;
  }

  public getPersistedInitialSceneRecords(scene_id: string): PersistedInitialSceneRecords | null {
    const records = this.scenesById.get(scene_id)?.persisted_records;
    return records ? structuredClone(records) : null;
  }

  public createScenePreview(scene_id: string, request: ScenePreviewRequest): ScenePreviewResponse {
    const stored = this.mustGetStoredScene(scene_id);
    const existing = this.getIdempotentResponse<ScenePreviewResponse>(stored, `preview:${scene_id}`, request.idempotency_key, request as Record<string, unknown>);
    if (existing) {
      return existing;
    }

    const now = this.nowIso();
    try {
      const preview_id = makeStableId(
        "preview",
        `${scene_id}:${request.request_id}:${request.idempotency_key}:${stored.scene.head.current_scene_version}`
      );
      const apply_token = createOpaqueToken(
        "apply",
        `${scene_id}:${preview_id}:${stored.scene.head.current_scene_version}`,
        this.tokenSecret
      );
      const apply_token_expires_at = addMilliseconds(now, this.handoffTtlMs);
      const response = createPreviewResponse(stored.scene, request, now, preview_id, apply_token, apply_token_expires_at);
      const previewRecord: PersistedPreviewRecord = {
        preview_id,
        scene_id,
        based_on_scene_version: stored.scene.head.current_scene_version,
        ops: structuredClone(request.ops),
        explanation: request.explanation,
        canonical_plan_hash: response.preview.canonical_plan_hash,
        apply_token_hash: hashOpaqueToken(this.tokenSecret, apply_token),
        apply_token_expires_at,
        idempotency_key: request.idempotency_key,
        created_at: now,
        consumed_at: null,
      };
      stored.preview_records.set(preview_id, previewRecord);
      this.persistStoredScene(stored);
      this.recordIdempotentResponse(stored, `preview:${scene_id}`, request.idempotency_key, request as Record<string, unknown>, 200, response, now);
      return response;
    } catch (error) {
      if (error instanceof SceneMutationError) {
        const responseBody = {
          reason_code: error.reason_code,
          message: error.message,
          validation_summary: error.validation_summary,
        };
        this.recordIdempotentResponse(stored, `preview:${scene_id}`, request.idempotency_key, request as Record<string, unknown>, 409, responseBody, now);
        throw new RoomPlanCaptureError(error.reason_code, error.message);
      }
      throw error;
    }
  }

  public applyScenePreview(scene_id: string, request: ApplyPlanRequest): SceneApplyResponse {
    const stored = this.mustGetStoredScene(scene_id);
    const existing = this.getIdempotentResponse<SceneApplyResponse>(stored, `apply:${scene_id}`, request.idempotency_key, request as Record<string, unknown>);
    if (existing) {
      return existing;
    }

    const now = this.nowIso();
    try {
      if (request.expected_scene_version !== stored.scene.head.current_scene_version) {
        throw new SceneMutationError(
          "VERSION_CONFLICT",
          `Expected scene version ${request.expected_scene_version} does not match current version ${stored.scene.head.current_scene_version}.`
        );
      }
      const preview = stored.preview_records.get(request.preview_id);
      if (!preview) {
        throw new SceneMutationError("APPLY_TOKEN_INVALID", `Preview ${request.preview_id} was not found.`);
      }
      if (preview.consumed_at) {
        throw new SceneMutationError("APPLY_TOKEN_INVALID", `Preview ${request.preview_id} has already been used.`);
      }
      if (isExpired(preview.apply_token_expires_at, now)) {
        throw new SceneMutationError("APPLY_TOKEN_EXPIRED", `Preview ${request.preview_id} has expired.`);
      }
      if (preview.based_on_scene_version !== stored.scene.head.current_scene_version) {
        throw new SceneMutationError(
          "VERSION_CONFLICT",
          `Preview ${request.preview_id} was created for scene version ${preview.based_on_scene_version}.`
        );
      }
      if (preview.canonical_plan_hash !== request.canonical_plan_hash) {
        throw new SceneMutationError("APPLY_TOKEN_INVALID", `Preview ${request.preview_id} has a mismatched plan hash.`);
      }
      if (preview.apply_token_hash !== hashOpaqueToken(this.tokenSecret, request.apply_token)) {
        throw new SceneMutationError("APPLY_TOKEN_INVALID", `Preview ${request.preview_id} has an invalid apply token.`);
      }

      const simulation = simulateScenePreview(
        stored.scene,
        {
          request_id: request.preview_id,
          idempotency_key: request.idempotency_key,
          expected_scene_version: request.expected_scene_version,
          ops: preview.ops,
          explanation: preview.explanation,
        },
        now
      );
      preview.consumed_at = now;
      const response = this.commitSimulatedScene(stored, simulation, "edit_plan", now);
      this.recordIdempotentResponse(stored, `apply:${scene_id}`, request.idempotency_key, request as Record<string, unknown>, 200, response, now);
      return response;
    } catch (error) {
      if (error instanceof SceneMutationError) {
        const responseBody = {
          reason_code: error.reason_code,
          message: error.message,
          validation_summary: error.validation_summary,
        };
        this.recordIdempotentResponse(stored, `apply:${scene_id}`, request.idempotency_key, request as Record<string, unknown>, 409, responseBody, now);
        throw new RoomPlanCaptureError(error.reason_code, error.message);
      }
      throw error;
    }
  }

  public undoLastChange(scene_id: string, request: UndoLastChangeRequest): SceneApplyResponse {
    const stored = this.mustGetStoredScene(scene_id);
    const existing = this.getIdempotentResponse<SceneApplyResponse>(stored, `undo:${scene_id}`, request.idempotency_key, request as Record<string, unknown>);
    if (existing) {
      return existing;
    }

    const now = this.nowIso();
    try {
      if (request.expected_scene_version !== stored.scene.head.current_scene_version) {
        throw new SceneMutationError(
          "VERSION_CONFLICT",
          `Expected scene version ${request.expected_scene_version} does not match current version ${stored.scene.head.current_scene_version}.`
        );
      }
      const undoBaseSnapshotId = stored.scene.head.undo_base_snapshot_id;
      if (!undoBaseSnapshotId) {
        throw new SceneMutationError("UNDO_NOT_AVAILABLE", `Scene ${scene_id} has no undoable snapshot.`);
      }
      const baseSnapshot = stored.snapshots.get(undoBaseSnapshotId);
      if (!baseSnapshot) {
        throw new SceneMutationError("UNDO_NOT_AVAILABLE", `Undo snapshot ${undoBaseSnapshotId} was not found.`);
      }
      const baseDerived = stored.derived_state_caches.get(undoBaseSnapshotId) ?? null;
      const simulatedScene = structuredClone(stored.scene);
      simulatedScene.snapshot = structuredClone(baseSnapshot);
      simulatedScene.derived_state_cache = baseDerived ? structuredClone(baseDerived.derived_state) : simulatedScene.derived_state_cache;
      const response = this.commitSimulatedScene(
        stored,
        {
          simulated_scene: simulatedScene,
          validation_summary: {
            hard_violations: simulatedScene.derived_state_cache?.hard_violations ?? [],
            soft_scores: simulatedScene.derived_state_cache?.soft_scores ?? {},
          },
        },
        "undo_restore",
        now
      );
      this.recordIdempotentResponse(stored, `undo:${scene_id}`, request.idempotency_key, request as Record<string, unknown>, 200, response, now);
      return response;
    } catch (error) {
      if (error instanceof SceneMutationError) {
        const responseBody = {
          reason_code: error.reason_code,
          message: error.message,
          validation_summary: error.validation_summary,
        };
        this.recordIdempotentResponse(stored, `undo:${scene_id}`, request.idempotency_key, request as Record<string, unknown>, 409, responseBody, now);
        throw new RoomPlanCaptureError(error.reason_code, error.message);
      }
      throw error;
    }
  }

  public redeemHandoff(request: HandoffRedeemRequest): HandoffRedeemResponse {
    const tokenHash = hashOpaqueToken(this.tokenSecret, request.handoff_token);
    const sceneId = this.handoffTokenHashToSceneId.get(tokenHash);
    if (!sceneId) {
      throw new RoomPlanCaptureError("SCENE_ACCESS_DENIED", "The provided handoff token is invalid.");
    }

    const stored = this.mustGetStoredScene(sceneId);
    if (stored.handoff_grant.token_hash !== tokenHash) {
      throw new RoomPlanCaptureError("SCENE_ACCESS_DENIED", "The provided handoff token is no longer valid.");
    }

    const now = this.nowIso();
    if (isExpired(stored.handoff_grant.expires_at, now)) {
      stored.handoff_grant.status = "expired";
      throw new RoomPlanCaptureError("HANDOFF_EXPIRED", "The handoff token has expired.");
    }
    if (stored.handoff_grant.status === "redeemed") {
      throw new RoomPlanCaptureError("HANDOFF_ALREADY_USED", "The handoff token has already been redeemed.");
    }

    const sessionId = makeStableId("session", `${sceneId}:${request.handoff_token}:${now}`);
    stored.handoff_grant.status = "redeemed";
    stored.handoff_grant.redeemed_at = now;
    stored.handoff_grant.redeemed_session_id = sessionId;
    this.persistStoredScene(stored);

    return {
      scene_id: sceneId,
      session_id: sessionId,
      redeemed_at: now,
      expires_at: addMilliseconds(now, this.sessionTtlMs),
    };
  }

  public postCaptureVideo(scene_id: string, request: VideoUploadRequest): VideoUploadResponse {
    const stored = this.mustGetStoredScene(scene_id);
    const tokenHash = hashOpaqueToken(this.tokenSecret, request.video_upload_token);
    const tokenSceneId = this.videoTokenHashToSceneId.get(tokenHash);

    if (!tokenSceneId || tokenSceneId !== scene_id || !stored.video_upload_token_record) {
      throw new RoomPlanCaptureError("VIDEO_UPLOAD_TOKEN_INVALID", "The video upload token is invalid.");
    }
    if (stored.video_upload_token_record.token_hash !== tokenHash) {
      throw new RoomPlanCaptureError("VIDEO_UPLOAD_TOKEN_INVALID", "The video upload token is no longer valid.");
    }

    const now = this.nowIso();
    if (isExpired(stored.video_upload_token_record.expires_at, now)) {
      stored.video_upload_token_record.status = "expired";
      throw new RoomPlanCaptureError("VIDEO_UPLOAD_TOKEN_EXPIRED", "The video upload token has expired.");
    }
    if (stored.video_upload_token_record.status === "used") {
      throw new RoomPlanCaptureError(
        "VIDEO_UPLOAD_TOKEN_ALREADY_USED",
        "The video upload token has already been used."
      );
    }

    stored.video_upload_token_record.status = "used";
    stored.video_upload_token_record.used_at = now;

    const job_id = makeStableId("job", `${scene_id}:splat:${request.content_type}:${now}`);
    const job: JobRecord = {
      job_id,
      scene_id,
      job_kind: "splat",
      status: "queued",
      source_scene_version: stored.scene.head.current_scene_version,
      scene_snapshot_id: stored.scene.snapshot.snapshot_id,
      created_at: now,
      updated_at: now,
      output_asset_id: null,
      error_code: null,
    };
    this.jobsById.set(job_id, job);

    stored.scene.splat = {
      scene_id,
      source_scene_version: stored.scene.head.current_scene_version,
      status: "queued",
      asset_id: null,
      uri: null,
      job_id,
      updated_at: now,
    };
    stored.persisted_records.splat_asset_record = structuredClone(stored.scene.splat);
    this.persistStoredScene(stored);

    return { job_id };
  }

  public getJob(job_id: string): JobRecord | null {
    return this.jobsById.get(job_id) ?? null;
  }

  private getIdempotentResponse<T>(
    stored: StoredSceneRecord,
    scope: string,
    idempotencyKey: string,
    requestBody: Record<string, unknown>
  ): T | null {
    const key = `${scope}:${idempotencyKey}`;
    const record = stored.idempotency_records.get(key);
    if (!record) {
      return null;
    }
    const requestHash = hashString(JSON.stringify(requestBody));
    if (record.request_hash !== requestHash) {
      throw new RoomPlanCaptureError(
        "IDEMPOTENCY_CONFLICT",
        `Idempotency key ${idempotencyKey} has already been used for a different request.`
      );
    }
    if (record.response_status_code >= 400) {
      const reasonCode = (record.response_body.reason_code as ReasonCode | undefined) ?? "INVALID_CAPTURE";
      throw new RoomPlanCaptureError(reasonCode, String(record.response_body.message ?? "Request failed."));
    }
    return structuredClone(record.response_body) as T;
  }

  private recordIdempotentResponse(
    stored: StoredSceneRecord,
    scope: string,
    idempotencyKey: string,
    requestBody: Record<string, unknown>,
    statusCode: number,
    responseBody: Record<string, unknown>,
    now: string
  ): void {
    const key = `${scope}:${idempotencyKey}`;
    const existing = stored.idempotency_records.get(key);
    const requestHash = hashString(JSON.stringify(requestBody));
    if (existing && existing.request_hash !== requestHash) {
      throw new RoomPlanCaptureError(
        "IDEMPOTENCY_CONFLICT",
        `Idempotency key ${idempotencyKey} has already been used for a different request.`
      );
    }
    const createdAt = existing?.created_at ?? now;
    const record: PersistedStoredIdempotencyRecord = {
      scope,
      idempotency_key: idempotencyKey,
      request_hash: requestHash,
      request_body: structuredClone(requestBody),
      response_status_code: statusCode,
      response_body: structuredClone(responseBody),
      scene_id: stored.scene.head.scene_id,
      created_at: createdAt,
      updated_at: now,
    };
    stored.idempotency_records.set(key, record);
    this.persistStoredScene(stored);
  }

  private commitSimulatedScene(
    stored: StoredSceneRecord,
    simulation: { simulated_scene: Scene; validation_summary: SceneApplyResponse["validation_summary"] },
    mutationKind: SceneSnapshot["mutation_kind"],
    now: string
  ): SceneApplyResponse {
    const previousSnapshotId = stored.scene.snapshot.snapshot_id;
    const nextSceneVersion = stored.scene.head.current_scene_version + 1;
    const newSnapshotId = makeStableId(
      "snapshot",
      `${stored.scene.head.scene_id}:v${nextSceneVersion}:${mutationKind}:${now}`
    );
    const newSnapshot: SceneSnapshot = {
      snapshot_id: newSnapshotId,
      scene_id: stored.scene.head.scene_id,
      scene_version: nextSceneVersion,
      based_on_snapshot_id: previousSnapshotId,
      mutation_kind: mutationKind,
      state: structuredClone(simulation.simulated_scene.snapshot.state),
      editing_asset_refs: structuredClone(simulation.simulated_scene.snapshot.editing_asset_refs),
      created_at: now,
    };
    const committedScene: Scene = {
      ...structuredClone(stored.scene),
      head: {
        ...structuredClone(stored.scene.head),
        current_snapshot_id: newSnapshotId,
        current_scene_version: nextSceneVersion,
        undo_base_snapshot_id: mutationKind === "edit_plan" ? previousSnapshotId : null,
        updated_at: now,
      },
      snapshot: newSnapshot,
      derived_state_cache: structuredClone(simulation.simulated_scene.derived_state_cache),
    };

    stored.scene = committedScene;
    stored.persisted_records.scene_head = {
      ...structuredClone(committedScene.head),
      created_at: stored.persisted_records.scene_head.created_at,
      deleted_at: stored.persisted_records.scene_head.deleted_at,
    };
    stored.persisted_records.scene_snapshot = structuredClone(newSnapshot);
    stored.persisted_records.derived_state_cache = committedScene.derived_state_cache
      ? {
          snapshot_id: newSnapshotId,
          scene_id: committedScene.head.scene_id,
          scene_version: nextSceneVersion,
          derived_state: structuredClone(committedScene.derived_state_cache),
          created_at: now,
          updated_at: now,
        }
      : null;
    stored.snapshots.set(newSnapshotId, structuredClone(newSnapshot));
    if (stored.persisted_records.derived_state_cache) {
      stored.derived_state_caches.set(newSnapshotId, structuredClone(stored.persisted_records.derived_state_cache));
    }
    this.persistStoredScene(stored);

    return {
      scene: structuredClone(committedScene),
      applied_snapshot_id: newSnapshotId,
      applied_scene_version: nextSceneVersion,
      validation_summary: structuredClone(simulation.validation_summary),
    };
  }

  private hydrateStoredScene(record: PersistedRoomPlanCaptureRecord): void {
    const persistedRecords = structuredClone(record.persisted_records);
    const scene = hydrateSceneFromStoredRecords(persistedRecords);
    const stored: StoredSceneRecord = {
      request_fingerprint: record.request_fingerprint,
      request_id: record.request_id,
      client_capture_id: record.client_capture_id,
      scene,
      persisted_records: persistedRecords,
      snapshots: new Map(
        (record.snapshots ?? [persistedRecords.scene_snapshot]).map((snapshot) => [snapshot.snapshot_id, structuredClone(snapshot)])
      ),
      derived_state_caches: new Map(
        (record.derived_state_caches ?? (persistedRecords.derived_state_cache ? [persistedRecords.derived_state_cache] : [])).map(
          (derivedStateCache) => [derivedStateCache.snapshot_id, structuredClone(derivedStateCache)]
        )
      ),
      preview_records: new Map(
        (record.preview_records ?? []).map((previewRecord) => [previewRecord.preview_id, structuredClone(previewRecord)])
      ),
      idempotency_records: new Map(
        (record.idempotency_records ?? []).map((idempotencyRecord) => [
          `${idempotencyRecord.scope}:${idempotencyRecord.idempotency_key}`,
          structuredClone(idempotencyRecord),
        ])
      ),
      handoff_grant: persistedRecords.handoff_grant,
      handoff_token: extractTokenFromQrPayload(persistedRecords.handoff_grant.qr_payload),
      video_upload_token_record: persistedRecords.video_upload_token_record,
      video_upload_token: null,
    };

    this.scenesById.set(scene.head.scene_id, stored);
    this.sceneIdByClientCaptureId.set(record.client_capture_id, scene.head.scene_id);
    this.handoffTokenHashToSceneId.set(stored.handoff_grant.token_hash, scene.head.scene_id);
    if (stored.video_upload_token_record) {
      this.videoTokenHashToSceneId.set(stored.video_upload_token_record.token_hash, scene.head.scene_id);
    }
  }

  private persistStoredScene(stored: StoredSceneRecord): void {
    this.durableStore?.save({
      request_fingerprint: stored.request_fingerprint,
      request_id: stored.request_id,
      client_capture_id: stored.client_capture_id,
      persisted_records: structuredClone(stored.persisted_records),
      snapshots: Array.from(stored.snapshots.values()).map((snapshot) => structuredClone(snapshot)),
      derived_state_caches: Array.from(stored.derived_state_caches.values()).map((cache) => structuredClone(cache)),
      preview_records: Array.from(stored.preview_records.values()).map((preview) => structuredClone(preview)),
      idempotency_records: Array.from(stored.idempotency_records.values()).map((record) => structuredClone(record)),
    });
  }

  private refreshAccessArtifacts(stored: StoredSceneRecord, videoExpected: boolean): void {
    const now = this.nowIso();
    if (stored.handoff_grant.status !== "issued" || isExpired(stored.handoff_grant.expires_at, now)) {
      this.handoffTokenHashToSceneId.delete(stored.handoff_grant.token_hash);
      const handoff = issueHandoffGrant(stored.scene.head.scene_id, now, {
        handoff_base_url: this.handoffBaseUrl,
        handoff_ttl_ms: this.handoffTtlMs,
        token_secret: this.tokenSecret,
      });
      stored.handoff_grant = handoff.record;
      stored.persisted_records.handoff_grant = handoff.record;
      stored.handoff_token = extractTokenFromQrPayload(handoff.record.qr_payload);
      this.handoffTokenHashToSceneId.set(handoff.record.token_hash, stored.scene.head.scene_id);
    }

    if (videoExpected) {
      if (
        !stored.video_upload_token_record ||
        stored.video_upload_token_record.status !== "issued" ||
        isExpired(stored.video_upload_token_record.expires_at, now) ||
        stored.video_upload_token === null
      ) {
        if (stored.video_upload_token_record) {
          this.videoTokenHashToSceneId.delete(stored.video_upload_token_record.token_hash);
        }
        const token = issueVideoUploadToken(stored.scene.head.scene_id, now, {
          video_upload_ttl_ms: this.videoUploadTtlMs,
          token_secret: this.tokenSecret,
        });
        stored.video_upload_token_record = token.record;
        stored.persisted_records.video_upload_token_record = token.record;
        stored.video_upload_token = token.token;
        this.videoTokenHashToSceneId.set(token.record.token_hash, stored.scene.head.scene_id);
      }
    }
  }

  private toCaptureResponse(stored: StoredSceneRecord): RoomPlanCaptureResponse {
    return {
      scene_id: stored.scene.head.scene_id,
      scene_version: stored.scene.head.current_scene_version,
      scene_snapshot_id: stored.scene.snapshot.snapshot_id,
      handoff_url: `${this.handoffBaseUrl}/${encodeURIComponent(stored.handoff_token)}`,
      qr_payload: stored.handoff_grant.qr_payload,
      expires_at: stored.handoff_grant.expires_at,
      video_upload_token: stored.video_upload_token,
    };
  }

  private mustGetStoredScene(scene_id: string): StoredSceneRecord {
    const stored = this.scenesById.get(scene_id);
    if (!stored) {
      throw new RoomPlanCaptureError("TARGET_NOT_FOUND", `Scene ${scene_id} was not found.`);
    }
    return stored;
  }

  private nowIso(): string {
    return this.nowFactory().toISOString();
  }
}

function validateRoomPlanCaptureRequest(request: RoomPlanCaptureRequest): void {
  if (!request.request_id || !request.client_capture_id) {
    throw new RoomPlanCaptureError("INVALID_CAPTURE", "request_id and client_capture_id are required.");
  }
  if (request.capture_metadata.room_type_hint !== "bedroom") {
    throw new RoomPlanCaptureError("ROOM_TYPE_NOT_SUPPORTED", "Only bedroom captures are supported in MVP.");
  }
  if (request.capture_metadata.units !== "m") {
    throw new RoomPlanCaptureError("INVALID_CAPTURE", "RoomPlan capture units must be meters.");
  }
  if (request.roomplan_payload.room_type !== "bedroom") {
    throw new RoomPlanCaptureError("ROOM_TYPE_NOT_SUPPORTED", "RoomPlan payload must describe a bedroom.");
  }
  if ((request.roomplan_payload.room_count ?? 1) !== 1) {
    throw new RoomPlanCaptureError("MULTI_ROOM_NOT_SUPPORTED", "Only single-room captures are supported in MVP.");
  }

  const payload = request.roomplan_payload;
  if (!Array.isArray(payload.surfaces) || payload.surfaces.length < 3) {
    throw new RoomPlanCaptureError("INVALID_CAPTURE", "RoomPlan payload must include surfaces.");
  }
  if (!Array.isArray(payload.openings) || !Array.isArray(payload.objects)) {
    throw new RoomPlanCaptureError("INVALID_CAPTURE", "RoomPlan payload must include openings and objects arrays.");
  }

  const floorSurfaces = payload.surfaces.filter((surface) => surface.category === "floor");
  if (floorSurfaces.length !== 1) {
    throw new RoomPlanCaptureError("INVALID_CAPTURE", "Exactly one floor surface is required.");
  }

  const surfaceIds = new Set(payload.surfaces.map((surface) => surface.id));
  for (const opening of payload.openings) {
    if (!surfaceIds.has(opening.host_surface_id)) {
      throw new RoomPlanCaptureError(
        "INVALID_CAPTURE",
        `Opening ${opening.id} references unknown surface ${opening.host_surface_id}.`
      );
    }
  }
}

function createNamedWallMap(surfaces: RoomPlanSurfaceSeed[], sceneSeed: string): Map<string, string> {
  const mapping = new Map<string, string>();
  for (const surface of surfaces) {
    if (surface.category !== "wall" || !surface.frame) {
      continue;
    }
    const wallName = cardinalWallNameFromNormal(surface.frame.normal);
    mapping.set(surface.id, makeStableId("wall-ref", `${sceneSeed}:${wallName}`));
  }
  return mapping;
}

function groupNamedWallRefs(
  wallRefIdsBySeedSurfaceId: Map<string, string>,
  surfaces: RoomPlanSurfaceSeed[],
  surfaceIdBySeedId: Map<string, string>,
  sceneSeed: string
): Map<string, NamedWallRef> {
  const refs = new Map<string, NamedWallRef>();
  for (const surface of surfaces) {
    if (surface.category !== "wall" || !surface.frame) {
      continue;
    }
    const name = cardinalWallNameFromNormal(surface.frame.normal);
    const wall_ref_id = mustGet(
      wallRefIdsBySeedSurfaceId,
      surface.id,
      "INVALID_CAPTURE",
      `Missing wall reference id for ${surface.id}`
    );
    const existing = refs.get(wall_ref_id);
    const canonicalSurfaceId = mustGet(
      surfaceIdBySeedId,
      surface.id,
      "INVALID_CAPTURE",
      `Missing canonical surface id for ${surface.id}`
    );
    if (existing) {
      existing.surface_ids.push(canonicalSurfaceId);
      continue;
    }
    refs.set(wall_ref_id, {
      wall_ref_id,
      name,
      surface_ids: [canonicalSurfaceId],
      azimuth_degrees: WALL_NAME_TO_AZIMUTH[name] ?? 0,
      inward_normal_xy: {
        x: roundNumber(surface.frame.normal.x),
        y: roundNumber(surface.frame.normal.y),
      },
    });
  }

  if (refs.size === 0) {
    throw new RoomPlanCaptureError("INVALID_CAPTURE", `No wall surfaces were found for scene ${sceneSeed}.`);
  }

  return refs;
}

function mapFixedElement(
  seed: RoomPlanFixedElementSeed,
  context: {
    now: string;
    sceneSeed: string;
    floorSurfaceId: string;
    hostSurfaceId: string | null;
  }
): FixedElement {
  const footprint = footprintFromObb(seed.obb);
  return {
    fixed_element_id: makeStableId("fixed-element", `${context.sceneSeed}:fixed:${seed.id}`),
    class: normalizeCategory(seed.category),
    pose: clonePose(seed.pose),
    obb: cloneObb(seed.obb),
    host: context.hostSurfaceId
      ? {
          relation_type: "flush_to_wall",
          host_surface_id: context.hostSurfaceId,
          anchor_rect: null,
        }
      : null,
    support: {
      support_kind: "floor",
      support_entity_id: context.floorSurfaceId,
      contact_patch: footprint,
    },
    keepout_zone: expandPolygon(footprint, 0.1),
    provenance: {
      source_kind: "measured",
      confidence: 0.85,
      source_ref: `roomplan:${seed.id}`,
      updated_at: context.now,
    },
  };
}

function mapOpening(
  seed: RoomPlanOpeningSeed,
  context: {
    now: string;
    sceneSeed: string;
    hostSurfaceId: string;
    hostSurface: Surface;
  }
): Opening {
  const keepoutDepth = seed.category === "window" ? 0.4 : seed.rect.width + 0.1;
  return {
    opening_id: makeStableId("opening", `${context.sceneSeed}:opening:${seed.id}`),
    host_surface_id: context.hostSurfaceId,
    type: seed.category,
    rect: cloneRect(seed.rect),
    swing_zone:
      seed.category === "door" || seed.category === "closet_door"
        ? openingZoneOnFloor(context.hostSurface.surface_frame, seed.rect, seed.rect.width)
        : null,
    keepout_zone: openingZoneOnFloor(context.hostSurface.surface_frame, seed.rect, keepoutDepth),
    connects_to_room_id: null,
    provenance: {
      source_kind: "measured",
      confidence: seed.category === "door" ? 0.99 : 0.98,
      source_ref: `roomplan:${seed.id}`,
      updated_at: context.now,
    },
  };
}

function createObjectDraft(
  input: ObjectBuildInput,
  context: {
    now: string;
    sceneSeed: string;
    floorSurfaceId: string;
    wallSurfaces: Surface[];
    roomWidth: number;
    roomLength: number;
    ceilingHeight: number;
  }
): ObjectDraft {
  const normalizedCategory = normalizeCategory(input.category);
  const objectClass: ObjectClass = isEditableCategory(normalizedCategory) ? normalizedCategory : "generic_obstacle";
  const hostSurface = findNearestWallSurface(input.pose.position, context.wallSurfaces, input.obb);
  const footprint = footprintFromObb(input.obb);
  const shouldWallMount = normalizedCategory === "television" && input.pose.position.z > 0.5 && hostSurface !== null;

  const object: SceneObject = {
    object_id: makeStableId("object", `${context.sceneSeed}:object:${input.id}`),
    class: objectClass,
    attributes: objectClass === "generic_obstacle" ? uniqueStrings([normalizedCategory, ...input.attributes]) : [...input.attributes],
    parent_id: null,
    child_movement_policy: "independent",
    pose: clonePose(input.pose),
    obb: cloneObb(input.obb),
    mobility: objectClass === "generic_obstacle" ? "fixed" : shouldWallMount ? "anchored" : "movable",
    host:
      hostSurface && !input.supplementary
        ? {
            relation_type: shouldWallMount ? "mounted_to_wall" : "flush_to_wall",
            host_surface_id: hostSurface.surface.surface_id,
            anchor_rect: null,
          }
        : null,
    support: shouldWallMount
      ? {
          support_kind: "wall",
          support_entity_id: hostSurface!.surface.surface_id,
          contact_patch: null,
        }
      : {
          support_kind: "floor",
          support_entity_id: context.floorSurfaceId,
          contact_patch: footprint,
        },
    asset_ref: null,
    style_tags: [],
    material_state: null,
    user_locked: false,
    provenance: {
      source_kind: input.source_kind,
      confidence: clamp01(input.confidence),
      source_ref: input.source_ref,
      updated_at: context.now,
    },
  };

  return {
    original_id: input.id,
    category: normalizedCategory,
    object,
    support_source: shouldWallMount ? "wall" : "floor",
    host_distance_m: hostSurface?.distance_m ?? null,
    footprint,
  };
}

function resolveObjectParentSupport(objectDrafts: ObjectDraft[]): void {
  for (const draft of objectDrafts) {
    if (draft.support_source !== "floor" || draft.object.class === "generic_obstacle") {
      continue;
    }
    const bottomZ = draft.object.obb.center.z - draft.object.obb.size_z / 2;
    if (bottomZ <= 0.2) {
      continue;
    }

    const supportCandidate = findSupportObject(draft, objectDrafts);
    if (!supportCandidate) {
      continue;
    }

    draft.object.parent_id = supportCandidate.object.object_id;
    draft.object.child_movement_policy = "move_with_parent";
    draft.object.support = {
      support_kind: "object",
      support_entity_id: supportCandidate.object.object_id,
      contact_patch: draft.footprint,
    };
    draft.object.mobility = draft.object.class === "generic_obstacle" ? "fixed" : "movable";
  }
}

function findSupportObject(target: ObjectDraft, drafts: ObjectDraft[]): ObjectDraft | null {
  let best: ObjectDraft | null = null;
  let bestArea = Number.POSITIVE_INFINITY;
  for (const candidate of drafts) {
    if (candidate === target) {
      continue;
    }
    if (candidate.object.class === "generic_obstacle") {
      continue;
    }
    const candidateTop = candidate.object.obb.center.z + candidate.object.obb.size_z / 2;
    const targetBottom = target.object.obb.center.z - target.object.obb.size_z / 2;
    const heightDelta = targetBottom - candidateTop;
    if (heightDelta < -0.05 || heightDelta > 0.45) {
      continue;
    }
    const candidateBounds = polygonBounds(candidate.footprint);
    const targetCenter = target.object.pose.position;
    if (!pointInBounds({ x: targetCenter.x, y: targetCenter.y }, candidateBounds)) {
      continue;
    }
    const area = boundsArea(candidateBounds);
    if (area < bestArea) {
      best = candidate;
      bestArea = area;
    }
  }
  return best;
}

function deriveFocalElements(openings: Opening[], objects: SceneObject[]): Room["focal_elements"] {
  const windows = openings.filter((opening) => opening.type === "window");
  if (windows.length > 0) {
    const primaryWindow = windows.reduce((best, current) => rectArea(current.rect) > rectArea(best.rect) ? current : best);
    return [
      {
        entity_id: primaryWindow.opening_id,
        entity_type: "opening",
        role: "primary",
        reason: "largest natural-light source",
      },
    ];
  }

  const television = objects.find((object) => object.class === "television");
  if (television) {
    return [
      {
        entity_id: television.object_id,
        entity_type: "object",
        role: "primary",
        reason: "captured media focal object",
      },
    ];
  }

  return [];
}

function deriveConstraintSpecs(
  openings: Opening[],
  objects: SceneObject[],
  fixedElements: FixedElement[],
  focalElements: Room["focal_elements"],
  sceneSeed: string
): ConstraintSpec[] {
  const constraints: ConstraintSpec[] = [];
  if (openings.length > 0) {
    constraints.push({
      constraint_id: makeStableId("constraint", `${sceneSeed}:opening-preserved`),
      kind: "opening_preserved",
      severity: "hard",
      target_entity_ids: openings.map((opening) => opening.opening_id),
      params: { min_keepout_m: 0 },
      reason_code_on_fail: "OPENING_BLOCKED",
    });
  }

  const door = openings.find((opening) => opening.type === "door" || opening.type === "closet_door") ?? null;
  const walkwayTargets = objects
    .filter((object) => object.class === "bed" || object.class === "desk" || object.class === "dresser" || object.class === "storage")
    .map((object) => object.object_id);
  if (door && walkwayTargets.length > 0) {
    constraints.push({
      constraint_id: makeStableId("constraint", `${sceneSeed}:walkway-clearance`),
      kind: "walkway_clearance",
      severity: "hard",
      target_entity_ids: [door.opening_id, ...walkwayTargets],
      params: { minimum_width_m: DEFAULT_CLEARANCE_WIDTH_M },
      reason_code_on_fail: "CLEARANCE_VIOLATION",
    });
  }

  constraints.push({
    constraint_id: makeStableId("constraint", `${sceneSeed}:overlap-bounds`),
    kind: "no_overlap_in_bounds",
    severity: "hard",
    target_entity_ids: objects.map((object) => object.object_id),
    params: { tolerance_m: 0.02 },
    reason_code_on_fail: "OBJECT_OVERLAP",
  });

  const anchorTargets = [
    ...objects.filter((object) => object.host !== null).map((object) => object.object_id),
    ...fixedElements.map((element) => element.fixed_element_id),
  ];
  if (anchorTargets.length > 0) {
    constraints.push({
      constraint_id: makeStableId("constraint", `${sceneSeed}:anchor-integrity`),
      kind: "anchor_integrity",
      severity: "hard",
      target_entity_ids: anchorTargets,
      params: {},
      reason_code_on_fail: "ANCHOR_VIOLATION",
    });
  }

  for (const object of objects) {
    if (object.class === "bed") {
      constraints.push({
        constraint_id: makeStableId("constraint", `${sceneSeed}:${object.object_id}:bed-clearance`),
        kind: "class_specific_clearance",
        severity: "hard",
        target_entity_ids: [object.object_id],
        params: { minimum_access_side_m: 0.6 },
        reason_code_on_fail: "CLEARANCE_VIOLATION",
      });
    }
    if (object.class === "desk") {
      constraints.push({
        constraint_id: makeStableId("constraint", `${sceneSeed}:${object.object_id}:desk-clearance`),
        kind: "class_specific_clearance",
        severity: "hard",
        target_entity_ids: [object.object_id],
        params: { minimum_pullout_m: 0.9 },
        reason_code_on_fail: "CLEARANCE_VIOLATION",
      });
    }
    if (object.class === "dresser" || object.class === "storage") {
      constraints.push({
        constraint_id: makeStableId("constraint", `${sceneSeed}:${object.object_id}:storage-clearance`),
        kind: "class_specific_clearance",
        severity: "hard",
        target_entity_ids: [object.object_id],
        params: { minimum_front_clearance_m: 0.6 },
        reason_code_on_fail: "CLEARANCE_VIOLATION",
      });
    }
  }

  const desk = objects.find((object) => object.class === "desk");
  const window = openings.find((opening) => opening.type === "window");
  if (desk && window) {
    constraints.push({
      constraint_id: makeStableId("constraint", `${sceneSeed}:desk-near-window`),
      kind: "desk_near_window",
      severity: "soft",
      target_entity_ids: [desk.object_id, window.opening_id],
      params: { target_distance_m: 0.75 },
      reason_code_on_fail: null,
    });
  }

  const sofa = objects.find((object) => object.class === "sofa");
  if (sofa && focalElements[0]) {
    constraints.push({
      constraint_id: makeStableId("constraint", `${sceneSeed}:sofa-faces-focal-element`),
      kind: "sofa_faces_focal_element",
      severity: "soft",
      target_entity_ids: [sofa.object_id, focalElements[0].entity_id],
      params: { max_alignment_error_degrees: 35 },
      reason_code_on_fail: null,
    });
  }

  if (door && objects.some((object) => object.class === "bed")) {
    constraints.push({
      constraint_id: makeStableId("constraint", `${sceneSeed}:primary-path`),
      kind: "primary_path_not_serpentine",
      severity: "soft",
      target_entity_ids: [door.opening_id, objects.find((object) => object.class === "bed")!.object_id],
      params: { max_tortuosity: 1.25 },
      reason_code_on_fail: null,
    });
  }

  return constraints;
}

function deriveSectionHints(objects: SceneObject[]): string[] {
  const hints = new Set<string>();
  if (objects.some((object) => object.class === "bed")) {
    hints.add("sleep_zone");
  }
  if (objects.some((object) => object.class === "desk" || object.class === "chair")) {
    hints.add("work_zone");
  }
  if (objects.some((object) => object.class === "dresser" || object.class === "storage" || object.class === "bookshelf")) {
    hints.add("storage_zone");
  }
  if (objects.some((object) => object.class === "generic_obstacle")) {
    hints.add("obstacle_zone");
  }
  if (hints.size === 0) {
    hints.add("general_zone");
  }
  return Array.from(hints);
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

function deriveInitialStateCache(
  room: Room,
  openings: Opening[],
  objects: SceneObject[],
  fixedElements: FixedElement[]
): DerivedState {
  const zones: Array<Record<string, unknown>> = [];
  const floorBounds = polygonBounds(room.shell.floor_polygon);

  for (const object of objects) {
    if (object.class === "bed") {
      zones.push({
        zone_id: makeStableId("zone", `${object.object_id}:bed-access`),
        kind: "bed_access",
        entity_id: object.object_id,
        polygon: accessZoneForObject(object, 0.9),
      });
    }
    if (object.class === "desk") {
      zones.push({
        zone_id: makeStableId("zone", `${object.object_id}:desk-pullout`),
        kind: "desk_pullout",
        entity_id: object.object_id,
        polygon: frontAccessZoneForObject(object, 0.9),
      });
    }
    if (object.class === "dresser" || object.class === "storage") {
      zones.push({
        zone_id: makeStableId("zone", `${object.object_id}:storage-access`),
        kind: "storage_access",
        entity_id: object.object_id,
        polygon: frontAccessZoneForObject(object, 0.6),
      });
    }
    if (object.class === "generic_obstacle") {
      zones.push({
        zone_id: makeStableId("zone", `${object.object_id}:obstacle-buffer`),
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
      if (intersectsBounds(leftBounds, rightBounds)) {
        hardViolations.push({
          entity_ids: [left.object_id, right.object_id],
          reason_code: "OBJECT_OVERLAP",
          message: `${left.class} overlaps ${right.class}.`,
        });
      }
    }
  }

  for (const opening of openings) {
    const keepout = opening.keepout_zone ? polygonBounds(opening.keepout_zone) : null;
    if (!keepout) {
      continue;
    }
    const blockedBy = objects
      .filter((object) => blocksFloorZones(object) && intersectsBounds(keepout, polygonBounds(footprintFromObb(object.obb))))
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
        .filter((object) => blocksFloorZones(object) && intersectsBounds(keepout, polygonBounds(footprintFromObb(object.obb))))
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

  const door = openings.find((opening) => opening.type === "door" || opening.type === "closet_door") ?? null;
  const clearance_paths: Array<Record<string, unknown>> = [];
  if (door) {
    const start = openingAnchorPoint(door);
    for (const target of objects.filter((object) => object.class === "bed" || object.class === "desk" || object.class === "storage" || object.class === "dresser")) {
      const targetPoint = { x: target.pose.position.x, y: target.pose.position.y };
      const midPoint = { x: roundNumber((start.x + targetPoint.x) / 2), y: roundNumber((start.y + targetPoint.y) / 2) };
      const width_m = estimatePathWidth(start, targetPoint, objects, fixedElements, target.object_id);
      clearance_paths.push({
        path_id: makeStableId("path", `${door.opening_id}:${target.object_id}`),
        width_m,
        waypoints: [start, midPoint, targetPoint],
      });
      if (width_m < DEFAULT_CLEARANCE_WIDTH_M) {
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

function createDefaultBookmarks(
  sceneId: string,
  room: Room,
  openingsById: Map<string, Opening>,
  now: string
): CameraBookmark[] {
  const bounds = polygonBounds(room.shell.floor_polygon);
  const door = room.shell.openings.find((opening) => opening.type === "door" || opening.type === "closet_door") ?? null;
  const primaryWindow = room.shell.openings.find((opening) => opening.type === "window") ?? null;

  const entryAnchor = door ? openingAnchorPoint(door) : { x: roundNumber((bounds.min_x + bounds.max_x) / 2), y: bounds.min_y };
  const entryYaw = primaryWindow ? angleToDegrees(entryAnchor, openingAnchorPoint(primaryWindow)) : 0;

  const bookmarks: CameraBookmark[] = [
    {
      bookmark_id: makeStableId("bookmark", `${sceneId}:entry-view`),
      name: "Entry view",
      camera_pose: {
        position: {
          x: entryAnchor.x,
          y: roundNumber(entryAnchor.y - 1.2),
          z: 1.65,
        },
        yaw_degrees: roundNumber(entryYaw),
      },
      fov: 58,
      created_at: now,
      updated_at: now,
    },
  ];

  if (primaryWindow) {
    const windowAnchor = openingAnchorPoint(primaryWindow);
    bookmarks.push({
      bookmark_id: makeStableId("bookmark", `${sceneId}:window-view`),
      name: "Window wall",
      camera_pose: {
        position: {
          x: windowAnchor.x,
          y: roundNumber(Math.max(bounds.min_y + 0.8, windowAnchor.y - 2)),
          z: 1.55,
        },
        yaw_degrees: roundNumber(angleToDegrees({ x: windowAnchor.x, y: windowAnchor.y - 2 }, windowAnchor)),
      },
      fov: 52,
      created_at: now,
      updated_at: now,
    });
  }

  return bookmarks;
}

function selectInitialAsset(objectClass: EditableObjectClass, obb: SceneObject["obb"]): AssetTemplate {
  const library = ASSET_LIBRARY[objectClass];
  const footprint = normalizeFootprintDimensions(obb.size_x, obb.size_y);
  let best: AssetTemplate | null = null;
  let bestError = Number.POSITIVE_INFINITY;
  for (const candidate of library) {
    const candidateFootprint = normalizeFootprintDimensions(candidate.preferred_size_xy.x, candidate.preferred_size_xy.y);
    const error = relativeDimensionError(footprint.x, candidateFootprint.x) + relativeDimensionError(footprint.y, candidateFootprint.y);
    if (error <= candidate.max_relative_error * 2 && error < bestError) {
      best = candidate;
      bestError = error;
    }
  }
  return best ?? library[library.length - 1];
}

function issueHandoffGrant(
  scene_id: string,
  now: string,
  options: { handoff_base_url?: string; handoff_ttl_ms?: number; token_secret?: string }
): { token: string; url: string; record: HandoffGrantRecord } {
  const tokenSecret = options.token_secret ?? "roomview";
  const rawToken = createOpaqueToken("handoff", `${scene_id}:${now}`, tokenSecret);
  const token_hash = hashOpaqueToken(tokenSecret, rawToken);
  const expires_at = addMilliseconds(now, options.handoff_ttl_ms ?? DEFAULT_HANDOFF_TTL_MS);
  const qr_payload = JSON.stringify({
    handoff_token: rawToken,
    scene_id,
    expires_at,
  });

  return {
    token: rawToken,
    url: `${options.handoff_base_url ?? "https://roomview.local/h"}/${encodeURIComponent(rawToken)}`,
    record: {
      grant_id: makeStableId("grant", `${scene_id}:${rawToken}`),
      scene_id,
      token_hash,
      qr_payload,
      status: "issued",
      expires_at,
      redeemed_at: null,
      redeemed_session_id: null,
    },
  };
}

function issueVideoUploadToken(
  scene_id: string,
  now: string,
  options: { video_upload_ttl_ms?: number; token_secret?: string }
): { token: string; record: VideoUploadTokenRecord } {
  const tokenSecret = options.token_secret ?? "roomview";
  const token = createOpaqueToken("video", `${scene_id}:${now}`, tokenSecret);
  const token_hash = hashOpaqueToken(tokenSecret, token);
  return {
    token,
    record: {
      token_id: makeStableId("video-token", `${scene_id}:${token}`),
      scene_id,
      token_hash,
      status: "issued",
      expires_at: addMilliseconds(now, options.video_upload_ttl_ms ?? DEFAULT_VIDEO_UPLOAD_TTL_MS),
      used_at: null,
      created_at: now,
    },
  };
}

function findNearestWallSurface(
  position: Point3D,
  wallSurfaces: Surface[],
  obb: SceneObject["obb"]
): { surface: Surface; distance_m: number } | null {
  let best: { surface: Surface; distance_m: number } | null = null;
  for (const surface of wallSurfaces) {
    if (!surface.surface_frame) {
      continue;
    }
    const normal = surface.surface_frame.normal;
    const planePoint = surface.surface_frame.origin;
    const distance = Math.abs((position.x - planePoint.x) * normal.x + (position.y - planePoint.y) * normal.y);
    const reach = Math.max(obb.size_x, obb.size_y) / 2 + 0.2;
    if (distance > reach) {
      continue;
    }
    if (!best || distance < best.distance_m) {
      best = { surface, distance_m: roundNumber(distance) };
    }
  }
  return best;
}

function defaultMaterialForSurface(category: Surface["type"]): MaterialState {
  if (category === "floor") {
    return cloneMaterialState(DEFAULT_FLOOR_MATERIAL);
  }
  if (category === "ceiling") {
    return cloneMaterialState(DEFAULT_CEILING_MATERIAL);
  }
  return cloneMaterialState(DEFAULT_WALL_MATERIAL);
}

function openingZoneOnFloor(surfaceFrame: SurfaceFrame | null, rect: RectOnSurface, depth: number): Polygon2D | null {
  if (!surfaceFrame) {
    return null;
  }
  const start = projectPointOnSurfaceFrameToFloor(surfaceFrame, rect.min_u, 0);
  const end = projectPointOnSurfaceFrameToFloor(surfaceFrame, rect.min_u + rect.width, 0);
  const inward = normalizeVector2D({ x: surfaceFrame.normal.x, y: surfaceFrame.normal.y });
  const offset = { x: inward.x * depth, y: inward.y * depth };
  return {
    vertices: [
      start,
      end,
      { x: roundNumber(end.x + offset.x), y: roundNumber(end.y + offset.y) },
      { x: roundNumber(start.x + offset.x), y: roundNumber(start.y + offset.y) },
    ],
  };
}

function projectPointOnSurfaceFrameToFloor(surfaceFrame: SurfaceFrame, u: number, v: number): Point2D {
  return {
    x: roundNumber(
      surfaceFrame.origin.x + surfaceFrame.u_axis.x * u + surfaceFrame.v_axis.x * v
    ),
    y: roundNumber(
      surfaceFrame.origin.y + surfaceFrame.u_axis.y * u + surfaceFrame.v_axis.y * v
    ),
  };
}

function footprintFromObb(obb: SceneObject["obb"]): Polygon2D {
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

function accessZoneForObject(object: SceneObject, depth: number): Polygon2D {
  const footprint = footprintFromObb(object.obb);
  const bounds = polygonBounds(footprint);
  const hostNormal = object.host ? hostSurfaceNormalToAccessDirection(object.host.host_surface_id, object) : null;
  if (hostNormal) {
    return expandTowardDirection(boundsToPolygon(bounds), hostNormal, depth);
  }
  return expandTowardDirection(boundsToPolygon(bounds), { x: 1, y: 0 }, depth);
}

function frontAccessZoneForObject(object: SceneObject, depth: number): Polygon2D {
  const front = yawVector(object.pose.yaw_degrees);
  return expandTowardDirection(footprintFromObb(object.obb), front, depth);
}

function hostSurfaceNormalToAccessDirection(_hostSurfaceId: string, object: SceneObject): Point2D | null {
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

function openingAnchorPoint(opening: Opening): Point2D {
  if (opening.keepout_zone) {
    return polygonCenter(opening.keepout_zone);
  }
  return rectToFloorCenter(opening.rect);
}

function rectToFloorCenter(rect: RectOnSurface): Point2D {
  return {
    x: roundNumber(rect.min_u + rect.width / 2),
    y: roundNumber(rect.min_v + rect.height / 2),
  };
}

function rectToFloorPolygon(rect: RectOnSurface): Polygon2D {
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

function blocksFloorZones(object: SceneObject): boolean {
  if (object.class === "rug") {
    return false;
  }
  return object.support.support_kind === "floor";
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
    const nearWindow = openings.some((opening) => opening.type === "window" && distance2D(openingAnchorPoint(opening), { x: desk.pose.position.x, y: desk.pose.position.y }) < 1.5);
    parts.push(nearWindow ? "Desk positioned near a window." : "Desk available as secondary target.");
  }
  if (obstacle) {
    parts.push("Unsupported detection preserved as generic obstacle.");
  }
  if (parts.length === 0) {
    parts.push("Initial editable scene created from RoomPlan capture.");
  }
  return parts.join(" ");
}

function createRequestFingerprint(request: RoomPlanCaptureRequest): string {
  const normalizedSupplementary = (request.supplementary_detections ?? []).map((detection) => ({
    detection_id: detection.detection_id,
    label: normalizeCategory(detection.label),
    obb: detection.obb,
    confidence: roundNumber(detection.confidence),
  }));
  return hashString(
    JSON.stringify({
      client_capture_id: request.client_capture_id,
      roomplan_payload: request.roomplan_payload,
      capture_metadata: request.capture_metadata,
      supplementary_detections: normalizedSupplementary,
    })
  );
}

function extractTokenFromQrPayload(qrPayload: string): string {
  const parsed = JSON.parse(qrPayload) as { handoff_token?: string };
  if (!parsed.handoff_token) {
    throw new RoomPlanCaptureError("INVALID_CAPTURE", "QR payload is missing a handoff token.");
  }
  return parsed.handoff_token;
}

function createOpaqueToken(prefix: string, _seed: string, _secret: string): string {
  return `${prefix}_${randomBytes(24).toString("base64url")}`;
}

function hashOpaqueToken(secret: string, token: string): string {
  return createHash("sha256").update(secret).update(":").update(token).digest("hex");
}

function makeStableId(prefix: string, seed: string): string {
  const slug = slugify(seed).slice(0, 40);
  return `${prefix}-${slug}-${hashString(seed).slice(0, 8)}`;
}

function cardinalWallNameFromNormal(normal: Point3D): string {
  if (Math.abs(normal.x) >= Math.abs(normal.y)) {
    return normal.x >= 0 ? "west wall" : "east wall";
  }
  return normal.y >= 0 ? "south wall" : "north wall";
}

function normalizeCategory(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "id";
}

function isEditableCategory(category: string): category is EditableObjectClass {
  return EDITABLE_OBJECT_CLASSES.has(category as EditableObjectClass);
}

function relativeDimensionError(actual: number, expected: number): number {
  return Math.abs(actual - expected) / Math.max(expected, 0.01);
}

function normalizeFootprintDimensions(x: number, y: number): { x: number; y: number } {
  return x >= y ? { x, y } : { x: y, y: x };
}

function clonePolygon(polygon: Polygon2D): Polygon2D {
  return { vertices: polygon.vertices.map((vertex) => ({ x: vertex.x, y: vertex.y })) };
}

function cloneSurfaceFrame(frame: SurfaceFrame): SurfaceFrame {
  return {
    origin: clonePoint3D(frame.origin),
    u_axis: cloneVector3D(frame.u_axis),
    v_axis: cloneVector3D(frame.v_axis),
    normal: cloneVector3D(frame.normal),
  };
}

function clonePose(pose: Pose3D): Pose3D {
  return {
    position: clonePoint3D(pose.position),
    yaw_degrees: pose.yaw_degrees,
  };
}

function cloneObb(obb: SceneObject["obb"]): SceneObject["obb"] {
  return {
    center: clonePoint3D(obb.center),
    size_x: obb.size_x,
    size_y: obb.size_y,
    size_z: obb.size_z,
    yaw_degrees: obb.yaw_degrees,
  };
}

function cloneMaterialState(material: MaterialState): MaterialState {
  return {
    category: material.category,
    color: material.color,
    finish: material.finish,
    pattern: material.pattern,
    reference_asset_id: material.reference_asset_id,
  };
}

function cloneRect(rect: RectOnSurface): RectOnSurface {
  return {
    min_u: rect.min_u,
    min_v: rect.min_v,
    width: rect.width,
    height: rect.height,
  };
}

function clonePoint3D(point: Point3D): Point3D {
  return { x: point.x, y: point.y, z: point.z };
}

function cloneVector3D(vector: Point3D): Point3D {
  return { x: vector.x, y: vector.y, z: vector.z };
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
  return Math.max(0, bounds.max_x - bounds.min_x) * Math.max(0, bounds.max_y - bounds.min_y);
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

function rectArea(rect: RectOnSurface): number {
  return rect.width * rect.height;
}

function angleToDegrees(from: Point2D, to: Point2D): number {
  return radiansToDegrees(Math.atan2(to.y - from.y, to.x - from.x));
}

function yawVector(yawDegrees: number): Point2D {
  const radians = degreesToRadians(yawDegrees);
  return { x: roundNumber(Math.cos(radians)), y: roundNumber(Math.sin(radians)) };
}

function normalizeVector2D(vector: Point2D): Point2D {
  const magnitude = Math.hypot(vector.x, vector.y) || 1;
  return {
    x: roundNumber(vector.x / magnitude),
    y: roundNumber(vector.y / magnitude),
  };
}

function normalizedAngleDifference(left: number, right: number): number {
  const difference = Math.abs((((left - right) % 360) + 540) % 360 - 180);
  return roundNumber(difference);
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

function addMilliseconds(timestamp: string, ms: number): string {
  return new Date(new Date(timestamp).getTime() + ms).toISOString();
}

function isExpired(expiresAt: string, now: string): boolean {
  return new Date(expiresAt).getTime() <= new Date(now).getTime();
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

function hashString(value: string): string {
  let hashA = 2166136261;
  let hashB = 334214467;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    hashA ^= code;
    hashA = Math.imul(hashA, 16777619);
    hashB ^= code + index;
    hashB = Math.imul(hashB, 2246822519);
  }
  return `${(hashA >>> 0).toString(16).padStart(8, "0")}${(hashB >>> 0).toString(16).padStart(8, "0")}`;
}

function mustGet<K, V>(map: Map<K, V>, key: K, reasonCode: ReasonCode, message: string): V {
  const value = map.get(key);
  if (value === undefined) {
    throw new RoomPlanCaptureError(reasonCode, message);
  }
  return value;
}
