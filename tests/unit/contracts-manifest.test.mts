/**
 * Contract: curated asset manifest + quick render derivation.
 *
 * The curated manifest is consumed by:
 * - buildDeterministicQuickRender (the /quick-render route + golden fixtures)
 * - selectCuratedAssetForFootprint (mutation-engine replace/add ops)
 * - proxy fallback when an object has no asset_ref or an unknown asset_id.
 *
 * These tests pin the invariants without relying on fixtures so regressions
 * surface even before anyone rewrites the scene JSON.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  CURATED_ASSET_MANIFEST,
  CURATED_ASSET_MANIFEST_VERSION,
  EDITABLE_OBJECT_CLASS_VALUES,
  createCuratedAssetManifestIndex,
  selectCuratedAssetForFootprint,
} from "../../packages/contracts/src/index.ts";

describe("CURATED_ASSET_MANIFEST", () => {
  test("manifest_version matches exported constant", () => {
    assert.equal(CURATED_ASSET_MANIFEST.manifest_version, CURATED_ASSET_MANIFEST_VERSION);
  });

  test("every entry has a unique asset_id", () => {
    const seen = new Set<string>();
    for (const entry of CURATED_ASSET_MANIFEST.assets) {
      assert.ok(!seen.has(entry.asset_id), `duplicate asset_id: ${entry.asset_id}`);
      seen.add(entry.asset_id);
    }
  });

  test("every entry advertises a non-empty glTF URI", () => {
    for (const entry of CURATED_ASSET_MANIFEST.assets) {
      assert.ok(entry.uri.startsWith("asset://"), `${entry.asset_id} uri must be an asset:// URI (got ${entry.uri})`);
      assert.ok(entry.uri.endsWith(".glb"), `${entry.asset_id} uri must be a .glb`);
      assert.equal(typeof entry.kind, "string");
      assert.ok(entry.kind === "gltf" || entry.kind === "proxy_gltf", `${entry.asset_id} kind is invalid`);
    }
  });

  test("ships with at least one proxy_gltf per editable class OR a shared obstacle fallback", () => {
    const index = createCuratedAssetManifestIndex();
    const genericObstacleProxy = (index.byObjectClass.get("generic_obstacle") ?? []).find(
      (entry) => entry.kind === "proxy_gltf"
    );
    assert.ok(genericObstacleProxy, "the manifest must ship a generic_obstacle proxy as the universal fallback");

    // Every editable object class must be resolvable via either a class-specific
    // proxy OR the shared generic_obstacle proxy (that's the contract
    // resolveAssetForObject relies on in render.ts).
    for (const className of EDITABLE_OBJECT_CLASS_VALUES) {
      const classMatches = index.byObjectClass.get(className) ?? [];
      const classProxy = classMatches.find((entry) => entry.kind === "proxy_gltf");
      const hasFallback = Boolean(classProxy) || Boolean(genericObstacleProxy);
      assert.ok(hasFallback, `no fallback path for ${className}`);
    }
  });

  test("ships the fixed-element proxy required by quick-render", () => {
    const index = createCuratedAssetManifestIndex();
    const fixedProxy = index.byAssetId.get("asset-proxy-fixed-element-box-01");
    assert.ok(fixedProxy, "buildDeterministicQuickRender throws without this asset");
    assert.equal(fixedProxy.kind, "proxy_gltf");
    assert.equal(fixedProxy.object_class, "fixed_element");
  });

  test("preferred_size_xy is null iff max_relative_error is null", () => {
    for (const entry of CURATED_ASSET_MANIFEST.assets) {
      const preferredNull = entry.preferred_size_xy === null;
      const errorNull = entry.max_relative_error === null;
      assert.equal(preferredNull, errorNull, `${entry.asset_id}: preferred_size_xy/max_relative_error nullability must agree`);
    }
  });
});

describe("createCuratedAssetManifestIndex", () => {
  test("byAssetId covers every entry", () => {
    const index = createCuratedAssetManifestIndex();
    for (const entry of CURATED_ASSET_MANIFEST.assets) {
      assert.equal(index.byAssetId.get(entry.asset_id), entry);
    }
    assert.equal(index.byAssetId.size, CURATED_ASSET_MANIFEST.assets.length);
  });

  test("byObjectClass is stable-sorted by asset_id", () => {
    const index = createCuratedAssetManifestIndex();
    for (const [, list] of index.byObjectClass) {
      const sorted = [...list].sort((l, r) => l.asset_id.localeCompare(r.asset_id));
      assert.deepEqual(list, sorted, "byObjectClass lists must remain lexicographically sorted");
    }
  });

  test("custom manifest is respected", () => {
    const custom = createCuratedAssetManifestIndex({
      manifest_version: "custom",
      assets: [
        {
          asset_id: "asset-x",
          kind: "gltf",
          uri: "asset://x.glb",
          object_class: "bed",
          style_tags: [],
          material_state: null,
          preferred_size_xy: null,
          max_relative_error: null,
        },
      ],
    });
    assert.equal(custom.byAssetId.size, 1);
    assert.ok(custom.byAssetId.has("asset-x"));
    assert.deepEqual(custom.byObjectClass.get("bed")?.map((e) => e.asset_id), ["asset-x"]);
  });
});

describe("selectCuratedAssetForFootprint", () => {
  const footprintMatches: Array<{ obb: { size_x: number; size_y: number }; expected: string }> = [
    { obb: { size_x: 2.0, size_y: 1.6 }, expected: "asset-bed-queen-ash-01" },
    { obb: { size_x: 1.6, size_y: 2.0 }, expected: "asset-bed-queen-ash-01" }, // orientation-agnostic
  ];

  for (const candidate of footprintMatches) {
    test(`bed @ ${candidate.obb.size_x}x${candidate.obb.size_y} → ${candidate.expected}`, () => {
      const chosen = selectCuratedAssetForFootprint("bed", {
        center: { x: 0, y: 0, z: 0 },
        size_x: candidate.obb.size_x,
        size_y: candidate.obb.size_y,
        size_z: 0.6,
        yaw_degrees: 0,
      });
      assert.equal(chosen.asset_id, candidate.expected);
    });
  }

  test("desk with gigantic footprint still falls back to the last desk entry", () => {
    const chosen = selectCuratedAssetForFootprint("desk", {
      center: { x: 0, y: 0, z: 0 },
      size_x: 50,
      size_y: 50,
      size_z: 0.74,
      yaw_degrees: 0,
    });
    // With size way outside preferred_size + error window, the function should
    // fall back to the last library entry rather than crash or return null.
    assert.ok(chosen);
    assert.equal(chosen.object_class, "desk");
  });

  test("each editable class returns some asset (never undefined)", () => {
    for (const className of EDITABLE_OBJECT_CLASS_VALUES) {
      const chosen = selectCuratedAssetForFootprint(className, {
        center: { x: 0, y: 0, z: 0 },
        size_x: 1,
        size_y: 1,
        size_z: 1,
        yaw_degrees: 0,
      });
      assert.ok(chosen, `selectCuratedAssetForFootprint returned falsy for ${className}`);
      assert.equal(typeof chosen.asset_id, "string");
    }
  });
});
