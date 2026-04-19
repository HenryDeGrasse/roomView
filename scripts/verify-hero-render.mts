/**
 * Showcase-phase Track A smoke test.
 *
 * Exercises the captured-viewpoint render pipeline end-to-end without a GPU:
 *
 *   1. Run scripts/mask-service.py in fixture mode for a known
 *      (scene, surface, captured_frame) triple; assert the emitted JSON
 *      matches the SurfaceMask contract and the PNG is written.
 *   2. Feed the mask + a synthetic captured frame into
 *      generateFluxInpaintStackPhotoreal() with an empty env; assert the
 *      fixture path is taken, the URI is deterministic, and `extra` carries
 *      the expected render_group_id / captured_frame_id / surface_mask_id.
 *   3. Re-run step 2 with the backend URL set but captured inputs missing;
 *      assert the provider falls back to fixture with the right reason.
 *
 * Lives in `npm run check` so contract regressions in the Track A scaffold
 * are caught before any live Flux backend is wired up.
 *
 * See docs/showcase-phase.md for the Week 2–3 plan that swaps the fixture
 * paths for real SAM2 + Flux backends. That upgrade is env-flagged and
 * additive; this verifier stays the baseline.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  generateFluxInpaintStackPhotoreal,
  type PhotorealProviderInput,
} from "../apps/api/src/photoreal-providers.ts";
import { SURFACE_MASK_GENERATOR_KIND_VALUES } from "../packages/contracts/src/index.ts";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");

interface MaskOutputJson {
  mask_id: string;
  surface_id: string;
  captured_frame_id: string;
  generator_kind: string;
  mask_uri: string;
  mask_bytes_sha256: string;
  mask_width: number;
  mask_height: number;
  generated_at: string;
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function runMaskService(args: string[]): string {
  const output = execFileSync(
    "uv",
    ["run", resolve(REPO_ROOT, "scripts/mask-service.py"), ...args],
    { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" },
  );
  return output.trim();
}

function baseProviderInput(overrides: Partial<PhotorealProviderInput> = {}): PhotorealProviderInput {
  return {
    scene_id: "scene:hero-render",
    scene_snapshot_id: "snap:hero",
    scene_version: 2,
    entry_id: "entry:hero-0",
    camera_pose: {
      position: { x: 0, y: 0, z: 1.6 },
      yaw_degrees: 15,
    },
    fov: 65,
    prompt_modifiers: ["warm_daylight", "sage_green_wall"],
    scene_prompt: "Photoreal bedroom, north wall repainted in sage green, afternoon light.",
    conditioning_summary: {
      asset_binding_count: 5,
      surface_count: 6,
      object_count: 4,
      scene_version: 2,
      scene_snapshot_id: "snap:hero",
    },
    client_conditioning: {
      present: false,
      has_color: false,
      has_depth: false,
      has_edge: false,
      width: null,
      height: null,
      color_byte_length: 0,
      depth_byte_length: 0,
      edge_byte_length: 0,
    },
    ...overrides,
  };
}

async function main(): Promise<void> {
  const sandbox = mkdtempSync(join(tmpdir(), "roomview-hero-render-"));
  try {
    const sceneId = "scene:hero-render";
    const surfaceId = "surf:wall:north";
    const frameId = "frame-0";

    // 1. mask-service fixture mode
    const metadataPath = runMaskService([
      "--scene-id", sceneId,
      "--surface-id", surfaceId,
      "--captured-frame-id", frameId,
      "--image-width", "1024",
      "--image-height", "768",
      "--mode", "fixture",
      "--out-dir", sandbox,
    ]);
    assert.ok(existsSync(metadataPath), `mask metadata missing at ${metadataPath}`);
    const maskJson = readJson<MaskOutputJson>(metadataPath);
    assert.ok(maskJson.mask_id.startsWith("mask:"), `mask_id should be 'mask:...' got ${maskJson.mask_id}`);
    assert.equal(maskJson.surface_id, surfaceId);
    assert.equal(maskJson.captured_frame_id, frameId);
    assert.equal(maskJson.mask_width, 1024);
    assert.equal(maskJson.mask_height, 768);
    assert.ok(
      SURFACE_MASK_GENERATOR_KIND_VALUES.includes(maskJson.generator_kind as (typeof SURFACE_MASK_GENERATOR_KIND_VALUES)[number]),
      `generator_kind "${maskJson.generator_kind}" not in the contract enum`,
    );
    assert.equal(maskJson.mask_bytes_sha256.length, 64, "sha256 should be 64 hex chars");

    const maskPngPath = metadataPath.replace(/\.json$/, ".png");
    assert.ok(existsSync(maskPngPath), `mask PNG missing at ${maskPngPath}`);
    assert.ok(statSync(maskPngPath).size > 0, "mask PNG should not be empty");

    // Determinism: re-run and verify mask_bytes_sha256 stays the same.
    const rerunSandbox = mkdtempSync(join(tmpdir(), "roomview-hero-render-rerun-"));
    try {
      const rerunPath = runMaskService([
        "--scene-id", sceneId,
        "--surface-id", surfaceId,
        "--captured-frame-id", frameId,
        "--image-width", "1024",
        "--image-height", "768",
        "--mode", "fixture",
        "--out-dir", rerunSandbox,
      ]);
      const rerunJson = readJson<MaskOutputJson>(rerunPath);
      assert.equal(
        rerunJson.mask_bytes_sha256,
        maskJson.mask_bytes_sha256,
        "mask_bytes_sha256 must be deterministic across runs for identical inputs",
      );
      assert.equal(rerunJson.mask_id, maskJson.mask_id, "mask_id must be deterministic across runs");
    } finally {
      rmSync(rerunSandbox, { recursive: true, force: true });
    }

    // 2. flux_inpaint_stack fixture path with captured frame + mask attached
    const capturedFrame = {
      frame_id: frameId,
      rgb_uri: `asset://captured/${sceneId}/${frameId}.rgb.jpg`,
      depth_uri: `asset://captured/${sceneId}/${frameId}.depth.npy`,
      intrinsics: { fx: 900, fy: 900, cx: 512, cy: 384, width: 1024, height: 768 },
    };
    const surfaceMask = {
      mask_id: maskJson.mask_id,
      surface_id: maskJson.surface_id,
      mask_uri: maskJson.mask_uri,
      mask_bytes_sha256: maskJson.mask_bytes_sha256,
      mask_width: maskJson.mask_width,
      mask_height: maskJson.mask_height,
    };
    const input = baseProviderInput({
      captured_frame: capturedFrame,
      surface_mask: surfaceMask,
      render_group_id: "grp:hero-0",
    });
    const resultA = await generateFluxInpaintStackPhotoreal(input, {});
    assert.equal(resultA.provider, "flux_inpaint_stack");
    assert.ok(resultA.uri?.startsWith("asset://flux-inpaint/"), `uri should be asset://flux-inpaint/... got ${resultA.uri}`);
    assert.equal(resultA.extra?.fixture, true);
    assert.equal(resultA.extra?.fixture_reason, "no_backend_url");
    assert.equal(resultA.extra?.render_group_id, "grp:hero-0");
    assert.equal(resultA.extra?.captured_frame_id, frameId);
    assert.equal(resultA.extra?.surface_mask_id, maskJson.mask_id);

    // Determinism: identical input → identical URI
    const resultB = await generateFluxInpaintStackPhotoreal(input, {});
    assert.equal(resultB.uri, resultA.uri, "fixture URI must be deterministic for identical input");

    // 3. Missing captured inputs but backend URL set → fixture fallback with the right reason
    const missingInput = baseProviderInput({ render_group_id: "grp:hero-0" });
    const resultC = await generateFluxInpaintStackPhotoreal(missingInput, {
      ROOMVIEW_FLUX_BACKEND_URL: "https://example.test/flux",
    });
    assert.equal(resultC.extra?.fixture, true);
    assert.equal(resultC.extra?.fixture_reason, "missing_captured_inputs");
    assert.equal(resultC.extra?.captured_frame_id, null);
    assert.equal(resultC.extra?.surface_mask_id, null);

    // 4. Geometric mask mode on the committed ARKitScenes fixture.
    // This is the real projection path — surface polygon unprojected through
    // the camera pose + intrinsics to produce a per-surface mask.
    const geometricMetadataPath = runMaskService([
      "--scene-json", resolve(REPO_ROOT, "fixtures", "roomplan", "fixture-bedroom-arkitscenes", "scene.json"),
      "--surface-id", "surface-scene-fixture-fixture-bedroom-arkitscene-4241292c",
      "--captured-frame-id", "frame_000001",
      "--mode", "geometric",
      "--out-dir", sandbox,
    ]);
    assert.ok(existsSync(geometricMetadataPath), `geometric mask metadata missing at ${geometricMetadataPath}`);
    const geomJson = readJson<MaskOutputJson & { provenance?: { boundary_vertex_count: number; in_front_count: number } }>(geometricMetadataPath);
    assert.equal(geomJson.generator_kind, "geometric_projection");
    assert.ok(geomJson.provenance, "geometric mode must record provenance");
    assert.ok(
      geomJson.provenance!.boundary_vertex_count >= 3,
      `geometric mask should have at least 3 boundary vertices, got ${geomJson.provenance!.boundary_vertex_count}`,
    );
    const geomPngPath = geometricMetadataPath.replace(/\.json$/, ".png");
    assert.ok(existsSync(geomPngPath), `geometric mask PNG missing at ${geomPngPath}`);
    assert.ok(statSync(geomPngPath).size > 0, "geometric mask PNG should not be empty");

    console.log(
      `[verify:hero-render] ok · fixture=deterministic · flux_stub=fallback-exercised · geometric_projection=${geomJson.provenance!.in_front_count}/${geomJson.provenance!.boundary_vertex_count}-corners-in-front.`,
    );
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
