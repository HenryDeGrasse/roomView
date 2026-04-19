/**
 * Smoke test for the Milestone 1 → Phase 0 bench bridge.
 *
 * Emits a synthetic M1 bundle, converts it to a Phase 0 room directory, then
 * validates the resulting manifest and cases file. Runs fully in Node (no
 * Python / no SDXL), so it can live inside `npm run check` and GitHub Actions
 * CI alongside the other verifiers.
 *
 * When the iPhone app starts producing real bundles, this same chain lets
 * the user drop a capture into the Phase 0 bench with one command.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function runTsx(script: string, args: string[]): void {
  execFileSync("npx", ["--yes", "tsx", resolve(REPO_ROOT, script), ...args], {
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function main(): void {
  const sandbox = mkdtempSync(join(tmpdir(), "roomview-bundle-bridge-"));
  try {
    const bundleDir = join(sandbox, "capture-bundle");
    const roomsDir = join(sandbox, "phase0-rooms");

    runTsx("scripts/emit-synthetic-bundle.mts", [
      "--out", bundleDir,
      "--frames", "3",
      "--capture-id", "bridge-smoke-test",
    ]);

    runTsx("scripts/bundle-to-phase0.mts", [
      "--bundle", bundleDir,
      "--room-id", "bridge-smoke-test",
      "--rooms-dir", roomsDir,
    ]);

    const phase0Root = join(roomsDir, "bridge-smoke-test");
    assert.ok(existsSync(phase0Root), "phase 0 room directory should exist");

    const manifest = readJson<{
      schema_version: string;
      capture_id: string;
      room_id: string;
      primary_frame_id: string;
      frames: Array<{
        frame_id: string;
        rgb_uri: string;
        depth_uri: string;
        pose_uri: string;
        intrinsics_uri: string;
        tags: string[];
      }>;
    }>(join(phase0Root, "manifest.json"));

    assert.equal(manifest.schema_version, "phase0_capture_bundle/v0");
    assert.equal(manifest.room_id, "bridge-smoke-test");
    assert.equal(manifest.frames.length, 3);
    assert.equal(manifest.primary_frame_id, "frame_000001");

    for (const frame of manifest.frames) {
      for (const [label, uri] of [
        ["rgb", frame.rgb_uri],
        ["depth", frame.depth_uri],
        ["pose", frame.pose_uri],
        ["intrinsics", frame.intrinsics_uri],
      ] as const) {
        const fullPath = join(phase0Root, uri);
        assert.ok(existsSync(fullPath), `${label} file should have been copied: ${fullPath}`);
      }
      assert.ok(frame.depth_uri.endsWith(".depth.npy"), "depth uri should be .npy");
      if (frame.frame_id === manifest.primary_frame_id) {
        assert.ok(frame.tags.includes("primary_reference"), "primary frame should carry primary_reference tag");
      }
    }

    const casesPath = join(phase0Root, "cases.json");
    assert.ok(existsSync(casesPath), "cases.json should have been written");
    const cases = readJson<{ cases: Array<{ reference_frame_id: string }> }>(casesPath);
    const bundleFrameIds = new Set(manifest.frames.map((frame) => frame.frame_id));
    for (const entry of cases.cases) {
      assert.ok(
        bundleFrameIds.has(entry.reference_frame_id),
        `case reference_frame_id '${entry.reference_frame_id}' must exist in the bundle`
      );
    }

    assert.ok(existsSync(join(phase0Root, "roomplan_raw.json")), "roomplan_raw.json should have been copied");

    process.stdout.write(
      `[verify-bundle-phase0-bridge] ok room=${manifest.room_id} frames=${manifest.frames.length} cases=${cases.cases.length}\n`
    );
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

try {
  main();
} catch (error) {
  process.stderr.write(
    `[verify-bundle-phase0-bridge] FAIL: ${error instanceof Error ? error.message : String(error)}\n`
  );
  if (error instanceof Error && error.stack) {
    process.stderr.write(`${error.stack}\n`);
  }
  process.exit(1);
}
