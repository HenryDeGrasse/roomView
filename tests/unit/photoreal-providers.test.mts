/**
 * photoreal-providers unit tests.
 *
 * The verify:photoreal script runs the service end-to-end against golden
 * fixtures; those fixtures don't exercise the env-var selection or the
 * client-conditioning summarizer directly. These tests do.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  generateFluxInpaintStackPhotoreal,
  resolveProviderKind,
  resolvePhotorealMetadata,
  summarizeClientConditioning,
  type PhotorealProviderInput,
} from "../../apps/api/src/photoreal-providers.ts";

function baseInput(overrides: Partial<PhotorealProviderInput> = {}): PhotorealProviderInput {
  return {
    scene_id: "scene:test",
    scene_snapshot_id: "snap:test",
    scene_version: 1,
    entry_id: "entry:test",
    camera_pose: {
      position: { x: 0, y: 0, z: 1.6 },
      yaw_degrees: 0,
    },
    fov: 65,
    prompt_modifiers: ["modern"],
    scene_prompt: "Create a photoreal bedroom render.",
    conditioning_summary: {
      asset_binding_count: 5,
      surface_count: 6,
      object_count: 5,
      scene_version: 1,
      scene_snapshot_id: "snap:test",
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

describe("resolveProviderKind", () => {
  test("defaults to deterministic_stub when env var is absent", () => {
    assert.equal(resolveProviderKind({}), "deterministic_stub");
  });

  test("empty/whitespace value still resolves to the stub", () => {
    assert.equal(resolveProviderKind({ ROOMVIEW_PHOTOREAL_PROVIDER: "" }), "deterministic_stub");
    assert.equal(resolveProviderKind({ ROOMVIEW_PHOTOREAL_PROVIDER: "   " }), "deterministic_stub");
  });

  test("replicate is recognized", () => {
    assert.equal(resolveProviderKind({ ROOMVIEW_PHOTOREAL_PROVIDER: "replicate" }), "replicate");
    assert.equal(resolveProviderKind({ ROOMVIEW_PHOTOREAL_PROVIDER: "REPLICATE" }), "replicate");
  });

  test("openrouter is recognized", () => {
    assert.equal(resolveProviderKind({ ROOMVIEW_PHOTOREAL_PROVIDER: "openrouter" }), "openrouter");
    assert.equal(resolveProviderKind({ ROOMVIEW_PHOTOREAL_PROVIDER: "OPENROUTER" }), "openrouter");
  });

  test("local_sdxl and sdxl both map to local_sdxl", () => {
    assert.equal(resolveProviderKind({ ROOMVIEW_PHOTOREAL_PROVIDER: "local_sdxl" }), "local_sdxl");
    assert.equal(resolveProviderKind({ ROOMVIEW_PHOTOREAL_PROVIDER: "sdxl" }), "local_sdxl");
  });

  test("flux_inpaint_stack and flux both map to flux_inpaint_stack", () => {
    assert.equal(
      resolveProviderKind({ ROOMVIEW_PHOTOREAL_PROVIDER: "flux_inpaint_stack" }),
      "flux_inpaint_stack",
    );
    assert.equal(resolveProviderKind({ ROOMVIEW_PHOTOREAL_PROVIDER: "flux" }), "flux_inpaint_stack");
    assert.equal(resolveProviderKind({ ROOMVIEW_PHOTOREAL_PROVIDER: "FLUX" }), "flux_inpaint_stack");
  });

  test("unknown values fall back to the deterministic stub", () => {
    assert.equal(resolveProviderKind({ ROOMVIEW_PHOTOREAL_PROVIDER: "midjourney" }), "deterministic_stub");
  });
});

describe("resolvePhotorealMetadata (deterministic stub)", () => {
  test("builds an asset:// URI that encodes scene/snapshot/entry ids", () => {
    const result = resolvePhotorealMetadata(
      baseInput({
        scene_id: "scene with spaces",
        scene_snapshot_id: "snap+with+plus",
        entry_id: "entry/1",
      })
    );
    assert.equal(result.provider, "deterministic_stub");
    assert.ok(result.uri.startsWith("asset://photoreal/"));
    assert.ok(result.uri.includes("scene%20with%20spaces"));
    assert.ok(result.uri.includes("snap%2Bwith%2Bplus"));
    assert.ok(result.uri.includes("entry%2F1"));
    assert.ok(result.uri.endsWith(".png"));
  });

  test("extra includes every conditioning_* field for downstream observability", () => {
    const result = resolvePhotorealMetadata(baseInput());
    assert.ok(result.extra);
    assert.equal(result.extra.conditioning_scene_version, 1);
    assert.equal(result.extra.conditioning_snapshot_id, "snap:test");
    assert.equal(result.extra.conditioning_asset_binding_count, 5);
    assert.equal(result.extra.conditioning_surface_count, 6);
    assert.equal(result.extra.conditioning_object_count, 5);
    assert.equal(result.extra.client_conditioning_present, false);
  });

  test("two calls with identical input produce identical output (URI determinism)", () => {
    const left = resolvePhotorealMetadata(baseInput());
    const right = resolvePhotorealMetadata(baseInput());
    assert.deepEqual(left, right);
  });

  test("non-stub provider kinds log and fall back (verified via side-channel)", () => {
    const originalProvider = process.env.ROOMVIEW_PHOTOREAL_PROVIDER;
    const originalWarn = console.warn;
    let warned = false;
    process.env.ROOMVIEW_PHOTOREAL_PROVIDER = "replicate";
    console.warn = () => {
      warned = true;
    };
    try {
      const result = resolvePhotorealMetadata(baseInput());
      assert.equal(result.provider, "deterministic_stub");
      assert.ok(warned, "expected a fallback warning");
    } finally {
      console.warn = originalWarn;
      if (originalProvider === undefined) {
        delete process.env.ROOMVIEW_PHOTOREAL_PROVIDER;
      } else {
        process.env.ROOMVIEW_PHOTOREAL_PROVIDER = originalProvider;
      }
    }
  });
});

describe("generateFluxInpaintStackPhotoreal (Showcase Track A)", () => {
  const capturedFrame = {
    frame_id: "frame-0",
    rgb_uri: "asset://captured/scene/frame-0.rgb.jpg",
    depth_uri: "asset://captured/scene/frame-0.depth.npy",
    intrinsics: { fx: 900, fy: 900, cx: 512, cy: 384, width: 1024, height: 768 },
  };
  const surfaceMask = {
    mask_id: "mask:abc1234567890def",
    surface_id: "surf:wall:north",
    mask_uri: "asset://masks/scene/mask_abc1234567890def.png",
    mask_bytes_sha256: "0".repeat(64),
    mask_width: 1024,
    mask_height: 768,
  };

  test("fixture mode when backend URL is unset: deterministic URI, fixture=true in extra", async () => {
    const result = await generateFluxInpaintStackPhotoreal(
      baseInput({ captured_frame: capturedFrame, surface_mask: surfaceMask, render_group_id: "grp:test" }),
      {},
    );
    assert.equal(result.provider, "flux_inpaint_stack");
    assert.ok(result.uri?.startsWith("asset://flux-inpaint/"));
    assert.equal(result.extra?.fixture, true);
    assert.equal(result.extra?.fixture_reason, "no_backend_url");
    assert.equal(result.extra?.render_group_id, "grp:test");
    assert.equal(result.extra?.captured_frame_id, "frame-0");
    assert.equal(result.extra?.surface_mask_id, surfaceMask.mask_id);
  });

  test("fixture mode when captured inputs are missing even if backend URL is set", async () => {
    const result = await generateFluxInpaintStackPhotoreal(baseInput(), {
      ROOMVIEW_FLUX_BACKEND_URL: "https://example.test/flux",
    });
    assert.equal(result.extra?.fixture, true);
    assert.equal(result.extra?.fixture_reason, "missing_captured_inputs");
  });

  test("two calls with identical input produce identical fixture URIs (determinism)", async () => {
    const input = baseInput({ captured_frame: capturedFrame, surface_mask: surfaceMask });
    const left = await generateFluxInpaintStackPhotoreal(input, {});
    const right = await generateFluxInpaintStackPhotoreal(input, {});
    assert.equal(left.uri, right.uri);
  });
});

describe("summarizeClientConditioning", () => {
  test("null input returns an absent-conditioning summary", () => {
    const summary = summarizeClientConditioning(null);
    assert.deepEqual(summary, {
      present: false,
      has_color: false,
      has_depth: false,
      has_edge: false,
      width: null,
      height: null,
      color_byte_length: 0,
      depth_byte_length: 0,
      edge_byte_length: 0,
    });
  });

  test("undefined input behaves like null", () => {
    const summary = summarizeClientConditioning(undefined);
    assert.equal(summary.present, false);
  });

  test("partial conditioning flags each present channel", () => {
    const summary = summarizeClientConditioning({
      color: "dGVzdA==",
      depth: null,
      edge: "",
      width: 512,
      height: 384,
    });
    assert.equal(summary.present, true);
    assert.equal(summary.has_color, true);
    assert.equal(summary.has_depth, false);
    assert.equal(summary.has_edge, false);
    assert.equal(summary.width, 512);
    assert.equal(summary.height, 384);
    assert.ok(summary.color_byte_length > 0);
    assert.equal(summary.depth_byte_length, 0);
    assert.equal(summary.edge_byte_length, 0);
  });

  test("byte length approximates base64 decode size", () => {
    // 4 base64 chars decode to 3 bytes.
    const summary = summarizeClientConditioning({ color: "AAAA" });
    assert.equal(summary.color_byte_length, 3);
  });
});
