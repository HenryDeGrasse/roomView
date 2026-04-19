/**
 * buildDeterministicQuickRender: end-to-end scene → render_scene conversion.
 *
 * The verify:quick-render script exercises this on real fixtures. These unit
 * tests drive pathological inputs: empty scenes, fallback asset paths,
 * ordering determinism, snapshot immutability.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { buildDeterministicQuickRender } from "../../packages/contracts/src/index.ts";
import { buildMinimalScene } from "../helpers/scene-builder.mts";

describe("buildDeterministicQuickRender", () => {
  test("empty-object scene yields zero bindings and zero fallback misses", () => {
    const scene = buildMinimalScene({ objects: [] });
    const render = buildDeterministicQuickRender(scene);
    assert.deepEqual(render.asset_bindings, []);
    assert.deepEqual(render.objects, []);
    assert.equal(render.diagnostics.proxy_fallback_count, 0);
    assert.deepEqual(render.diagnostics.fallback_misses, []);
    assert.equal(render.scene_id, scene.head.scene_id);
    assert.equal(render.scene_version, scene.head.current_scene_version);
    assert.equal(render.scene_snapshot_id, scene.snapshot.snapshot_id);
  });

  test("preserves exact scene_version / snapshot_id from the scene head", () => {
    const scene = buildMinimalScene({
      head_override: { current_scene_version: 42, current_snapshot_id: "snap:exact" },
      snapshot_override: { snapshot_id: "snap:exact" },
    });
    const render = buildDeterministicQuickRender(scene);
    assert.equal(render.scene_version, 42);
    assert.equal(render.scene_snapshot_id, "snap:exact");
  });

  test("objects are lex-sorted by object_id", () => {
    const scene = buildMinimalScene({
      objects: [
        { object_id: "obj:zeta", class: "chair" },
        { object_id: "obj:alpha", class: "desk" },
        { object_id: "obj:middle", class: "lamp" },
      ],
    });
    const render = buildDeterministicQuickRender(scene);
    assert.deepEqual(
      render.objects.map((o) => o.object_id),
      ["obj:alpha", "obj:middle", "obj:zeta"]
    );
  });

  test("fallback path: object without asset_ref uses proxy and flags missing_asset_ref", () => {
    const scene = buildMinimalScene({
      objects: [
        { object_id: "obj:a", class: "desk", asset_ref: null },
      ],
    });
    const render = buildDeterministicQuickRender(scene);
    assert.equal(render.asset_bindings.length, 1);
    const binding = render.asset_bindings[0];
    assert.equal(binding.used_fallback, true);
    assert.equal(binding.fallback_reason, "missing_asset_ref");
    assert.equal(binding.requested_asset_id, null);
    assert.equal(binding.resolved_kind, "proxy_gltf");
    assert.equal(render.diagnostics.proxy_fallback_count, 1);
  });

  test("fallback path: unknown asset_id reports requested_asset_missing", () => {
    const scene = buildMinimalScene({
      objects: [
        { object_id: "obj:a", class: "bed", asset_ref: "asset-does-not-exist" },
      ],
    });
    const render = buildDeterministicQuickRender(scene);
    const binding = render.asset_bindings[0];
    assert.equal(binding.fallback_reason, "requested_asset_missing");
    assert.equal(binding.used_fallback, true);
    assert.equal(binding.requested_asset_id, "asset-does-not-exist");
  });

  test("editing_asset_refs override the object's null asset_ref", () => {
    const scene = buildMinimalScene({
      objects: [{ object_id: "obj:a", class: "desk", asset_ref: null }],
      editing_asset_refs: [
        {
          asset_id: "asset-desk-compact-01",
          kind: "gltf",
          uri: "asset://furniture/desk/compact-01.glb",
          bound_to: "obj:a",
        },
      ],
    });
    const render = buildDeterministicQuickRender(scene);
    const binding = render.asset_bindings[0];
    assert.equal(binding.used_fallback, false);
    assert.equal(binding.fallback_reason, null);
    assert.equal(binding.resolved_asset_id, "asset-desk-compact-01");
  });

  test("idempotent: second call returns deep-equal output and does not mutate scene", () => {
    const scene = buildMinimalScene({
      objects: [
        { object_id: "obj:a", class: "desk" },
        { object_id: "obj:b", class: "bed" },
      ],
    });
    const serializedBefore = JSON.stringify(scene);
    const renderA = buildDeterministicQuickRender(scene);
    const renderB = buildDeterministicQuickRender(scene);
    assert.deepEqual(renderA, renderB);
    assert.equal(JSON.stringify(scene), serializedBefore);
  });

  test("throws when the manifest is missing the fixed-element proxy", () => {
    const scene = buildMinimalScene({ objects: [] });
    assert.throws(
      () =>
        buildDeterministicQuickRender(scene, {
          manifest_version: "x",
          // Deliberately missing asset-proxy-fixed-element-box-01
          assets: [],
        }),
      /fixed element proxy/
    );
  });
});
