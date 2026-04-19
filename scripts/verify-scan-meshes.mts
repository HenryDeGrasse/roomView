/**
 * Showcase Track B Tier 2 smoke test.
 *
 * The heavy Open3D TSDF/Poisson invocation is gated on a committed mesh
 * directory so CI stays CPU-light and deterministic. We verify:
 *
 *   1. The ARKitScenes fixture has a meshes/ directory with a manifest.json
 *      that lists at least MIN_MESH_COUNT per-object meshes (per-object TSDF
 *      + Poisson-subprocess fallback should recover the majority of OBBs
 *      that have any depth coverage).
 *   2. Each listed PLY is well-formed ASCII PLY (header parses, declared
 *      vertex/face counts exceed the configured floor, file sizes are
 *      nonzero), which is what apps/web/src/scan-proxies.js loads.
 *   3. The per-object methods map, when present, only names known
 *      reconstruction paths ('tsdf' or 'poisson').
 *   4. The scripts/bundle-to-meshes.py Tier 3 "learned" mode exits with the
 *      documented follow-up message rather than crashing — keeps the
 *      scaffold honest.
 *
 * Regenerate committed meshes locally with:
 *   uv run scripts/bundle-to-meshes.py --fixture-id fixture-bedroom-arkitscenes --mode tsdf
 * Poisson-only mode (same recipe as the TSDF fallback, no TSDF first):
 *   uv run scripts/bundle-to-meshes.py --fixture-id fixture-bedroom-arkitscenes --mode poisson
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");
const FIXTURE_ID = "fixture-bedroom-arkitscenes";
const MIN_TOTAL_VERTICES = 200;
const MIN_MESH_COUNT = 5;

interface MeshManifest {
  fixture_id: string;
  mode: string;
  voxel_m: number;
  mesh_count: number;
  meshes: Record<string, string>;
  methods?: Record<string, string>;
  vertex_counts?: Record<string, number>;
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function parsePlyHeaderCounts(path: string): { vertexCount: number; faceCount: number } {
  // Just read the first 2 KB; the ASCII PLY header is always tiny.
  const fd = readFileSync(path, "utf8").slice(0, 2048);
  const endIdx = fd.indexOf("\nend_header\n");
  assert.ok(endIdx > 0, `missing end_header in ${path}`);
  const header = fd.slice(0, endIdx);
  const vertexLine = header.split("\n").find((line) => line.startsWith("element vertex "));
  const faceLine = header.split("\n").find((line) => line.startsWith("element face "));
  assert.ok(vertexLine, `missing vertex element in ${path}`);
  assert.ok(faceLine, `missing face element in ${path}`);
  const vertexCount = Number(vertexLine.split(/\s+/)[2]);
  const faceCount = Number(faceLine.split(/\s+/)[2]);
  assert.ok(Number.isFinite(vertexCount) && vertexCount > 0, `bad vertex count in ${path}`);
  assert.ok(Number.isFinite(faceCount) && faceCount > 0, `bad face count in ${path}`);
  return { vertexCount, faceCount };
}

function main(): void {
  const fixtureDir = resolve(REPO_ROOT, "fixtures", "roomplan", FIXTURE_ID);
  assert.ok(existsSync(fixtureDir), `fixture directory missing: ${fixtureDir}`);

  const meshesDir = resolve(fixtureDir, "meshes");
  assert.ok(existsSync(meshesDir), `meshes directory missing — run 'uv run scripts/bundle-to-meshes.py --fixture-id ${FIXTURE_ID}'`);

  const manifestPath = resolve(meshesDir, "manifest.json");
  assert.ok(existsSync(manifestPath), `meshes manifest missing: ${manifestPath}`);
  const manifest = readJson<MeshManifest>(manifestPath);
  assert.equal(manifest.fixture_id, FIXTURE_ID);
  assert.ok(["tsdf", "poisson"].includes(manifest.mode), `unexpected manifest mode: ${manifest.mode}`);
  assert.ok(
    manifest.mesh_count >= MIN_MESH_COUNT,
    `expected at least ${MIN_MESH_COUNT} meshes (TSDF + Poisson fallback combined), got ${manifest.mesh_count}`,
  );
  assert.equal(
    Object.keys(manifest.meshes).length,
    manifest.mesh_count,
    "manifest mesh_count does not match meshes map length",
  );
  // Per-object methods should be one of the known reconstruction paths.
  // The 'methods' map is optional on pre-per-object runs but expected going
  // forward; when present, every entry must be 'tsdf' or 'poisson'.
  if (manifest.methods) {
    for (const [objectId, method] of Object.entries(manifest.methods)) {
      assert.ok(
        ["tsdf", "poisson"].includes(method),
        `unexpected method for ${objectId}: ${method}`,
      );
    }
  }

  let totalVertices = 0;
  for (const [objectId, relPath] of Object.entries(manifest.meshes)) {
    const plyPath = resolve(fixtureDir, relPath);
    assert.ok(existsSync(plyPath), `mesh PLY missing for ${objectId}: ${plyPath}`);
    assert.ok(statSync(plyPath).size > 0, `mesh PLY empty for ${objectId}: ${plyPath}`);
    const { vertexCount, faceCount } = parsePlyHeaderCounts(plyPath);
    assert.ok(vertexCount >= 40, `mesh ${objectId} vertex count below noise floor: ${vertexCount}`);
    assert.ok(faceCount >= 40, `mesh ${objectId} face count below noise floor: ${faceCount}`);
    totalVertices += vertexCount;
  }
  assert.ok(totalVertices >= MIN_TOTAL_VERTICES, `cumulative mesh vertex count too low: ${totalVertices}`);

  // Sanity: no stray PLYs that aren't in the manifest (keeps the fixture
  // small and deterministic).
  const diskPlys = readdirSync(meshesDir).filter((f) => f.endsWith(".ply"));
  assert.equal(
    diskPlys.length,
    Object.keys(manifest.meshes).length,
    "disk PLY count does not match manifest",
  );

  // Tier 3 scaffold must exit non-zero with the documented follow-up message
  // until the learned model is wired. Keeps callers honest when switching
  // modes.
  let learnedStderr = "";
  let learnedExitCode = 0;
  try {
    execFileSync(
      "uv",
      [
        "run",
        resolve(REPO_ROOT, "scripts/bundle-to-meshes.py"),
        "--fixture-id", FIXTURE_ID,
        "--mode", "learned",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    learnedExitCode = 0;
  } catch (err: unknown) {
    const e = err as { status?: number; stderr?: Buffer };
    learnedExitCode = e.status ?? 1;
    learnedStderr = e.stderr?.toString("utf8") ?? "";
  }
  assert.notEqual(learnedExitCode, 0, "--mode learned should not succeed yet");
  assert.ok(
    /Tier 3 follow-up|not wired yet/.test(learnedStderr),
    `learned mode should print the follow-up message; got: ${learnedStderr}`,
  );

  const methodBreakdown = manifest.methods
    ? Object.values(manifest.methods).reduce<Record<string, number>>((acc, m) => {
        acc[m] = (acc[m] ?? 0) + 1;
        return acc;
      }, {})
    : {};
  const methodsSummary = Object.entries(methodBreakdown)
    .map(([m, n]) => `${m}=${n}`)
    .join(",");
  console.log(
    `[verify:scan-meshes] ok · mode=${manifest.mode} meshes=${manifest.mesh_count}` +
      `${methodsSummary ? " (" + methodsSummary + ")" : ""} total_vertices=${totalVertices}`,
  );
}

main();
