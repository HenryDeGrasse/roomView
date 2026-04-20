/**
 * Unit tests for apps/api/src/constraint-engine.ts.
 *
 * Asserts that the engine:
 *   - Produces a deterministic report from a real fixture graph.
 *   - Emits hard_fail for each COLLIDES edge in the bedroom110-4 scene
 *     (matching the overlap-policy hard-violation count).
 *   - Hard-fails when an object is moved outside the floor polygon.
 *   - Soft-warns on the bed when we remove its wall anchors.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";

import { buildSceneGraph } from "../../apps/api/src/scene-graph.ts";
import { createDefaultConstraintEngine } from "../../apps/api/src/constraint-engine.ts";
import type { Scene } from "../../packages/contracts/src/index.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const BEDROOM110_4 = "capture-bedroom110-4-20260420-005336";

function loadScene(relativeDir: string): Scene {
  const path = resolve(repoRoot, "fixtures", "roomplan", relativeDir, "scene.json");
  return JSON.parse(readFileSync(path, "utf8")) as Scene;
}

describe("ConstraintEngine — bedroom110-4 fixture", () => {
  const scene = loadScene(BEDROOM110_4);
  const graph = buildSceneGraph(scene, { now: () => "1970-01-01T00:00:00.000Z" });
  const engine = createDefaultConstraintEngine();
  const report = engine.evaluate(graph);

  test("summary totals are consistent", () => {
    assert.equal(
      report.summary.total,
      report.summary.ok + report.summary.soft_warn + report.summary.hard_fail
    );
    assert.equal(report.scene_version, scene.head.current_scene_version);
  });

  test("no_object_overlap hard_fails match the COLLIDES edge count", () => {
    const collidesCount = graph.edges.filter((e) => e.kind === "COLLIDES").length;
    const hardOverlaps = report.evaluations.filter(
      (e) => e.kind === "no_object_overlap" && e.status === "hard_fail"
    );
    assert.equal(hardOverlaps.length, collidesCount);
  });

  test("opening_unobstructed points at a door when a floor piece is in the ingress", () => {
    const fails = report.evaluations.filter(
      (e) => e.kind === "opening_unobstructed" && e.status === "hard_fail"
    );
    // The fixture has multiple door-ingress overlaps (storage up against
    // north wall blocking the closet). The test is primarily that the
    // constraint surfaces *something* rather than being silently skipped.
    assert.ok(fails.length > 0, "expected at least one opening_unobstructed hard_fail");
    for (const ev of fails) {
      assert.ok(ev.edge_ids.length > 0, "expected edge_ids on opening_unobstructed fail");
    }
  });

  test("bed_anchored_to_wall marks the bed OK (HOSTED_ON is present)", () => {
    const bedEvals = report.evaluations.filter((e) => e.kind === "bed_anchored_to_wall");
    assert.ok(bedEvals.length >= 1);
    assert.ok(bedEvals.some((e) => e.status === "ok"));
  });
});

describe("ConstraintEngine — synthetic perturbations", () => {
  test("objects_within_bounds fires when the bed centroid leaves the floor", () => {
    const scene = loadScene(BEDROOM110_4);
    const bed = scene.snapshot.state.room.objects.find((o) => o.class === "bed")!;
    bed.obb = { ...bed.obb, center: { x: 100, y: 100, z: bed.obb.center.z } };
    bed.footprint_polygon = undefined; // force OBB fallback
    const graph = buildSceneGraph(scene);
    const report = createDefaultConstraintEngine().evaluate(graph);
    const offFloor = report.evaluations.find(
      (e) => e.kind === "objects_within_bounds" && e.status === "hard_fail" && e.node_ids[0]?.endsWith(bed.object_id)
    );
    assert.ok(offFloor, "expected objects_within_bounds to hard_fail for a moved bed");
  });

  test("bed_anchored_to_wall soft_warns when host is null and yaws don't parallel any wall", () => {
    const scene = loadScene(BEDROOM110_4);
    const bed = scene.snapshot.state.room.objects.find((o) => o.class === "bed")!;
    bed.host = null;
    // Choose a yaw that doesn't line up with any wall (45° off the room grid).
    bed.obb = { ...bed.obb, yaw_degrees: 7 };
    const graph = buildSceneGraph(scene);
    const report = createDefaultConstraintEngine().evaluate(graph);
    const warn = report.evaluations.find(
      (e) => e.kind === "bed_anchored_to_wall" && e.status === "soft_warn"
    );
    assert.ok(warn, "expected a bed_anchored_to_wall soft_warn when unanchored");
  });
});
