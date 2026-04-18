/**
 * Photoreal provider selection + deterministic-stub fallback.
 *
 * The deterministic stub stays sync so fixture + unit verification remain
 * reproducible. Real providers can run asynchronously through the service.
 */
import type { Pose3D, SnapshotId } from "../../../packages/contracts/src/index.ts";

const DEFAULT_OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const DEFAULT_OPENROUTER_IMAGE_MODEL = "google/gemini-3-pro-image-preview";
const DEFAULT_OPENROUTER_TIMEOUT_MS = 90_000;
const DEFAULT_SITE_URL = "http://127.0.0.1:3000";
const DEFAULT_APP_NAME = "RoomView MVP Local";

export interface PhotorealProviderInput {
  scene_id: string;
  scene_snapshot_id: SnapshotId;
  scene_version: number;
  entry_id: string;
  camera_pose: Pose3D;
  fov: number;
  prompt_modifiers: string[];
  scene_prompt: string;
  seed?: number | null;
  reference_image_data_url?: string | null;
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
  uri: string | null;
  image?: {
    bytes: Buffer;
    content_type: string;
  };
  extra?: Record<string, unknown>;
}

export type PhotorealProviderKind = "deterministic_stub" | "openrouter" | "replicate" | "local_sdxl";

interface OpenRouterChatCompletionResponse {
  choices?: Array<{
    message?: {
      role?: string;
      content?: unknown;
      images?: Array<{
        type?: string;
        image_url?: { url?: string | null } | null;
        imageUrl?: { url?: string | null } | null;
      }>;
    };
  }>;
  error?: {
    message?: string;
  };
}

type OpenRouterAssistantMessage = NonNullable<NonNullable<OpenRouterChatCompletionResponse["choices"]>[number]["message"]>;

export function resolveProviderKind(env: NodeJS.ProcessEnv = process.env): PhotorealProviderKind {
  const kind = (env.ROOMVIEW_PHOTOREAL_PROVIDER || "").toLowerCase().trim();
  if (kind === "openrouter") return "openrouter";
  if (kind === "replicate") return "replicate";
  if (kind === "local_sdxl" || kind === "sdxl") return "local_sdxl";
  return "deterministic_stub";
}

/**
 * Sync metadata path used by the deterministic stub and legacy tests.
 */
export function resolvePhotorealMetadata(input: PhotorealProviderInput): PhotorealProviderResult {
  const kind = resolveProviderKind();
  if (kind !== "deterministic_stub") {
    // eslint-disable-next-line no-console
    console.warn(
      `[photoreal] provider "${kind}" selected but sync generate path only supports deterministic_stub; falling back to deterministic_stub.`
    );
  }
  return deterministicStub(input);
}

export async function generateOpenRouterPhotoreal(
  input: PhotorealProviderInput,
  env: NodeJS.ProcessEnv = process.env,
): Promise<PhotorealProviderResult> {
  const apiKey = env.OPENROUTER_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("OPENROUTER_API_KEY is required for the openrouter photoreal provider.");
  }

  const baseUrl = (env.OPENROUTER_BASE_URL || DEFAULT_OPENROUTER_BASE_URL).trim().replace(/\/$/, "");
  const model = resolveOpenRouterPhotorealModel(env);
  const timeoutMs = resolvePositiveInteger(env.ROOMVIEW_PHOTOREAL_TIMEOUT_MS, DEFAULT_OPENROUTER_TIMEOUT_MS);
  const imageSize = resolveOpenRouterImageSize(env.ROOMVIEW_PHOTOREAL_IMAGE_SIZE);
  const aspectRatio = pickAspectRatio(input.client_conditioning.width, input.client_conditioning.height);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const body: Record<string, unknown> = {
      model,
      messages: [{
        role: "user",
        content: input.reference_image_data_url
          ? [
              {
                type: "text",
                text: input.scene_prompt,
              },
              {
                type: "image_url",
                image_url: {
                  url: input.reference_image_data_url,
                },
              },
            ]
          : input.scene_prompt,
      }],
      modalities: ["image", "text"],
      stream: false,
      image_config: {
        aspect_ratio: aspectRatio,
        image_size: imageSize,
      },
    };
    if (typeof input.seed === "number" && Number.isFinite(input.seed)) {
      body.seed = Math.trunc(input.seed);
    }

    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": env.ROOMVIEW_SITE_URL || DEFAULT_SITE_URL,
        "X-Title": env.ROOMVIEW_APP_NAME || DEFAULT_APP_NAME,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    const payload = await response.json() as OpenRouterChatCompletionResponse;
    if (!response.ok) {
      throw new Error(payload.error?.message ?? `OpenRouter request failed with status ${response.status}.`);
    }

    const message = payload.choices?.[0]?.message ?? null;
    const dataUrl = firstImageDataUrl(message);
    if (!dataUrl) {
      throw new Error("OpenRouter returned no image.");
    }

    const parsedImage = parseDataUrlImage(dataUrl);
    if (!parsedImage) {
      throw new Error("OpenRouter returned an unsupported image payload.");
    }

    return {
      provider: "openrouter",
      uri: null,
      image: {
        bytes: parsedImage.bytes,
        content_type: parsedImage.content_type,
      },
      extra: {
        model,
        aspect_ratio: aspectRatio,
        image_size: imageSize,
        prompt_preview: input.scene_prompt.slice(0, 600),
        reference_image_present: Boolean(input.reference_image_data_url),
        seed_requested: typeof input.seed === "number" && Number.isFinite(input.seed) ? Math.trunc(input.seed) : null,
        seed_semantics: "best_effort",
        response_text: extractAssistantText(message?.content),
      },
    };
  } finally {
    clearTimeout(timeout);
  }
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
      seed_requested: typeof input.seed === "number" && Number.isFinite(input.seed) ? Math.trunc(input.seed) : null,
    },
  };
}

