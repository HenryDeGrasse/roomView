/**
 * Showcase Track B smoke test for scripts/splat-generate.py.
 *
 * Validates:
 *   1. Fixture-mode determinism: same bundle + capture_id → same splat_id.
 *   2. Content sensitivity: different bundle content → different splat_id.
 *   3. Descriptor fields match SplatAssetRecord shape (splat_id, ply_uri,
 *      gaussian_count, generated_at).
 *   4. Splatfacto mode fails cleanly (requires a GPU; not wired in CI).
 *   5. The committed ARKitScenes fixture has a real RGBD-init .splat on
 *      disk, paired with a descriptor and wired into scene.splat — the
 *      viewer's setSplat() path consumes this.
 *   6. The binary .splat is the antimatter15/gsplat.js 32-byte format
 *      (descriptor.gaussian_count × 32 == file size).
 *
 * Keeps `npm run check` green without a GPU — the committed fixture
 * .splat covers the real-backend path without re-running generation.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");

interface SplatDescriptor {
  splat_id: string;
  capture_id: string;
  generator_kind: string;
  ply_uri: string;
  ply_bytes_sha256: string | null;
  gaussian_count: number;
  generated_at: string;
}

function runSplatGenerate(args: string[]): string {
  return execFileSync(
    "uv",
    ["run", resolve(REPO_ROOT, "scripts/splat-generate.py"), ...args],
    { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" },
  ).trim();
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function main(): void {
  const sandbox = mkdtempSync(join(tmpdir(), "roomview-splat-generate-"));
  try {
    const bundleA = join(sandbox, "bundle-a");
    const bundleB = join(sandbox, "bundle-b");
    const outA1 = join(sandbox, "out-a1");
    const outA2 = join(sandbox, "out-a2");
    const outB = join(sandbox, "out-b");

    // Minimal bundle content so _bundle_signature has something to hash.
    for (const dir of [bundleA, bundleB]) {
      execFileSync("mkdir", ["-p", dir]);
    }
    writeFileSync(join(bundleA, "marker.txt"), "alpha");
    writeFileSync(join(bundleB, "marker.txt"), "beta-longer");

    // Two runs on the same bundle + capture_id produce identical splat_id
    // and gaussian_count (the two fields the viewer cares about).
    const pathA1 = runSplatGenerate(["--bundle", bundleA, "--capture-id", "room-1", "--mode", "fixture", "--out-dir", outA1]);
    const pathA2 = runSplatGenerate(["--bundle", bundleA, "--capture-id", "room-1", "--mode", "fixture", "--out-dir", outA2]);
    const descA1 = readJson<SplatDescriptor>(pathA1);
    const descA2 = readJson<SplatDescriptor>(pathA2);
    assert.equal(descA1.splat_id, descA2.splat_id, "splat_id must be deterministic for identical bundle+capture");
    assert.equal(descA1.gaussian_count, descA2.gaussian_count, "gaussian_count must be deterministic");
    assert.ok(descA1.splat_id.startsWith("splat:"), "splat_id should be 'splat:...'");
    assert.equal(descA1.generator_kind, "deterministic_stub");
    assert.equal(descA1.capture_id, "room-1");
    assert.ok(descA1.ply_uri.startsWith("asset://splats/"), "ply_uri should be asset://splats/...");
    assert.equal(descA1.ply_bytes_sha256, null, "fixture mode leaves sha256 null (no PLY emitted)");
    assert.ok(descA1.gaussian_count > 0, "gaussian_count should be a positive synthesized count");

    // Different bundle content → different splat_id. Otherwise the cache
    // key would collide across scans.
    const pathB = runSplatGenerate(["--bundle", bundleB, "--capture-id", "room-1", "--mode", "fixture", "--out-dir", outB]);
    const descB = readJson<SplatDescriptor>(pathB);
    assert.notEqual(descA1.splat_id, descB.splat_id, "splat_id must change when bundle content changes");

    // Splatfacto mode exits with a clear error (not wired yet).
    let splatfactoFailed = false;
    try {
      execFileSync(
        "uv",
        [
          "run",
          resolve(REPO_ROOT, "scripts/splat-generate.py"),
          "--bundle", bundleA,
          "--capture-id", "room-1",
          "--mode", "splatfacto",
          "--out-dir", sandbox,
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
    } catch {
      splatfactoFailed = true;
    }
    assert.ok(splatfactoFailed, "--mode splatfacto should exit non-zero until the real backend is wired.");

    // Committed ARKitScenes fixture must have a real RGBD-init .splat the web
    // viewer can load directly.
    verifyFixtureSplat("fixture-bedroom-arkitscenes");

    console.log("[verify:splat-generate] ok · fixture=deterministic · rgbd_init=committed · splatfacto=gated.");
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

function verifyFixtureSplat(fixtureId: string): void {
  const splatDir = resolve(REPO_ROOT, "fixtures", "roomplan", fixtureId, "splats");
  assert.ok(existsSync(splatDir), `splats directory missing for ${fixtureId}: ${splatDir}`);

  const entries = readdirSync(splatDir);
  const descriptors = entries.filter((f) => f.endsWith(".json"));
  const splats = entries.filter((f) => f.endsWith(".splat"));
  assert.equal(descriptors.length, 1, `expected exactly 1 splat descriptor, found ${descriptors.length}`);
  assert.equal(splats.length, 1, `expected exactly 1 .splat file, found ${splats.length}`);

  const descriptor = readJson<SplatDescriptor>(resolve(splatDir, descriptors[0]));
  assert.ok(
    descriptor.generator_kind === "rgbd_init" || descriptor.generator_kind === "cohesive",
    `committed descriptor must be 'rgbd_init' or 'cohesive' (real-backend path), got '${descriptor.generator_kind}'`,
  );
  assert.ok(descriptor.splat_id.startsWith("splat:"), "splat_id format");
  assert.ok(descriptor.gaussian_count > 1000, `gaussian_count should be non-trivial, got ${descriptor.gaussian_count}`);
  assert.ok(
    descriptor.ply_uri === `/dev/fixtures/${fixtureId}/splats/${splats[0]}`,
    `ply_uri should point at the dev-route for the .splat file; got ${descriptor.ply_uri}`,
  );
  assert.ok(descriptor.ply_bytes_sha256, "rgbd_init mode must populate ply_bytes_sha256");

  // Each gaussian is 32 bytes in the antimatter15 / gsplat.js format.
  const splatPath = resolve(splatDir, splats[0]);
  const fileSize = statSync(splatPath).size;
  assert.equal(
    fileSize,
    descriptor.gaussian_count * 32,
    `committed .splat size ${fileSize} does not match ${descriptor.gaussian_count} × 32 bytes`,
  );

  // scene.json should have a 'ready' SplatAssetRecord pointing at this URI.
  const scene = readJson<{ splat?: { status?: string; uri?: string; asset_id?: string | null } }>(
    resolve(REPO_ROOT, "fixtures", "roomplan", fixtureId, "scene.json"),
  );
  assert.ok(scene.splat, `scene.json missing splat record for ${fixtureId}`);
  assert.equal(scene.splat!.status, "ready", "scene.splat.status should be 'ready'");
  assert.equal(scene.splat!.uri, descriptor.ply_uri, "scene.splat.uri should match descriptor.ply_uri");
  assert.equal(scene.splat!.asset_id, descriptor.splat_id, "scene.splat.asset_id should match descriptor.splat_id");
}

main();
