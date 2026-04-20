import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSceneGraph } from "../apps/api/src/scene-graph.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const arg = process.argv[2] ?? "capture-bedroom110-4-20260420-005336";
const scenePath = resolve(repoRoot, "fixtures", "roomplan", arg, "scene.json");
const scene = JSON.parse(readFileSync(scenePath, "utf8"));
const graph = buildSceneGraph(scene);

const byKind: Record<string, number> = {};
for (const e of graph.edges) byKind[e.kind] = (byKind[e.kind] ?? 0) + 1;

const byNodeKind: Record<string, number> = {};
for (const n of graph.nodes) byNodeKind[n.kind] = (byNodeKind[n.kind] ?? 0) + 1;

console.log("=== " + arg + " ===");
console.log("nodes by kind:", byNodeKind);
console.log("edges by kind:", byKind);
console.log("warnings:", graph.warnings);
console.log("floor area:", graph.room_summary.floor_area_m2);
const bed = graph.nodes.find((n: any) => n.kind === "object" && n.object_class === "bed") as any;
if (bed) {
  console.log("\nedges touching bed (" + bed.label + "):");
  for (const e of graph.edges) {
    if (e.from_node_id === bed.node_id || e.to_node_id === bed.node_id) {
      const other = e.from_node_id === bed.node_id ? e.to_node_id : e.from_node_id;
      const otherNode = graph.nodes.find((n: any) => n.node_id === other);
      console.log("  ", e.kind.padEnd(12), other.padEnd(70), "(" + (otherNode?.label ?? "?") + ")", JSON.stringify(e.evidence));
    }
  }
}
