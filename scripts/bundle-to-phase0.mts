/**
 * Convert a Milestone 1 capture bundle (iOS CaptureBundleWriter output) into a
 * Phase 0 render-bench room directory under experiments/phase0/rooms/<room-id>/.
 *
 * Milestone 1 and Phase 0 use different manifest shapes because they serve
 * different purposes: the Milestone 1 bundle is the upload payload to the API;
 * the Phase 0 bundle is what scripts/phase0-render-bench.py discovers and
 * renders against. This converter bridges them so a real iPhone scan can be
 * dropped into the bench with one command.
 *
 * Usage:
 *   tsx scripts/bundle-to-phase0.mts \
 *     --bundle <path/to/capture-bundle> \
 *     --room-id <phase0-room-id> \
 *     [--cases <cases.json>] \
 *     [--primary-frame-id frame_000001]
 *
 * If --cases is omitted, a copy of experiments/phase0/templates/cases.example.json
 * is dropped in. Files are copied, not symlinked, so the Phase 0 room dir is
 * self-contained.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");
const DEFAULT_CASES_TEMPLATE = resolve(REPO_ROOT, "experiments/phase0/templates/cases.example.json");

interface CliOptions {
  bundle_dir: string;
  room_id: string;
  rooms_root: string;
  cases_path: string | null;
  primary_frame_id: string | null;
}

function parseCli(argv: string[]): CliOptions {
  let bundleDir: string | null = null;
  let roomId: string | null = null;
  let casesPath: string | null = null;
  let primaryFrameId: string | null = null;
  let roomsRoot: string | null = null;
  for (let index = 2; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--bundle") bundleDir = argv[++index] ?? null;
    else if (flag === "--room-id") roomId = argv[++index] ?? null;
    else if (flag === "--cases") casesPath = argv[++index] ?? null;
    else if (flag === "--primary-frame-id") primaryFrameId = argv[++index] ?? null;
    else if (flag === "--rooms-dir") roomsRoot = argv[++index] ?? null;
    else if (flag === "--help" || flag === "-h") {
      process.stdout.write(
        "Usage: bundle-to-phase0 --bundle <path> --room-id <id> [--cases <cases.json>] [--primary-frame-id <frame_id>] [--rooms-dir <path>]\n"
      );
      process.exit(0);
    } else throw new Error(`Unknown argument: ${flag}`);
  }
  if (!bundleDir) throw new Error("--bundle <path> is required");
  if (!roomId) throw new Error("--room-id <id> is required");
  return {
    bundle_dir: resolve(bundleDir),
    room_id: roomId,
    rooms_root: resolve(roomsRoot ?? resolve(REPO_ROOT, "experiments/phase0/rooms")),
    cases_path: casesPath ? resolve(casesPath) : null,
    primary_frame_id: primaryFrameId,
  };
}

interface BundleManifest {
  capture_id: string;
  roomplan_request_path: string;
  frames: Array<{
    frame_id: string;
    captured_at: string;
    rgb_path: string;
    depth_path: string;
    confidence_path?: string | null;
    pose_path: string;
    intrinsics_path: string;
  }>;
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function main(): void {
  const options = parseCli(process.argv);
  const manifestPath = resolve(options.bundle_dir, "manifest.json");
  if (!existsSync(manifestPath)) {
    throw new Error(`manifest.json not found at ${manifestPath}`);
  }
  const manifest = readJson<BundleManifest>(manifestPath);

  const roomDir = resolve(options.rooms_root, options.room_id);
  mkdirSync(resolve(roomDir, "frames"), { recursive: true });

  const primaryFrameId = options.primary_frame_id ?? manifest.frames[0]?.frame_id;
  if (!primaryFrameId) {
    throw new Error("Bundle has no frames to convert.");
  }

  const phase0Frames = manifest.frames.map((frame) => {
    const rgbDest = `frames/${frame.frame_id}${extensionFrom(frame.rgb_path)}`;
    const depthDest = `frames/${frame.frame_id}${extensionFrom(frame.depth_path, ".depth")}`;
    const poseDest = `frames/${frame.frame_id}.pose.json`;
    const intrinsicsDest = `frames/${frame.frame_id}.intrinsics.json`;

    copyFileSync(resolve(options.bundle_dir, frame.rgb_path), resolve(roomDir, rgbDest));
    copyFileSync(resolve(options.bundle_dir, frame.depth_path), resolve(roomDir, depthDest));
    copyFileSync(resolve(options.bundle_dir, frame.pose_path), resolve(roomDir, poseDest));
    copyFileSync(resolve(options.bundle_dir, frame.intrinsics_path), resolve(roomDir, intrinsicsDest));

    const tags = frame.frame_id === primaryFrameId
      ? ["captured", "primary_reference"]
      : ["captured"];

    return {
      frame_id: frame.frame_id,
      rgb_uri: rgbDest,
      depth_uri: depthDest,
      pose_uri: poseDest,
      intrinsics_uri: intrinsicsDest,
      tags,
    };
  });

  const phase0Manifest = {
    schema_version: "phase0_capture_bundle/v0",
    capture_id: manifest.capture_id,
    room_id: options.room_id,
    primary_frame_id: primaryFrameId,
    device: { model: "iPhone Pro", has_lidar: true },
    roomplan_raw_uri: "roomplan_raw.json",
    frames: phase0Frames,
  };
  writeFileSync(resolve(roomDir, "manifest.json"), `${JSON.stringify(phase0Manifest, null, 2)}\n`);

  const roomplanSourcePath = resolve(options.bundle_dir, manifest.roomplan_request_path);
  if (existsSync(roomplanSourcePath)) {
    copyFileSync(roomplanSourcePath, resolve(roomDir, "roomplan_raw.json"));
  }

  const casesSource = options.cases_path ?? DEFAULT_CASES_TEMPLATE;
  if (!existsSync(casesSource)) {
    throw new Error(`Cases file not found: ${casesSource}`);
  }
  // Rewire reference_frame_id values in the cases file to point at frames
  // that actually exist in this bundle. The template uses example IDs like
  // "frame_front" / "frame_corner" that won't match real captures.
  const bundleFrameIds = new Set(manifest.frames.map((frame) => frame.frame_id));
  const casesRaw = readJson<{
    default_negative_prompt?: string;
    cases: Array<{ reference_frame_id: string;[key: string]: unknown }>;
  }>(casesSource);
  const rewiredCases = casesRaw.cases.map((entry) => ({
    ...entry,
    reference_frame_id: bundleFrameIds.has(entry.reference_frame_id)
      ? entry.reference_frame_id
      : primaryFrameId,
  }));
  writeFileSync(
    resolve(roomDir, "cases.json"),
    `${JSON.stringify({ ...casesRaw, cases: rewiredCases }, null, 2)}\n`
  );

  process.stdout.write(
    `[bundle-to-phase0] wrote room '${options.room_id}' (${manifest.frames.length} frame(s)) to ${roomDir}\n` +
    `[bundle-to-phase0] primary frame: ${primaryFrameId}\n` +
    `[bundle-to-phase0] cases: ${basename(casesSource)} (${options.cases_path ? "custom" : "template default"})\n`
  );
}

function extensionFrom(filePath: string, suffix = ""): string {
  const dot = filePath.lastIndexOf(".");
  if (dot < 0) return suffix;
  const rawExt = filePath.slice(dot);
  const preceding = filePath.slice(0, dot);
  const preDot = preceding.lastIndexOf(".");
  if (preDot < 0) return `${suffix}${rawExt}`;
  const preSuffix = preceding.slice(preDot);
  return `${preSuffix}${rawExt}`;
}

main();
