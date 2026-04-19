/**
 * Mock iPhone capture bundle builder.
 *
 * Takes real JPEG photos and wraps them in a Milestone 1 bundle with
 * synthesized ARKit-shaped evidence: plausible iPhone Pro intrinsics, a
 * gradient depth map at LiDAR resolution (256x192), high-confidence
 * confidence map, and a per-frame pose offset. The bundle layout matches
 * what ios/RoomViewCapture/Sources/RoomViewCapture/CaptureBundleWriter.swift
 * writes on device, so downstream tools (import-capture-bundle,
 * bundle-to-phase0) consume it without changes.
 *
 * Useful for driving the captured-views strip in the editor and exercising
 * the frames endpoint end-to-end before an iPhone app exists. The depth is
 * plumbing-mock — it matches the shape the API expects but carries no real
 * ARKit signal. For quality measurement you still need real scans.
 *
 * Usage:
 *   tsx scripts/mock-iphone-bundle.mts \
 *     --out <bundle-dir> \
 *     --photos <photo1.jpg> [<photo2.jpg> ...] \
 *     [--capture-id <id>] \
 *     [--depth-width 256 --depth-height 192]
 */
import { copyFileSync, mkdirSync, openSync, readFileSync, readSync, closeSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");

interface CliOptions {
  out_dir: string;
  photos: string[];
  capture_id: string;
  depth_width: number;
  depth_height: number;
}

function parseCli(argv: string[]): CliOptions {
  let outDir: string | null = null;
  const photos: string[] = [];
  let captureId = `mock-iphone-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  let depthWidth = 256;
  let depthHeight = 192;
  for (let index = 2; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--out") {
      outDir = argv[++index] ?? null;
      if (!outDir) throw new Error("--out requires a directory argument");
    } else if (flag === "--photos") {
      while (index + 1 < argv.length && !argv[index + 1]!.startsWith("--")) {
        photos.push(argv[++index]!);
      }
    } else if (flag === "--capture-id") {
      captureId = argv[++index] ?? captureId;
    } else if (flag === "--depth-width") {
      depthWidth = Number(argv[++index]);
      if (!Number.isFinite(depthWidth) || depthWidth <= 0) throw new Error("--depth-width must be positive");
    } else if (flag === "--depth-height") {
      depthHeight = Number(argv[++index]);
      if (!Number.isFinite(depthHeight) || depthHeight <= 0) throw new Error("--depth-height must be positive");
    } else if (flag === "--help" || flag === "-h") {
      process.stdout.write(
        "Usage: mock-iphone-bundle --out <dir> --photos <p1.jpg> [<p2.jpg> ...] [--capture-id <id>] [--depth-width 256 --depth-height 192]\n"
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${flag}`);
    }
  }
  if (!outDir) throw new Error("--out <dir> is required");
  if (photos.length === 0) throw new Error("--photos requires at least one photo path");
  return {
    out_dir: resolve(outDir),
    photos: photos.map((photo) => resolve(photo)),
    capture_id: captureId,
    depth_width: depthWidth,
    depth_height: depthHeight,
  };
}

/**
 * Probe a JPEG file for its pixel dimensions by walking markers until the
 * first Start-Of-Frame (SOFn). Avoids adding an image-parsing dependency.
 */
function probeJpegDimensions(path: string): { width: number; height: number } {
  const fd = openSync(path, "r");
  try {
    const header = Buffer.alloc(2);
    readSync(fd, header, 0, 2, 0);
    if (header[0] !== 0xff || header[1] !== 0xd8) {
      throw new Error(`${path} is not a JPEG (missing SOI marker)`);
    }
    let cursor = 2;
    const markerBuffer = Buffer.alloc(2);
    const lengthBuffer = Buffer.alloc(2);
    const sofBuffer = Buffer.alloc(5);
    while (true) {
      const markerRead = readSync(fd, markerBuffer, 0, 2, cursor);
      if (markerRead < 2 || markerBuffer[0] !== 0xff) {
        throw new Error(`${path}: unexpected end of JPEG stream`);
      }
      const marker = markerBuffer[1]!;
      cursor += 2;
      if (marker === 0xd8 || marker === 0xd9) continue;
      readSync(fd, lengthBuffer, 0, 2, cursor);
      const segmentLength = (lengthBuffer[0]! << 8) | lengthBuffer[1]!;
      const isSof =
        (marker >= 0xc0 && marker <= 0xc3) ||
        (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) ||
        (marker >= 0xcd && marker <= 0xcf);
      if (isSof) {
        readSync(fd, sofBuffer, 0, 5, cursor + 2);
        const height = (sofBuffer[1]! << 8) | sofBuffer[2]!;
        const width = (sofBuffer[3]! << 8) | sofBuffer[4]!;
        return { width, height };
      }
      cursor += segmentLength;
    }
  } finally {
    closeSync(fd);
  }
}

/** Linear gradient depth: ~0.8m at image bottom, ~4.5m at top. */
function synthesizeDepth(width: number, height: number, frameIndex: number): Buffer {
  const bytes = Buffer.alloc(width * height * 4);
  const near = 0.8 + frameIndex * 0.05;
  const far = 4.5 + frameIndex * 0.1;
  for (let row = 0; row < height; row += 1) {
    const normalized = height > 1 ? 1 - row / (height - 1) : 0.5;
    const depthValue = near + (far - near) * normalized;
    for (let col = 0; col < width; col += 1) {
      bytes.writeFloatLE(depthValue, (row * width + col) * 4);
    }
  }
  return bytes;
}

