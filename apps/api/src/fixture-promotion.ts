import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import type {
  CapturedFrame,
  FixtureDescriptor,
  FixtureManifest,
  RoomPlanCaptureRequest,
  Scene,
} from "@roomview/contracts";

export interface FixturePromotionInputs {
  /** Source scene in the service store — not mutated. */
  scene: Scene;
  /** Original RoomPlan capture request; persisted as capture-request.json. */
  capture_request: RoomPlanCaptureRequest;
  /** Pull raw bytes of a scene's captured-frame artifact from the durable store. */
  read_artifact_bytes: (scene_id: string, asset_id: string) => Buffer | null;
  /** Optional human-readable room label ("Living room"); shapes the fixture_id. */
  room_label: string | null;
  /** Repo root so we can write under fixtures/roomplan/. */
  repo_root: string;
  /** Wall-clock now; injectable for tests. */
  now: Date;
}

export interface FixturePromotionOutput {
  fixture_id: string;
  fixture_dir: string;
  /** Absolute path of the manifest file the promotion wrote to. */
  manifest_path: string;
  /** Whether an existing fixture with the same id was overwritten (idempotent re-run). */
  replaced_existing: boolean;
}

export class FixturePromotionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FixturePromotionError";
  }
}

/**
 * Copy a just-uploaded scene + captured frames into fixtures/roomplan/<id>/
 * matching the ARKitScenes-bedroom layout so the editor's fixture picker can
 * re-open it many times.
 *
 * Steps:
 *   1. Mint a human-readable fixture id from the room label + timestamp.
 *   2. Create fixture dir and copy each captured-frame asset under frames/.
 *   3. Rewrite the scene's captured_frames[].rgb.uri / depth.uri / confidence.uri
 *      so they point at /dev/fixtures/<id>/frames/<file>.
 *   4. Write scene.json + capture-request.json.
 *   5. Append/replace the entry in fixtures/manifest.json.
 */
export function promoteSceneToFixture(inputs: FixturePromotionInputs): FixturePromotionOutput {
  const fixtureId = mintFixtureId(inputs.room_label, inputs.scene.head.scene_id, inputs.now);
  const fixtureDir = resolve(inputs.repo_root, "fixtures", "roomplan", fixtureId);
  const framesDir = resolve(fixtureDir, "frames");
  mkdirSync(framesDir, { recursive: true });

  const rewritten = structuredClone(inputs.scene) as Scene;

  for (const frame of rewritten.captured_frames) {
    rewriteFrameAsset(frame, "rgb", framesDir, fixtureId, inputs);
    rewriteFrameAsset(frame, "depth", framesDir, fixtureId, inputs);
    if (frame.confidence) {
      rewriteFrameAsset(frame, "confidence", framesDir, fixtureId, inputs);
    }
  }

  const scenePath = resolve(fixtureDir, "scene.json");
  writeFileSync(scenePath, `${JSON.stringify(rewritten, null, 2)}\n`);

  const requestPath = resolve(fixtureDir, "capture-request.json");
  writeFileSync(requestPath, `${JSON.stringify(inputs.capture_request, null, 2)}\n`);

  const manifestPath = resolve(inputs.repo_root, "fixtures", "manifest.json");
  const replaced = appendFixtureToManifest(manifestPath, {
    fixture_id: fixtureId,
    request_path: `fixtures/roomplan/${fixtureId}/capture-request.json`,
    scene_path: `fixtures/roomplan/${fixtureId}/scene.json`,
    notes: buildNotes(inputs.room_label, inputs.now),
  });

  return {
    fixture_id: fixtureId,
    fixture_dir: fixtureDir,
    manifest_path: manifestPath,
    replaced_existing: replaced,
  };
}

type AssetField = "rgb" | "depth" | "confidence";

function rewriteFrameAsset(
  frame: CapturedFrame,
  field: AssetField,
  framesDir: string,
  fixtureId: string,
  inputs: FixturePromotionInputs
): void {
  const asset = frame[field];
  if (!asset) {
    return;
  }
  const bytes = inputs.read_artifact_bytes(frame.scene_id, asset.asset_id);
  if (!bytes) {
    throw new FixturePromotionError(
      `Missing ${field} artifact for frame ${frame.frame_id} (asset ${asset.asset_id}). Upload frames before finalizing.`
    );
  }
  const ext = fileExtensionFor(field, asset.content_type);
  const filename = `${frame.frame_id}.${field}.${ext}`;
  const outPath = resolve(framesDir, filename);
  writeFileSync(outPath, bytes);
  asset.uri = `/dev/fixtures/${fixtureId}/frames/${filename}`;
}

function fileExtensionFor(field: AssetField, contentType: string): string {
  if (field === "rgb") {
    if (contentType.includes("png")) return "png";
    return "jpg"; // JPEG is the default from iOS
  }
  // depth + confidence are numpy arrays
  return "npy";
}

function appendFixtureToManifest(manifestPath: string, entry: FixtureDescriptor): boolean {
  let manifest: FixtureManifest = { fixtures: [] };
  if (existsSync(manifestPath)) {
    const raw = readFileSync(manifestPath, "utf8");
    const parsed = JSON.parse(raw) as Partial<FixtureManifest>;
    if (Array.isArray(parsed.fixtures)) {
      manifest = { fixtures: parsed.fixtures };
    }
  }
  const existingIdx = manifest.fixtures.findIndex((f) => f.fixture_id === entry.fixture_id);
  const replaced = existingIdx >= 0;
  if (replaced) {
    manifest.fixtures[existingIdx] = entry;
  } else {
    manifest.fixtures.push(entry);
  }
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return replaced;
}

/**
 * Mint a stable, human-readable fixture id. Examples:
 *   capture-living-room-20260419-143022
 *   capture-20260419-143022-7a1b
 *
 * The slug makes the fixture picker scannable; the suffix keeps uniqueness
 * across same-name captures.
 */
export function mintFixtureId(label: string | null, sceneId: string, now: Date): string {
  const ts = formatTimestamp(now);
  const labelSlug = toSlug(label);
  if (labelSlug) {
    return `capture-${labelSlug}-${ts}`;
  }
  const tail = sceneId.replace(/[^a-z0-9]/gi, "").slice(-6).toLowerCase() || "scan";
  return `capture-${ts}-${tail}`;
}

function toSlug(label: string | null): string | null {
  if (!label) return null;
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
  return slug.length >= 2 ? slug : null;
}

function formatTimestamp(now: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  const y = now.getUTCFullYear();
  const m = pad(now.getUTCMonth() + 1);
  const d = pad(now.getUTCDate());
  const hh = pad(now.getUTCHours());
  const mm = pad(now.getUTCMinutes());
  const ss = pad(now.getUTCSeconds());
  return `${y}${m}${d}-${hh}${mm}${ss}`;
}

function buildNotes(label: string | null, now: Date): string {
  const trimmed = label?.trim();
  const iso = now.toISOString();
  if (trimmed && trimmed.length > 0) {
    return `iOS capture · ${trimmed} · ${iso}`;
  }
  return `iOS capture · ${iso}`;
}
