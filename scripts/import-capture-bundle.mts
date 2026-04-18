import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type {
  CaptureFrameInput,
  CaptureFramesRequest,
  RoomPlanCaptureRequest,
} from "../packages/contracts/src/index.ts";
import { RoomPlanCaptureService } from "../apps/api/src/index.ts";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");

interface CliOptions {
  mode: "synthetic" | "bundle";
  bundle_path: string | null;
  api_base_url: string | null;
}

function parseCli(argv: string[]): CliOptions {
  let mode: CliOptions["mode"] = "synthetic";
  let bundlePath: string | null = null;
  let apiBaseUrl: string | null = null;
  for (let index = 2; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--synthetic") {
      mode = "synthetic";
    } else if (flag === "--bundle") {
      mode = "bundle";
      bundlePath = argv[++index] ?? null;
      if (!bundlePath) {
        throw new Error("--bundle requires a path argument.");
      }
    } else if (flag === "--api-base-url") {
      apiBaseUrl = argv[++index] ?? null;
      if (!apiBaseUrl) {
        throw new Error("--api-base-url requires a URL argument.");
      }
    } else if (flag === "--help" || flag === "-h") {
      process.stdout.write(
        [
          "Usage: import-capture-bundle --synthetic",
          "       import-capture-bundle --bundle <path> [--api-base-url http://127.0.0.1:3000]",
          "",
          "Synthetic mode verifies the ingest pipeline against an in-memory service.",
          "Bundle mode reads a capture-bundle/ directory produced by the iPhone app.",
        ].join("\n") + "\n"
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${flag}`);
    }
  }
  return { mode, bundle_path: bundlePath, api_base_url: apiBaseUrl };
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
  fx: number;
  fy: number;
  cx: number;
  cy: number;
  width: number;
  height: number;
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function contentTypeForPath(path: string): string {
  const ext = extname(path).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".png") return "image/png";
  if (ext === ".npy") return "application/x-numpy";
  if (ext === ".bin") return "application/octet-stream";
  return "application/octet-stream";
}

function loadBundle(bundlePath: string): {
  capture_request: RoomPlanCaptureRequest;
  frames: CaptureFrameInput[];
} {
  const manifestPath = join(bundlePath, "manifest.json");
  if (!existsSync(manifestPath)) {
    throw new Error(`Bundle manifest not found at ${manifestPath}`);
  }
  const manifest = readJson<BundleManifest>(manifestPath);
  const captureRequest = readJson<RoomPlanCaptureRequest>(join(bundlePath, manifest.roomplan_request_path));
  const frames: CaptureFrameInput[] = manifest.frames.map((frameRef) => {
    const pose = readJson<BundlePose>(join(bundlePath, frameRef.pose_path));
    const intrinsics = readJson<BundleIntrinsics>(join(bundlePath, frameRef.intrinsics_path));
    const rgbBytes = readFileSync(join(bundlePath, frameRef.rgb_path));
    const depthBytes = readFileSync(join(bundlePath, frameRef.depth_path));
    const confidenceBytes = frameRef.confidence_path ? readFileSync(join(bundlePath, frameRef.confidence_path)) : null;
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

function buildSyntheticFrames(): CaptureFrameInput[] {
  const jpegMagic = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
  const width = 4;
  const height = 3;
  const depthBuffer = Buffer.alloc(width * height * 4);
  for (let index = 0; index < width * height; index += 1) {
    depthBuffer.writeFloatLE(1.0 + index * 0.05, index * 4);
  }
  const confidenceBuffer = Buffer.from([0, 1, 2, 2, 1, 0, 1, 2, 2, 1, 0, 1]);

  const framePrototype: Omit<CaptureFrameInput, "frame_id" | "captured_at" | "camera_transform" | "camera_pose"> = {
    intrinsics: { fx: 1450, fy: 1450, cx: width / 2, cy: height / 2, width, height },
    rgb_content_type: "image/jpeg",
    rgb_base64: jpegMagic.toString("base64"),
    depth_content_type: "application/x-numpy",
    depth_base64: depthBuffer.toString("base64"),
    confidence_content_type: "application/octet-stream",
    confidence_base64: confidenceBuffer.toString("base64"),
    bookmark_name: null,
  };

  const identityTransform = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  return [0, 1, 2].map((index) => ({
    frame_id: `frame_${String(index + 1).padStart(4, "0")}`,
    captured_at: new Date(Date.UTC(2026, 3, 18, 12, 0, index * 5)).toISOString(),
    camera_transform: [
      ...identityTransform.slice(0, 12),
      index * 0.2,
      1.5,
      -index * 0.1,
      1,
    ],
    camera_pose: {
      position: { x: index * 0.2, y: 1.5, z: -index * 0.1 },
      yaw_degrees: index * 10,
    },
    ...framePrototype,
  }));
}

function loadFixtureCaptureRequest(): RoomPlanCaptureRequest {
  const fixturePath = resolve(REPO_ROOT, "fixtures", "roomplan", "bedroom-primary", "capture-request.json");
  const request = readJson<RoomPlanCaptureRequest>(fixturePath);
  request.request_id = `capture-bundle-verify-${Date.now()}`;
  request.client_capture_id = `capture-bundle-verify-${Date.now()}`;
  return request;
}

interface ServiceRunResult {
  scene_id: string;
  captured_frame_count: number;
  bookmark_count: number;
}

async function runAgainstService(
  captureRequest: RoomPlanCaptureRequest,
  frames: CaptureFrameInput[]
): Promise<ServiceRunResult> {
  const storageDir = mkdtempSync(join(tmpdir(), "roomview-capture-bundle-"));
  try {
    const service = new RoomPlanCaptureService({
      storage_directory: storageDir,
      token_secret: "capture-bundle-verify-secret",
      handoff_base_url: "https://roomview.local/h",
    });
    const captureResponse = service.postRoomPlanCapture(captureRequest);
    assert.ok(captureResponse.scene_id, "expected scene_id in capture response");
    assert.ok(captureResponse.video_upload_token, "expected video_upload_token in capture response");

    const framesRequest: CaptureFramesRequest = {
      video_upload_token: captureResponse.video_upload_token,
      idempotency_key: `capture-bundle-verify-${captureResponse.scene_id}`,
      frames,
    };
    const framesResponse = service.postCaptureFrames(captureResponse.scene_id, framesRequest);
    assert.equal(
      framesResponse.captured_frames.length,
      frames.length,
      `expected ${frames.length} frames ingested`
    );

    for (const [index, ingestedFrame] of framesResponse.captured_frames.entries()) {
      const inputFrame = frames[index];
      assert.ok(inputFrame, `missing input frame at index ${index}`);
      assert.equal(ingestedFrame.frame_id, inputFrame.frame_id, "frame_id round-trips");
      assert.ok(ingestedFrame.bookmark_id, "bookmark_id materialized");
      assert.ok(ingestedFrame.rgb.asset_id, "rgb asset_id set");
      assert.ok(ingestedFrame.rgb.uri.startsWith("/artifacts/photoreal/"), "rgb uri is artifact-prefixed");
      assert.ok(ingestedFrame.depth.uri.startsWith("/artifacts/photoreal/"), "depth uri is artifact-prefixed");
      if (inputFrame.confidence_base64) {
        assert.ok(ingestedFrame.confidence, "confidence persisted when provided");
      }

      const rgbAsset = service.getPhotorealArtifact(
        ingestedFrame.scene_id,
        ingestedFrame.rgb.asset_id
      );
      assert.ok(rgbAsset, "rgb artifact readable from store");
      const expectedRgbBytes = Buffer.from(inputFrame.rgb_base64, "base64");
      assert.equal(rgbAsset.bytes.length, expectedRgbBytes.length, "rgb byte length matches input");

      const depthAsset = service.getPhotorealArtifact(
        ingestedFrame.scene_id,
        ingestedFrame.depth.asset_id
      );
      assert.ok(depthAsset, "depth artifact readable from store");
      const expectedDepthBytes = Buffer.from(inputFrame.depth_base64, "base64");
      assert.equal(depthAsset.bytes.length, expectedDepthBytes.length, "depth byte length matches input");
    }

    const scene = service.getScene(captureResponse.scene_id);
    assert.ok(scene, "scene retrievable after ingest");
    assert.equal(scene.captured_frames.length, frames.length, "scene.captured_frames populated");
    const newBookmarkIds = new Set(framesResponse.captured_frames.map((frame) => frame.bookmark_id));
    const bookmarksMatched = scene.bookmarks.filter((bookmark) => newBookmarkIds.has(bookmark.bookmark_id)).length;
    assert.equal(bookmarksMatched, frames.length, "one CameraBookmark materialized per frame");

    const replayResponse = service.postCaptureFrames(captureResponse.scene_id, framesRequest);
    assert.equal(replayResponse.captured_frames.length, frames.length, "idempotent replay returns same captured_frames");
    const postReplayScene = service.getScene(captureResponse.scene_id);
    assert.ok(postReplayScene);
    assert.equal(
      postReplayScene.captured_frames.length,
      frames.length,
      "idempotent replay does not duplicate captured_frames"
    );

    const hydrated = new RoomPlanCaptureService({
      storage_directory: storageDir,
      token_secret: "capture-bundle-verify-secret",
      handoff_base_url: "https://roomview.local/h",
    });
    const hydratedScene = hydrated.getScene(captureResponse.scene_id);
    assert.ok(hydratedScene, "scene hydrates from durable storage");
    assert.equal(
      hydratedScene.captured_frames.length,
      frames.length,
      "captured_frames survive hydration from disk"
    );

    return {
      scene_id: captureResponse.scene_id,
      captured_frame_count: scene.captured_frames.length,
      bookmark_count: bookmarksMatched,
    };
  } finally {
    rmSync(storageDir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const options = parseCli(process.argv);
  if (options.api_base_url) {
    throw new Error("HTTP mode is not supported yet. Use in-process verification.");
  }

  const { capture_request, frames } = options.mode === "bundle" && options.bundle_path
    ? loadBundle(options.bundle_path)
    : { capture_request: loadFixtureCaptureRequest(), frames: buildSyntheticFrames() };

  process.stdout.write(
    `[import-capture-bundle] mode=${options.mode} frames=${frames.length} ${
      options.bundle_path ? `bundle=${basename(options.bundle_path)}` : "source=fixture"
    }\n`
  );

  const result = await runAgainstService(capture_request, frames);
  process.stdout.write(
    `[import-capture-bundle] ok scene_id=${result.scene_id} captured_frames=${result.captured_frame_count} bookmarks=${result.bookmark_count}\n`
  );
}

main().catch((error) => {
  process.stderr.write(`[import-capture-bundle] FAIL: ${error instanceof Error ? error.message : String(error)}\n`);
  if (error instanceof Error && error.stack) {
    process.stderr.write(`${error.stack}\n`);
  }
  process.exit(1);
});
