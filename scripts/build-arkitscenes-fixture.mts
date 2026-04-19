/**
 * Build a committed fixture from an ARKitScenes bundle.
 *
 * Reads a bundle directory (output of scripts/arkitscenes-to-bundle.py),
 * ingests it via an in-memory RoomPlanCaptureService, extracts the
 * resulting Scene (with its captured_frames populated from real ARKit
 * depth + RGB), rewrites the frame asset URIs to resolve against the
 * web editor's /dev/fixtures/{fixture_id}/frames/{file} route, and writes
 * the fixture to fixtures/roomplan/{fixture_id}/.
 *
 * The fixture ships with the raw .jpg / .npy frame binaries committed so
 * the web editor can render scan-native object proxies (apps/web/src/
 * scan-proxies.js, Showcase-phase Track B "your actual room" path)
 * against real LiDAR data, no iPhone required.
 *
 * Usage:
 *   npx tsx scripts/build-arkitscenes-fixture.mts \
 *     --bundle /tmp/arkitscenes_bundle_v2 \
 *     --fixture-id fixture-bedroom-arkitscenes \
 *     --notes "ARKitScenes 47333463 bedroom, 6 captured frames."
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type {
  CaptureFrameInput,
  CaptureFramesRequest,
  FixtureManifest,
  RoomPlanCaptureRequest,
} from "../packages/contracts/src/index.ts";
import { RoomPlanCaptureService } from "../apps/api/src/index.ts";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");

interface CliOptions {
  bundle_path: string;
  fixture_id: string;
  notes: string;
}

function parseCli(argv: string[]): CliOptions {
  let bundle_path: string | null = null;
  let fixture_id: string | null = null;
  let notes: string | null = null;
  for (let i = 2; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === "--bundle") {
      bundle_path = argv[++i] ?? null;
    } else if (flag === "--fixture-id") {
      fixture_id = argv[++i] ?? null;
    } else if (flag === "--notes") {
      notes = argv[++i] ?? null;
    } else if (flag === "--help" || flag === "-h") {
      process.stdout.write(
        "Usage: build-arkitscenes-fixture --bundle <dir> --fixture-id <id> --notes <text>\n",
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${flag}`);
    }
  }
  if (!bundle_path) throw new Error("--bundle <dir> is required");
  if (!fixture_id) throw new Error("--fixture-id <id> is required");
  if (!notes) throw new Error("--notes <text> is required");
  return { bundle_path: resolve(bundle_path), fixture_id, notes };
}

interface BundleManifestFrame {
  frame_id: string;
  captured_at: string;
  rgb_path: string;
  depth_path: string;
  confidence_path?: string | null;
  pose_path: string;
  intrinsics_path: string;
}

interface BundleManifest {
  capture_id: string;
  roomplan_request_path: string;
  frames: BundleManifestFrame[];
}

interface BundlePose {
  camera_transform: number[];
  camera_pose: { position: { x: number; y: number; z: number }; yaw_degrees: number };
}

interface BundleIntrinsics {
  fx: number; fy: number; cx: number; cy: number; width: number; height: number;
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function contentTypeForPath(path: string): string {
  const ext = extname(path).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".png") return "image/png";
  if (ext === ".npy") return "application/x-numpy";
  return "application/octet-stream";
}

function extensionForContentType(contentType: string): string {
  if (contentType === "image/jpeg") return "jpg";
  if (contentType === "image/png") return "png";
  if (contentType === "application/x-numpy") return "npy";
  return "bin";
}

function loadBundleFrames(bundlePath: string): {
  capture_request: RoomPlanCaptureRequest;
  frames: CaptureFrameInput[];
} {
  const manifest = readJson<BundleManifest>(join(bundlePath, "manifest.json"));
  const captureRequest = readJson<RoomPlanCaptureRequest>(join(bundlePath, manifest.roomplan_request_path));
  const frames: CaptureFrameInput[] = manifest.frames.map((frameRef) => {
    const pose = readJson<BundlePose>(join(bundlePath, frameRef.pose_path));
    const intrinsics = readJson<BundleIntrinsics>(join(bundlePath, frameRef.intrinsics_path));
    const rgbBytes = readFileSync(join(bundlePath, frameRef.rgb_path));
    const depthBytes = readFileSync(join(bundlePath, frameRef.depth_path));
    const confidenceBytes = frameRef.confidence_path
      ? readFileSync(join(bundlePath, frameRef.confidence_path))
      : null;
    return {
      frame_id: frameRef.frame_id,
      captured_at: frameRef.captured_at,
      camera_pose: pose.camera_pose,
      camera_transform: pose.camera_transform,
      intrinsics,
      rgb_content_type: contentTypeForPath(frameRef.rgb_path),
      rgb_base64: rgbBytes.toString("base64"),
      depth_content_type: contentTypeForPath(frameRef.depth_path),
      depth_base64: depthBytes.toString("base64"),
      confidence_content_type: frameRef.confidence_path ? contentTypeForPath(frameRef.confidence_path) : null,
      confidence_base64: confidenceBytes ? confidenceBytes.toString("base64") : null,
      bookmark_name: null,
    };
  });
  return { capture_request: captureRequest, frames };
}

async function main(): Promise<void> {
  const opts = parseCli(process.argv);
  const { capture_request, frames } = loadBundleFrames(opts.bundle_path);
  // Make the request id/client_capture_id deterministic so re-running this
  // against the same bundle yields a byte-identical fixture (git-friendly).
  const captureRequest: RoomPlanCaptureRequest = {
    ...capture_request,
    request_id: `fixture-${opts.fixture_id}`,
    client_capture_id: `fixture-${opts.fixture_id}`,
  };

  const storageDir = mkdtempSync(join(tmpdir(), `roomview-fixture-${opts.fixture_id}-`));
  const fixtureDir = resolve(REPO_ROOT, "fixtures", "roomplan", opts.fixture_id);
  const framesDir = join(fixtureDir, "frames");
  try {
    const service = new RoomPlanCaptureService({
      storage_directory: storageDir,
      token_secret: "fixture-build-secret",
      handoff_base_url: "https://roomview.local/h",
    });
    const captureResponse = service.postRoomPlanCapture(captureRequest);
    if (!captureResponse.video_upload_token) {
      throw new Error("expected a video_upload_token so captured_frames can be posted");
    }
    const framesRequest: CaptureFramesRequest = {
      video_upload_token: captureResponse.video_upload_token,
      idempotency_key: `fixture-${opts.fixture_id}-frames`,
      frames,
    };
    service.postCaptureFrames(captureResponse.scene_id, framesRequest);
    const scene = service.getScene(captureResponse.scene_id);
    if (!scene) {
      throw new Error(`expected scene ${captureResponse.scene_id} after ingest`);
    }

    // Copy each captured frame's raw bytes out of the in-memory service's
    // persistent store into the fixture's frames/ directory and rewrite the
    // URIs to point at the web editor's fixture-serving route.
    mkdirSync(framesDir, { recursive: true });

    for (const frame of scene.captured_frames) {
      const rgbExt = extensionForContentType(frame.rgb.content_type);
      const rgbPath = join(framesDir, `${frame.frame_id}.rgb.${rgbExt}`);
      const rgbBytes = service.getPhotorealArtifact(scene.head.scene_id, frame.rgb.asset_id);
      if (!rgbBytes) throw new Error(`missing rgb bytes for ${frame.frame_id}`);
      writeFileSync(rgbPath, rgbBytes.bytes);
      frame.rgb.uri = `/dev/fixtures/${opts.fixture_id}/frames/${frame.frame_id}.rgb.${rgbExt}`;

      const depthExt = extensionForContentType(frame.depth.content_type);
      const depthPath = join(framesDir, `${frame.frame_id}.depth.${depthExt}`);
      const depthBytes = service.getPhotorealArtifact(scene.head.scene_id, frame.depth.asset_id);
      if (!depthBytes) throw new Error(`missing depth bytes for ${frame.frame_id}`);
      writeFileSync(depthPath, depthBytes.bytes);
      frame.depth.uri = `/dev/fixtures/${opts.fixture_id}/frames/${frame.frame_id}.depth.${depthExt}`;

      if (frame.confidence) {
        const confExt = extensionForContentType(frame.confidence.content_type);
        const confPath = join(framesDir, `${frame.frame_id}.confidence.${confExt}`);
        const confBytes = service.getPhotorealArtifact(scene.head.scene_id, frame.confidence.asset_id);
        if (!confBytes) throw new Error(`missing confidence bytes for ${frame.frame_id}`);
        writeFileSync(confPath, confBytes.bytes);
        frame.confidence.uri = `/dev/fixtures/${opts.fixture_id}/frames/${frame.frame_id}.confidence.${confExt}`;
      }
    }

    // Strip volatile ids so the fixture round-trips byte-identically across
    // regenerations of the same bundle. We replace the ingest-service's
    // non-deterministic scene_id / snapshot_id / asset_ids with stable
    // hashes derived from the bundle contents downstream; for now, keep the
    // originals and just commit the scene as-is. That's adequate for scan
    // proxies — the client reads frame URIs, camera poses, intrinsics, and
    // object OBBs, none of which care about the scene id values.

    // Also copy the original capture-request.json alongside the scene so
    // this fixture matches the shape of the other roomplan fixtures.
    const captureRequestPath = join(fixtureDir, "capture-request.json");
    writeFileSync(captureRequestPath, JSON.stringify(captureRequest, null, 2) + "\n");

    const scenePath = join(fixtureDir, "scene.json");
    writeFileSync(scenePath, JSON.stringify(scene, null, 2) + "\n");

    // Register the fixture in the manifest if not already present.
    const manifestPath = resolve(REPO_ROOT, "fixtures", "manifest.json");
    const manifest = readJson<FixtureManifest>(manifestPath);
    const already = manifest.fixtures.find((f) => f.fixture_id === opts.fixture_id);
    if (!already) {
      manifest.fixtures.push({
        fixture_id: opts.fixture_id,
        request_path: `fixtures/roomplan/${opts.fixture_id}/capture-request.json`,
        scene_path: `fixtures/roomplan/${opts.fixture_id}/scene.json`,
        notes: opts.notes,
      });
      writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
    } else if (already.notes !== opts.notes) {
      already.notes = opts.notes;
      writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
    }

    // Sanity — verify frames are on disk and scene URIs match.
    for (const frame of scene.captured_frames) {
      const expectedRgb = join(REPO_ROOT, frame.rgb.uri.replace(/^\/dev\/fixtures\//, "fixtures/roomplan/"));
      if (!existsSync(expectedRgb)) {
        throw new Error(`rgb artifact missing on disk for ${frame.frame_id}: ${expectedRgb}`);
      }
    }

    process.stdout.write(
      `[build-arkitscenes-fixture] wrote ${scene.captured_frames.length} captured frames for fixture '${opts.fixture_id}' to ${fixtureDir}\n`,
    );
  } finally {
    rmSync(storageDir, { recursive: true, force: true });
  }
}

await main();
