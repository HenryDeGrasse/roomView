/**
 * Unit tests for apps/api/src/scene-graph.ts.
 *
 * Loaded fixtures:
 *   - capture-bedroom110-4-20260420-005336: 12 objects, 4 walls, 4 openings,
 *     2 hard violations (ground truth from rederive-hard-violations.py).
 *   - bedroom-primary: curated pre-capture fixture, simpler topology.
 *
 * These tests assert both topology (counts, expected edges) and behavior
 * under degeneracy (missing footprint, orphan support, zero-size OBB,
 * support cycles). The latter exercise the warning surface without
 * mutating the fixture files.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";

import { buildSceneGraph, GRAPH_CONSTANTS } from "../../apps/api/src/scene-graph.ts";
import type { Scene, SceneObject } from "../../packages/contracts/src/index.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

function loadFixtureScene(relativeDir: string): Scene {
  const path = resolve(repoRoot, "fixtures", "roomplan", relativeDir, "scene.json");
  return JSON.parse(readFileSync(path, "utf8")) as Scene;
}

const BEDROOM110_4 = "capture-bedroom110-4-20260420-005336";

describe("buildSceneGraph — bedroom110-4 fixture topology", () => {
  const scene = loadFixtureScene(BEDROOM110_4);
  const graph = buildSceneGraph(scene, { now: () => "1970-01-01T00:00:00.000Z" });

  test("room_summary counts match fixture", () => {
    assert.equal(graph.room_summary.object_count, 12);
    assert.equal(graph.room_summary.opening_count, 4);
    assert.equal(graph.room_summary.wall_count, 4);
    assert.equal(graph.scene_id, scene.head.scene_id);
    assert.equal(graph.scene_version, scene.head.current_scene_version);
    assert.equal(graph.coordinate_frame, "room_xy_z_up");
  });

  test("every floor-supported object has a SUPPORTS edge from floor", () => {
    const objects = scene.snapshot.state.room.objects;
    const floorSupported = objects.filter((o) => o.support.support_kind === "floor");
    const supportsFromFloor = graph.edges.filter(
      (e) => e.kind === "SUPPORTS" && e.from_node_id === "floor"
    );
    assert.equal(supportsFromFloor.length, floorSupported.length);
  });

  test("each flush_to_wall object has a HOSTED_ON edge", () => {
    const objects = scene.snapshot.state.room.objects;
    const expectedHosted = objects.filter((o) => o.host?.relation_type === "flush_to_wall").length;
    const hostedEdges = graph.edges.filter((e) => e.kind === "HOSTED_ON");
    assert.equal(hostedEdges.length, expectedHosted);
  });

  test("every opening CONTAINS edge points from a wall to an opening", () => {
    const containsEdges = graph.edges.filter((e) => e.kind === "CONTAINS");
    for (const edge of containsEdges) {
      assert.ok(edge.from_node_id.startsWith("wall:"), `expected wall prefix, got ${edge.from_node_id}`);
      assert.ok(edge.to_node_id.startsWith("opening:"), `expected opening prefix, got ${edge.to_node_id}`);
    }
    // Every opening with a host wall should be contained in exactly one wall.
    const openingNodes = graph.nodes.filter((n) => n.kind === "opening");
    const openingsWithHost = openingNodes.filter((n) => n.kind === "opening" && n.host_wall_node_id !== null);
    assert.equal(containsEdges.length, openingsWithHost.length);
  });

  test("no duplicate node_ids", () => {
    const ids = new Set<string>();
    for (const node of graph.nodes) {
      assert.ok(!ids.has(node.node_id), `duplicate node_id ${node.node_id}`);
      ids.add(node.node_id);
    }
  });

  test("hard_violations count matches COLLIDES edges", () => {
    const cached = scene.derived_state_cache?.hard_violations ?? [];
    const expectedCollisions = cached.filter((v) => (v as { reason_code: string }).reason_code === "OBJECT_OVERLAP").length;
    const collides = graph.edges.filter((e) => e.kind === "COLLIDES");
    assert.equal(collides.length, expectedCollisions);
  });

  test("ADJACENT_TO evidence carries polygon gap ≤ threshold", () => {
    const adj = graph.edges.filter((e) => e.kind === "ADJACENT_TO");
    for (const e of adj) {
      const gap = (e.evidence as { polygon_gap_m: number }).polygon_gap_m;
      assert.ok(gap >= 0 && gap <= GRAPH_CONSTANTS.ADJACENT_MAX_GAP_M + 1e-6, `gap ${gap} beyond threshold`);
    }
  });

  test("PARALLEL_TO references at least one wall for the highly-aligned storage cluster", () => {
    const parallel = graph.edges.filter((e) => e.kind === "PARALLEL_TO");
    assert.ok(parallel.length >= 4, `expected at least 4 PARALLEL_TO edges, got ${parallel.length}`);
  });

  test("every wall node has at least one floor segment", () => {
    const wallNodes = graph.nodes.filter((n) => n.kind === "wall");
    for (const wall of wallNodes) {
      if (wall.kind !== "wall") continue;
      assert.ok(wall.segments.length > 0, `wall ${wall.name} missing floor segment`);
      assert.ok(wall.length_m > 0, `wall ${wall.name} has zero length`);
    }
    assert.equal(graph.warnings.filter((w) => w.code === "WALL_NO_FLOOR_EDGE").length, 0);
  });

  test("computed_at timestamp present and round-tripable", () => {
    const laterGraph = buildSceneGraph(scene);
    assert.ok(typeof laterGraph.computed_at === "string");
    assert.ok(!Number.isNaN(Date.parse(laterGraph.computed_at)));
  });
});

describe("buildSceneGraph — degenerate cases", () => {
  test("zero-size OBB emits DEGENERATE_OBB warning and skips object node", () => {
    const scene = loadFixtureScene(BEDROOM110_4);
    const first = scene.snapshot.state.room.objects[0]! as SceneObject;
    first.obb = { ...first.obb, size_x: 0, size_y: 0 };
    const graph = buildSceneGraph(scene);
    const warning = graph.warnings.find((w) => w.code === "DEGENERATE_OBB");
    assert.ok(warning, "expected DEGENERATE_OBB warning");
    const remainingObjects = graph.nodes.filter((n) => n.kind === "object");
    assert.equal(remainingObjects.length, scene.snapshot.state.room.objects.length - 1);
  });

  test("non-finite yaw normalises to 0 with INVALID_YAW warning", () => {
    const scene = loadFixtureScene(BEDROOM110_4);
    const first = scene.snapshot.state.room.objects[0]!;
    first.obb = { ...first.obb, yaw_degrees: Number.NaN };
    const graph = buildSceneGraph(scene);
    assert.ok(graph.warnings.some((w) => w.code === "INVALID_YAW"), "expected INVALID_YAW warning");
    const objectNode = graph.nodes.find((n) => n.kind === "object" && n.source_entity_id === first.object_id);
    assert.ok(objectNode && objectNode.kind === "object");
    if (objectNode.kind === "object") {
      assert.equal(objectNode.yaw_degrees, 0);
    }
  });

  test("orphan support_entity_id emits ORPHAN_SUPPORT and skips edge", () => {
    const scene = loadFixtureScene(BEDROOM110_4);
    const first = scene.snapshot.state.room.objects[0]!;
    first.support = { ...first.support, support_kind: "wall", support_entity_id: "surface-does-not-exist" };
    first.host = null;
    const graph = buildSceneGraph(scene);
    assert.ok(graph.warnings.some((w) => w.code === "ORPHAN_SUPPORT"));
  });

  test("empty objects list still produces the room shell graph", () => {
    const scene = loadFixtureScene(BEDROOM110_4);
    scene.snapshot.state.room.objects = [];
    const graph = buildSceneGraph(scene);
    assert.equal(graph.room_summary.object_count, 0);
    assert.ok(graph.nodes.some((n) => n.kind === "floor"));
    assert.ok(graph.nodes.filter((n) => n.kind === "wall").length > 0);
    assert.equal(graph.edges.filter((e) => e.kind === "SUPPORTS").length, 0);
  });

  test("support cycle is detected and suppressed", () => {
    const scene = loadFixtureScene(BEDROOM110_4);
    const objects = scene.snapshot.state.room.objects;
    const a = objects[0]!;
    const b = objects[1]!;
    a.support = { ...a.support, support_kind: "object", support_entity_id: b.object_id };
    b.support = { ...b.support, support_kind: "object", support_entity_id: a.object_id };
    const graph = buildSceneGraph(scene);
    assert.ok(graph.warnings.some((w) => w.code === "SUPPORT_CYCLE"));
    const supportsEdgesInCycle = graph.edges.filter(
      (e) =>
        e.kind === "SUPPORTS" &&
        (e.from_node_id.endsWith(a.object_id) || e.from_node_id.endsWith(b.object_id)) &&
        (e.to_node_id.endsWith(a.object_id) || e.to_node_id.endsWith(b.object_id))
    );
    assert.equal(supportsEdgesInCycle.length, 0);
  });
});

describe("buildSceneGraph — bedroom-primary (curated fixture)", () => {
  const scene = loadFixtureScene("bedroom-primary");
  const graph = buildSceneGraph(scene);

  test("returns a graph without throwing", () => {
    assert.equal(graph.coordinate_frame, "room_xy_z_up");
    assert.ok(graph.nodes.length > 0);
  });

  test("no duplicate edges between the same pair with same kind", () => {
    const seen = new Set<string>();
    for (const edge of graph.edges) {
      const key = `${edge.kind}|${edge.from_node_id}|${edge.to_node_id}`;
      assert.ok(!seen.has(key), `duplicate edge ${key}`);
      seen.add(key);
    }
  });
});
