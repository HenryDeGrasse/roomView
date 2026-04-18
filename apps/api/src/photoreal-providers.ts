/**
 * Photoreal provider selection + deterministic-stub fallback.
 *
 * The MVP ships with a deterministic stub that returns a synthetic `asset://`
 * URI derived entirely from scene-version + snapshot + camera + prompt. That
 * keeps `verify:photoreal` reproducible.
 *
 * The hook is wired for real providers (ControlNet-SDXL via Replicate, local
 * SDXL, or others). To flip on, set `ROOMVIEW_PHOTOREAL_PROVIDER=replicate`
 * and `ROOMVIEW_REPLICATE_API_TOKEN=...`. The full real-provider path also
 * needs `generatePhotoreal` to be async (job status: queued → processing →
 * ready), which is a follow-up refactor.
 */
import type { Pose3D, SnapshotId } from "../../../packages/contracts/src/index.ts";

export interface PhotorealProviderInput {
  scene_id: string;
  scene_snapshot_id: SnapshotId;
  scene_version: number;
  entry_id: string;
  camera_pose: Pose3D;
  fov: number;
  prompt_modifiers: string[];
  conditioning_summary: {
    asset_binding_count: number;
    surface_count: number;
    object_count: number;
    scene_version: number;
    scene_snapshot_id: SnapshotId;
  };
  client_conditioning: {
    present: boolean;
    has_color: boolean;
    has_depth: boolean;
    has_edge: boolean;
    width: number | null;
    height: number | null;
    color_byte_length: number;
    depth_byte_length: number;
    edge_byte_length: number;
  };
}

export interface PhotorealProviderResult {
  provider: string;
  uri: string;
  extra?: Record<string, unknown>;
}

export type PhotorealProviderKind = "deterministic_stub" | "replicate" | "local_sdxl";

export function resolveProviderKind(env: NodeJS.ProcessEnv = process.env): PhotorealProviderKind {
  const kind = (env.ROOMVIEW_PHOTOREAL_PROVIDER || "").toLowerCase().trim();
  if (kind === "replicate") return "replicate";
  if (kind === "local_sdxl" || kind === "sdxl") return "local_sdxl";
  return "deterministic_stub";
}

/**
 * Synchronous provider call. MVP path: always the deterministic stub — real
 * providers require an async generate and are deferred to a follow-up that
 * queues jobs and marks `JobRecord.status = "processing"` until the provider
 * callback lands. For now, non-stub kinds log a warning and fall back so the
 * API contract remains synchronous and all verify scripts keep passing.
 */
export function resolvePhotorealMetadata(input: PhotorealProviderInput): PhotorealProviderResult {
  const kind = resolveProviderKind();
  if (kind !== "deterministic_stub") {
    // eslint-disable-next-line no-console
    console.warn(
      `[photoreal] provider "${kind}" selected but sync generate path requires async refactor; falling back to deterministic_stub. Set ROOMVIEW_PHOTOREAL_PROVIDER=deterministic_stub to silence.`
    );
  }
  return deterministicStub(input);
}

function deterministicStub(input: PhotorealProviderInput): PhotorealProviderResult {
  const uri = `asset://photoreal/${encodeURIComponent(input.scene_id)}/${encodeURIComponent(input.scene_snapshot_id)}/${encodeURIComponent(input.entry_id)}.png`;
  return {
    provider: "deterministic_stub",
    uri,
    extra: {
      conditioning_scene_version: input.conditioning_summary.scene_version,
      conditioning_snapshot_id: input.conditioning_summary.scene_snapshot_id,
      conditioning_asset_binding_count: input.conditioning_summary.asset_binding_count,
      conditioning_surface_count: input.conditioning_summary.surface_count,
      conditioning_object_count: input.conditioning_summary.object_count,
      client_conditioning_present: input.client_conditioning.present,
      client_conditioning_has_color: input.client_conditioning.has_color,
      client_conditioning_has_depth: input.client_conditioning.has_depth,
      client_conditioning_has_edge: input.client_conditioning.has_edge,
      client_conditioning_width: input.client_conditioning.width,
      client_conditioning_height: input.client_conditioning.height,
    },
  };
}

export function summarizeClientConditioning(
  conditioning: { color?: string | null; depth?: string | null; edge?: string | null; width?: number | null; height?: number | null } | null | undefined,
): PhotorealProviderInput["client_conditioning"] {
  if (!conditioning) {
    return {
      present: false,
      has_color: false,
      has_depth: false,
      has_edge: false,
      width: null,
      height: null,
      color_byte_length: 0,
      depth_byte_length: 0,
      edge_byte_length: 0,
    };
  }
  const byteLength = (value: string | null | undefined): number => {
    if (typeof value !== "string" || value.length === 0) return 0;
    // Rough estimate from base64 length; exact decode unnecessary for metadata.
    return Math.floor((value.length * 3) / 4);
  };
  return {
    present: true,
    has_color: typeof conditioning.color === "string" && conditioning.color.length > 0,
    has_depth: typeof conditioning.depth === "string" && conditioning.depth.length > 0,
    has_edge: typeof conditioning.edge === "string" && conditioning.edge.length > 0,
    width: typeof conditioning.width === "number" ? conditioning.width : null,
    height: typeof conditioning.height === "number" ? conditioning.height : null,
    color_byte_length: byteLength(conditioning.color),
    depth_byte_length: byteLength(conditioning.depth),
    edge_byte_length: byteLength(conditioning.edge),
  };
}
