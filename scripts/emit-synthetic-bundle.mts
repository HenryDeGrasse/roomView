/**
 * Emit a synthetic Milestone 1 capture bundle to disk.
 *
 * Used to exercise downstream tooling (bundle-to-phase0, the render bench,
 * future import scripts) before a real iPhone bundle is available. The output
 * layout matches what ios/RoomViewCapture/Sources/RoomViewCapture/
 * CaptureBundleWriter.swift produces on device:
 *
 *   <out>/
 *     manifest.json
 *     roomplan_request.json
 *     frames/
 *       frame_000001.jpg
 *       frame_000001.depth.npy
 *       frame_000001.confidence.npy
 *       frame_000001.pose.json
 *       frame_000001.intrinsics.json
 *       ...
 *
 * Depth is `.npy` float32 meters, confidence is `.npy` uint8 (ARKit 0/1/2).
 * RGB is a minimal JPEG so downstream tools that only check magic bytes pass;
 * real content isn't needed for plumbing validation.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { RoomPlanCaptureRequest } from "../packages/contracts/src/index.ts";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");

function parseCli(argv: string[]): { out_dir: string; frame_count: number; capture_id: string } {
  let outDir: string | null = null;
  let frameCount = 3;
  let captureId = `synthetic-bundle-${Date.now()}`;
  for (let index = 2; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--out") {
      outDir = argv[++index] ?? null;
      if (!outDir) throw new Error("--out requires a directory argument");
    } else if (flag === "--frames") {
      const raw = argv[++index];
      if (!raw) throw new Error("--frames requires a count");
      frameCount = Number(raw);
      if (!Number.isFinite(frameCount) || frameCount <= 0 || frameCount > 32) {
        throw new Error("--frames must be between 1 and 32");
      }
    } else if (flag === "--capture-id") {
      captureId = argv[++index] ?? captureId;
    } else if (flag === "--help" || flag === "-h") {
      process.stdout.write(
        "Usage: emit-synthetic-bundle --out <dir> [--frames N] [--capture-id ID]\n"
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${flag}`);
    }
  }
  if (!outDir) throw new Error("--out <dir> is required");
  return { out_dir: resolve(outDir), frame_count: frameCount, capture_id: captureId };
}

function encodeFloat32Npy(bytes: Buffer, width: number, height: number): Buffer {
  return encodeNpy("<f4", width, height, bytes);
}

function encodeUInt8Npy(bytes: Buffer, width: number, height: number): Buffer {
  return encodeNpy("|u1", width, height, bytes);
}

function encodeNpy(descriptor: string, width: number, height: number, bytes: Buffer): Buffer {
  const magic = Buffer.from([0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59]);
  const major = Buffer.from([0x01, 0x00]);
  const headerBody = `{'descr': '${descriptor}', 'fortran_order': False, 'shape': (${height}, ${width}), }`;
  const prefixLength = magic.length + major.length + 2;
  const rawHeaderLength = prefixLength + headerBody.length + 1;
  const paddedTotal = Math.ceil(rawHeaderLength / 64) * 64;
  const paddingCount = Math.max(0, paddedTotal - prefixLength - headerBody.length - 1);
  const headerAscii = headerBody + " ".repeat(paddingCount) + "\n";
  const headerData = Buffer.from(headerAscii, "ascii");
  const headerLen = Buffer.alloc(2);
  headerLen.writeUInt16LE(headerData.length, 0);
  return Buffer.concat([magic, major, headerLen, headerData, bytes]);
}

function syntheticDepth(width: number, height: number, frameIndex: number): Buffer {
  const out = Buffer.alloc(width * height * 4);
  for (let row = 0; row < height; row += 1) {
    for (let col = 0; col < width; col += 1) {
      const index = row * width + col;
      const value = 1.0 + 0.05 * (row + col) + 0.1 * frameIndex;
      out.writeFloatLE(value, index * 4);
    }
  }
  return out;
}

function syntheticConfidence(width: number, height: number): Buffer {
  return Buffer.from(Array.from({ length: width * height }, (_v, idx) => (idx % 3) as number));
}

const MINIMAL_JPEG_BYTES = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01,
  0x00, 0x01, 0x00, 0x00, 0xff, 0xdb, 0x00, 0x43, 0x00, 0x08, 0x06, 0x06, 0x07, 0x06, 0x05, 0x08,
  0x07, 0x07, 0x07, 0x09, 0x09, 0x08, 0x0a, 0x0c, 0x14, 0x0d, 0x0c, 0x0b, 0x0b, 0x0c, 0x19, 0x12,
  0x13, 0x0f, 0x14, 0x1d, 0x1a, 0x1f, 0x1e, 0x1d, 0x1a, 0x1c, 0x1c, 0x20, 0x24, 0x2e, 0x27, 0x20,
  0x22, 0x2c, 0x23, 0x1c, 0x1c, 0x28, 0x37, 0x29, 0x2c, 0x30, 0x31, 0x34, 0x34, 0x34, 0x1f, 0x27,
  0x39, 0x3d, 0x38, 0x32, 0x3c, 0x2e, 0x33, 0x34, 0x32, 0xff, 0xd9,
]);

function loadFixtureRoomplanRequest(): RoomPlanCaptureRequest {
  const body = readFileSync(
    resolve(REPO_ROOT, "fixtures", "roomplan", "bedroom-primary", "capture-request.json"),
    "utf8"
  );
  return JSON.parse(body) as RoomPlanCaptureRequest;
}

function main(): void {
  const options = parseCli(process.argv);
  mkdirSync(resolve(options.out_dir, "frames"), { recursive: true });

  const roomplanRequest = loadFixtureRoomplanRequest();
  roomplanRequest.request_id = `synthetic-${options.capture_id}`;
  roomplanRequest.client_capture_id = `synthetic-${options.capture_id}`;
  writeFileSync(
    resolve(options.out_dir, "roomplan_request.json"),
    `${JSON.stringify(roomplanRequest, null, 2)}\n`
  );

  const depthWidth = 8;
  const depthHeight = 6;
  const frames: Array<Record<string, unknown>> = [];
  for (let index = 0; index < options.frame_count; index += 1) {
    const frameId = `frame_${String(index + 1).padStart(6, "0")}`;
    const capturedAt = new Date(Date.UTC(2026, 3, 18, 12, index, 0)).toISOString();

    writeFileSync(resolve(options.out_dir, `frames/${frameId}.jpg`), MINIMAL_JPEG_BYTES);

    const depthBytes = syntheticDepth(depthWidth, depthHeight, index);
    writeFileSync(
      resolve(options.out_dir, `frames/${frameId}.depth.npy`),
      encodeFloat32Npy(depthBytes, depthWidth, depthHeight)
    );

    const confidenceBytes = syntheticConfidence(depthWidth, depthHeight);
    writeFileSync(
      resolve(options.out_dir, `frames/${frameId}.confidence.npy`),
      encodeUInt8Npy(confidenceBytes, depthWidth, depthHeight)
    );

    const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];
    const pose = {
      camera_transform: [...identity, index * 0.2, 1.5, -index * 0.1, 1],
      camera_pose: {
        position: { x: index * 0.2, y: 1.5, z: -index * 0.1 },
        yaw_degrees: index * 10,
      },
    };
    writeFileSync(resolve(options.out_dir, `frames/${frameId}.pose.json`), `${JSON.stringify(pose, null, 2)}\n`);

    const intrinsics = {
      fx: 1450,
      fy: 1450,
      cx: depthWidth / 2,
      cy: depthHeight / 2,
      width: depthWidth,
      height: depthHeight,
    };
    writeFileSync(
      resolve(options.out_dir, `frames/${frameId}.intrinsics.json`),
      `${JSON.stringify(intrinsics, null, 2)}\n`
    );

    frames.push({
      frame_id: frameId,
      captured_at: capturedAt,
      rgb_path: `frames/${frameId}.jpg`,
      depth_path: `frames/${frameId}.depth.npy`,
      confidence_path: `frames/${frameId}.confidence.npy`,
      pose_path: `frames/${frameId}.pose.json`,
      intrinsics_path: `frames/${frameId}.intrinsics.json`,
    });
  }

  const manifest = {
    capture_id: options.capture_id,
    roomplan_request_path: "roomplan_request.json",
    frames,
  };
  writeFileSync(resolve(options.out_dir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

  process.stdout.write(
    `[emit-synthetic-bundle] wrote ${options.frame_count} frame(s) to ${options.out_dir}\n`
  );
}

main();