/** Uniform high-confidence (value 2) — matches ARKit's "confident" tier. */
function synthesizeConfidence(width: number, height: number): Buffer {
  return Buffer.alloc(width * height, 2);
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

/**
 * iPhone Pro wide-camera defaults: ~26mm equivalent, fx ≈ fy ≈ 1500 px at
 * ~4000x3000 sensor. The script scales fx/fy proportionally to the actual
 * image resolution so the derived vertical fov lands around 67°.
 */
function defaultIntrinsicsForImage(width: number, height: number) {
  const referenceWidth = 4032;
  const referenceFx = 1500;
  const fx = referenceFx * (width / referenceWidth);
  return {
    fx,
    fy: fx,
    cx: width / 2,
    cy: height / 2,
    width,
    height,
  };
}

function synthesizePose(frameIndex: number) {
  // Camera at standing height (~1.5m), stepping sideways 0.2m per frame and
  // rotating ~10° yaw per frame so each captured view is distinguishable.
  const identityColumns = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];
  return {
    camera_transform: [...identityColumns, frameIndex * 0.2, 1.5, -frameIndex * 0.1, 1],
    camera_pose: {
      position: { x: frameIndex * 0.2, y: 1.5, z: -frameIndex * 0.1 },
      yaw_degrees: frameIndex * 10,
    },
  };
}

function main(): void {
  const options = parseCli(process.argv);
  mkdirSync(resolve(options.out_dir, "frames"), { recursive: true });

  const frames: Array<Record<string, unknown>> = [];
  for (let index = 0; index < options.photos.length; index += 1) {
    const photoPath = options.photos[index]!;
    const ext = extname(photoPath).toLowerCase();
    if (ext !== ".jpg" && ext !== ".jpeg") {
      throw new Error(`mock-iphone-bundle only accepts .jpg/.jpeg today (got ${basename(photoPath)})`);
    }
    const dimensions = probeJpegDimensions(photoPath);
    const frameId = `frame_${String(index + 1).padStart(6, "0")}`;

    const rgbDest = `frames/${frameId}.jpg`;
    copyFileSync(photoPath, resolve(options.out_dir, rgbDest));

    const depthBytes = synthesizeDepth(options.depth_width, options.depth_height, index);
    const depthPath = `frames/${frameId}.depth.npy`;
    writeFileSync(
      resolve(options.out_dir, depthPath),
      encodeFloat32Npy(depthBytes, options.depth_width, options.depth_height)
    );

    const confidenceBytes = synthesizeConfidence(options.depth_width, options.depth_height);
    const confidencePath = `frames/${frameId}.confidence.npy`;
    writeFileSync(
      resolve(options.out_dir, confidencePath),
      encodeUInt8Npy(confidenceBytes, options.depth_width, options.depth_height)
    );

    const pose = synthesizePose(index);
    const posePath = `frames/${frameId}.pose.json`;
    writeFileSync(resolve(options.out_dir, posePath), `${JSON.stringify(pose, null, 2)}\n`);

    const intrinsics = defaultIntrinsicsForImage(dimensions.width, dimensions.height);
    const intrinsicsPath = `frames/${frameId}.intrinsics.json`;
    writeFileSync(
      resolve(options.out_dir, intrinsicsPath),
      `${JSON.stringify(intrinsics, null, 2)}\n`
    );

    const capturedAt = new Date(Date.UTC(2026, 3, 18, 12, index * 2, 0)).toISOString();
    frames.push({
      frame_id: frameId,
      captured_at: capturedAt,
      rgb_path: rgbDest,
      depth_path: depthPath,
      confidence_path: confidencePath,
      pose_path: posePath,
      intrinsics_path: intrinsicsPath,
    });

    process.stdout.write(
      `[mock-iphone-bundle]  ${frameId}: ${basename(photoPath)} ${dimensions.width}x${dimensions.height}\n`
    );
  }

  // Pull the bedroom-primary fixture as the RoomPlanCaptureRequest so the
  // bundle passes ingest validation. Stamp it with a unique
  // request_id/client_capture_id so repeated mock runs create fresh scenes.
  const fixtureRequest = JSON.parse(
    readFileSync(
      resolve(REPO_ROOT, "fixtures", "roomplan", "bedroom-primary", "capture-request.json"),
      "utf8"
    )
  ) as { request_id: string; client_capture_id: string };
  fixtureRequest.request_id = `mock-${options.capture_id}`;
  fixtureRequest.client_capture_id = `mock-${options.capture_id}`;
  writeFileSync(
    resolve(options.out_dir, "roomplan_request.json"),
    `${JSON.stringify(fixtureRequest, null, 2)}\n`
  );

  const manifest = {
    capture_id: options.capture_id,
    roomplan_request_path: "roomplan_request.json",
    frames,
  };
  writeFileSync(resolve(options.out_dir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

  process.stdout.write(
    `[mock-iphone-bundle] wrote ${options.photos.length} frame(s) to ${options.out_dir} (capture_id=${options.capture_id})\n`
  );
}

try {
  main();
} catch (error) {
  process.stderr.write(`[mock-iphone-bundle] FAIL: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