function firstImageDataUrl(message: OpenRouterAssistantMessage | null): string | null {
  const images = message?.images ?? [];
  for (const image of images) {
    const maybeUrl = image.image_url?.url ?? image.imageUrl?.url ?? null;
    if (typeof maybeUrl === "string" && maybeUrl.startsWith("data:image/")) {
      return maybeUrl;
    }
  }
  if (Array.isArray(message?.content)) {
    for (const item of message.content) {
      if (!item || typeof item !== "object") continue;
      const maybeType = "type" in item ? item.type : null;
      if (maybeType !== "image_url") continue;
      const maybeUrl = "image_url" in item && item.image_url && typeof item.image_url === "object"
        ? (item.image_url as { url?: unknown }).url
        : "imageUrl" in item && item.imageUrl && typeof item.imageUrl === "object"
          ? (item.imageUrl as { url?: unknown }).url
          : null;
      if (typeof maybeUrl === "string" && maybeUrl.startsWith("data:image/")) {
        return maybeUrl;
      }
    }
  }
  return null;
}

function parseDataUrlImage(dataUrl: string): { content_type: string; bytes: Buffer } | null {
  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!match?.[1] || !match[2]) {
    return null;
  }
  return {
    content_type: match[1],
    bytes: Buffer.from(match[2], "base64"),
  };
}

function extractAssistantText(content: unknown): string | null {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((entry) => {
        if (!entry || typeof entry !== "object") return null;
        if ("type" in entry && entry.type === "text" && "text" in entry && typeof entry.text === "string") {
          return entry.text;
        }
        return null;
      })
      .filter((value): value is string => typeof value === "string" && value.length > 0)
      .join(" ") || null;
  }
  return null;
}

function resolveOpenRouterPhotorealModel(env: NodeJS.ProcessEnv): string {
  return (env.ROOMVIEW_PHOTOREAL_MODEL || env.OPENROUTER_PHOTOREAL_MODEL || DEFAULT_OPENROUTER_IMAGE_MODEL).trim();
}

function resolveOpenRouterImageSize(raw: string | undefined): "0.5K" | "1K" | "2K" | "4K" {
  const normalized = (raw || "").trim().toUpperCase();
  if (normalized === "0.5K" || normalized === "1K" || normalized === "2K" || normalized === "4K") {
    return normalized;
  }
  return "1K";
}

function pickAspectRatio(width: number | null, height: number | null): string {
  if (!width || !height || width <= 0 || height <= 0) {
    return "4:3";
  }
  const ratio = width / height;
  const candidates = [
    { label: "1:1", ratio: 1 },
    { label: "4:3", ratio: 4 / 3 },
    { label: "3:4", ratio: 3 / 4 },
    { label: "16:9", ratio: 16 / 9 },
    { label: "9:16", ratio: 9 / 16 },
  ];
  return candidates
    .slice()
    .sort((left, right) => Math.abs(left.ratio - ratio) - Math.abs(right.ratio - ratio))[0]?.label ?? "4:3";
}

function resolvePositiveInteger(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(raw || "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
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
