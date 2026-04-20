/**
 * Constraint engine — Phase 2 of graph-agent-plan.md.
 *
 * Constraints are first-class, registerable predicates that read the
 * scene graph (Phase 1) and emit structured evaluations. Every
 * evaluation names the exact graph edge(s) that triggered it so the
 * UI can highlight the failure and the Phase-3 agent can cite them
 * in a plan.
 *
 * Design rules:
 *   - Constraints are PURE: (graph) -> ConstraintEvaluation[]. No I/O,
 *     no side effects, no dependency on scene.json beyond what the
 *     graph already exposes. Pure so we can re-evaluate cheaply from
 *     the planner / agent after a proposed move.
 *   - Each constraint has stable `constraint_id` and `kind`. Severity
 *     is baked into the definition so the UI can render hard-fails
 *     (red chips) and soft-warns (amber chips) consistently.
 *   - Evaluations carry `edge_ids[]` pointing at graph edges whose
 *     existence (or absence) triggered the status. No duplicated
 *     geometry logic — the graph is the source of truth.
 *   - The engine ships with a small curated catalogue. New rules get
 *     added here, not scattered across ingest/validate code paths.
 *
 * This replaces the ad-hoc validation in `overlap-policy.ts`
 * (`findHardObjectOverlaps`) as the authoritative hard-violation
 * surface. That function still lives for backwards-compat but the
 * canonical derivation now flows through the engine.
 */
import type { SceneGraph, GraphEdge, GraphNode } from "./scene-graph";

export type ConstraintSeverity = "hard" | "soft";
export type ConstraintStatus = "ok" | "soft_warn" | "hard_fail";

export type ConstraintKind =
  | "no_object_overlap"
  | "objects_within_bounds"
  | "opening_unobstructed"
  | "opening_has_walkway"
  | "bed_anchored_to_wall"
  | "seating_faces_focal_element"
  | "nightstands_flank_bed";

export interface ConstraintDefinition {
  constraint_id: string;
  kind: ConstraintKind;
  severity: ConstraintSeverity;
  /** Short human-readable rule summary for the UI + agent prompt. */
  statement: string;
  evaluate(graph: SceneGraph): ConstraintEvaluation[];
}

export interface ConstraintEvaluation {
  evaluation_id: string;
  constraint_id: string;
  kind: ConstraintKind;
  severity: ConstraintSeverity;
  status: ConstraintStatus;
  message: string;
  /** Graph edges that power this evaluation. Empty for passing checks
   * that don't reference a specific edge. */
  edge_ids: string[];
  /** Nodes the evaluation is scoped to (for UI highlighting). */
  node_ids: string[];
  /** Raw metrics for the constraint (e.g. overlap area, gap distance). */
  metrics: Record<string, number | string | boolean>;
}

export interface ConstraintReport {
  evaluations: ConstraintEvaluation[];
  summary: {
    total: number;
    ok: number;
    soft_warn: number;
    hard_fail: number;
  };
  computed_at: string;
  scene_version: number;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function createDefaultConstraintEngine(): ConstraintEngine {
  const engine = new ConstraintEngine();
  engine.register(noObjectOverlap());
  engine.register(objectsWithinBounds());
  engine.register(openingUnobstructed());
  engine.register(openingHasWalkway());
  engine.register(bedAnchoredToWall());
  engine.register(seatingFacesFocalElement());
  engine.register(nightstandsFlankBed());
  return engine;
}

export class ConstraintEngine {
  private readonly definitions = new Map<string, ConstraintDefinition>();

  register(definition: ConstraintDefinition): void {
    if (this.definitions.has(definition.constraint_id)) {
      throw new Error(`Constraint ${definition.constraint_id} already registered.`);
    }
    this.definitions.set(definition.constraint_id, definition);
  }

  list(): readonly ConstraintDefinition[] {
    return Array.from(this.definitions.values());
  }

  evaluate(graph: SceneGraph): ConstraintReport {
    const evaluations: ConstraintEvaluation[] = [];
    for (const definition of this.definitions.values()) {
      for (const evaluation of definition.evaluate(graph)) {
        evaluations.push(evaluation);
      }
    }
    let ok = 0;
    let soft = 0;
    let hard = 0;
    for (const evaluation of evaluations) {
      if (evaluation.status === "ok") ok += 1;
      else if (evaluation.status === "soft_warn") soft += 1;
      else if (evaluation.status === "hard_fail") hard += 1;
    }
    return {
      evaluations,
      summary: { total: evaluations.length, ok, soft_warn: soft, hard_fail: hard },
      computed_at: new Date().toISOString(),
      scene_version: graph.scene_version,
    };
  }
}

// ---------------------------------------------------------------------------
// Built-in constraints
// ---------------------------------------------------------------------------

function noObjectOverlap(): ConstraintDefinition {
  return {
    constraint_id: "rv.no_object_overlap",
    kind: "no_object_overlap",
    severity: "hard",
    statement:
      "Two floor-supported objects must not have overlapping footprints (> 0.05 m²).",
    evaluate(graph: SceneGraph): ConstraintEvaluation[] {
      const evaluations: ConstraintEvaluation[] = [];
      const collides = graph.edges.filter((e) => e.kind === "COLLIDES");
      for (const edge of collides) {
        const [a, b] = [edge.from_node_id, edge.to_node_id];
        const overlap = (edge.evidence as { overlap_area_m2?: number }).overlap_area_m2 ?? 0;
        evaluations.push({
          evaluation_id: `eval:noverlap:${edge.edge_id}`,
          constraint_id: "rv.no_object_overlap",
          kind: "no_object_overlap",
          severity: "hard",
          status: "hard_fail",
          message: describePair(graph, a, b, "overlaps"),
          edge_ids: [edge.edge_id],
          node_ids: [a, b],
          metrics: { overlap_area_m2: overlap },
        });
      }
      return evaluations;
    },
  };
}

function objectsWithinBounds(): ConstraintDefinition {
  return {
    constraint_id: "rv.objects_within_bounds",
    kind: "objects_within_bounds",
    severity: "hard",
    statement:
      "Every object's footprint must sit (majority-wise) within the captured floor polygon.",
    evaluate(graph: SceneGraph): ConstraintEvaluation[] {
      const evaluations: ConstraintEvaluation[] = [];
      const floor = graph.nodes.find((n) => n.kind === "floor");
      if (!floor || floor.kind !== "floor") return evaluations;
      for (const node of graph.nodes) {
        if (node.kind !== "object") continue;
        // Previous version only tested the centroid, which let
        // partially-outside placements through (a bed at the room's
        // edge with its centroid still inside the polygon but half
        // its footprint clipping the wall). Upgrade to a vertex-
        // majority test against the footprint polygon: if > 40% of
        // vertices sit outside the floor polygon we treat the
        // placement as a hard failure. 40% chosen so a small TSDF
        // bleed at the wall doesn't over-flag, but a half-out-of-
        // bounds bed does.
        const verts = node.footprint_polygon.vertices;
        let outsideCount = 0;
        for (const v of verts) {
          if (!isPointInPolygon(v, floor.polygon.vertices)) outsideCount += 1;
        }
        const outsideFraction = verts.length > 0 ? outsideCount / verts.length : 0;
        const centroidInside = isPointInPolygon(node.centroid, floor.polygon.vertices);
        if (outsideFraction > 0.4 || !centroidInside) {
          evaluations.push({
            evaluation_id: `eval:bounds:${node.node_id}`,
            constraint_id: "rv.objects_within_bounds",
            kind: "objects_within_bounds",
            severity: "hard",
            status: "hard_fail",
            message: `${node.label} is placed outside the room's floor polygon.`,
            edge_ids: [],
            node_ids: [node.node_id],
            metrics: {
              outside_vertex_fraction: Math.round(outsideFraction * 100) / 100,
              centroid_inside: centroidInside,
            },
          });
        }
      }
      return evaluations;
    },
  };
}

function openingUnobstructed(): ConstraintDefinition {
  return {
    constraint_id: "rv.opening_unobstructed",
    kind: "opening_unobstructed",
    severity: "hard",
    statement:
      "Doors must have an unobstructed 0.9m ingress zone — nothing should overlap the walk-through rectangle.",
    evaluate(graph: SceneGraph): ConstraintEvaluation[] {
      const evaluations: ConstraintEvaluation[] = [];
      const obstructs = graph.edges.filter((e) => e.kind === "OBSTRUCTS");
      // Scope to doors only — window obstruction isn't a safety issue.
      const doorIds = new Set(
        graph.nodes.filter((n) => n.kind === "opening" && n.type === "door").map((n) => n.node_id)
      );
      for (const edge of obstructs) {
        if (!doorIds.has(edge.to_node_id)) continue;
        evaluations.push({
          evaluation_id: `eval:unobstructed:${edge.edge_id}`,
          constraint_id: "rv.opening_unobstructed",
          kind: "opening_unobstructed",
          severity: "hard",
          status: "hard_fail",
          message: describePair(graph, edge.from_node_id, edge.to_node_id, "blocks"),
          edge_ids: [edge.edge_id],
          node_ids: [edge.from_node_id, edge.to_node_id],
          metrics: {
            overlap_area_m2: (edge.evidence as { overlap_area_m2?: number }).overlap_area_m2 ?? 0,
          },
        });
      }
      return evaluations;
    },
  };
}

function openingHasWalkway(): ConstraintDefinition {
  // Walkway proxy for Phase 2: flag when any floor-supported object sits
  // within 0.15m of a door's floor segment without being flush-on-wall.
  // Full A* path clearance lands in Phase 3 via the agent's find_paths
  // tool; this predicate is the cheap static version.
  return {
    constraint_id: "rv.opening_has_walkway",
    kind: "opening_has_walkway",
    severity: "soft",
    statement:
      "Walk-up lanes to doors should stay clear: nothing within 15 cm of the floor segment unless mounted to the door's host wall.",
    evaluate(graph: SceneGraph): ConstraintEvaluation[] {
      const evaluations: ConstraintEvaluation[] = [];
      const doorIds = new Set(
        graph.nodes.filter((n) => n.kind === "opening" && n.type === "door").map((n) => n.node_id)
      );
      const hostedOnByObject = new Map<string, Set<string>>();
      for (const edge of graph.edges) {
        if (edge.kind === "HOSTED_ON") {
          const set = hostedOnByObject.get(edge.from_node_id) ?? new Set<string>();
          set.add(edge.to_node_id);
          hostedOnByObject.set(edge.from_node_id, set);
        }
      }
      for (const edge of graph.edges) {
        if (edge.kind !== "NEAR_OPENING") continue;
        if (!doorIds.has(edge.to_node_id)) continue;
        const distance = (edge.evidence as { distance_m?: number }).distance_m ?? 0;
        if (distance > 0.15) continue;
        // Skip objects that are on the same wall as the door (they can't
        // be in the walkway by definition).
        const opening = graph.nodes.find((n) => n.node_id === edge.to_node_id);
        if (opening && opening.kind === "opening" && opening.host_wall_node_id) {
          const hosted = hostedOnByObject.get(edge.from_node_id);
          if (hosted && hosted.has(opening.host_wall_node_id)) continue;
        }
        evaluations.push({
          evaluation_id: `eval:walkway:${edge.edge_id}`,
          constraint_id: "rv.opening_has_walkway",
          kind: "opening_has_walkway",
          severity: "soft",
          status: "soft_warn",
          message: describePair(graph, edge.from_node_id, edge.to_node_id, "is inside the walkway of"),
          edge_ids: [edge.edge_id],
          node_ids: [edge.from_node_id, edge.to_node_id],
          metrics: { distance_m: distance },
        });
      }
      return evaluations;
    },
  };
}

function bedAnchoredToWall(): ConstraintDefinition {
  return {
    constraint_id: "rv.bed_anchored_to_wall",
    kind: "bed_anchored_to_wall",
    severity: "soft",
    statement:
      "A bed should have at least one long side flush to a wall for classic bedroom layout.",
    evaluate(graph: SceneGraph): ConstraintEvaluation[] {
      const evaluations: ConstraintEvaluation[] = [];
      const beds = graph.nodes.filter((n) => n.kind === "object" && n.object_class === "bed");
      for (const bed of beds) {
        const hosted = graph.edges.find((e) => e.kind === "HOSTED_ON" && e.from_node_id === bed.node_id);
        const parallel = graph.edges.find((e) => e.kind === "PARALLEL_TO" && e.from_node_id === bed.node_id);
        if (hosted || parallel) {
          evaluations.push({
            evaluation_id: `eval:bedwall:${bed.node_id}`,
            constraint_id: "rv.bed_anchored_to_wall",
            kind: "bed_anchored_to_wall",
            severity: "soft",
            status: "ok",
            message: `${bed.label} is anchored to a wall.`,
            edge_ids: [hosted?.edge_id, parallel?.edge_id].filter(Boolean) as string[],
            node_ids: [bed.node_id],
            metrics: {},
          });
        } else {
          evaluations.push({
            evaluation_id: `eval:bedwall:${bed.node_id}`,
            constraint_id: "rv.bed_anchored_to_wall",
            kind: "bed_anchored_to_wall",
            severity: "soft",
            status: "soft_warn",
            message: `${bed.label} floats in the middle of the room; a wall anchor is typically more livable.`,
            edge_ids: [],
            node_ids: [bed.node_id],
            metrics: {},
          });
        }
      }
      return evaluations;
    },
  };
}

function seatingFacesFocalElement(): ConstraintDefinition {
  return {
    constraint_id: "rv.seating_faces_focal_element",
    kind: "seating_faces_focal_element",
    severity: "soft",
    statement:
      "Sofas should face the bed, an opening, or a wall-mounted focal element rather than a blank wall.",
    evaluate(graph: SceneGraph): ConstraintEvaluation[] {
      const evaluations: ConstraintEvaluation[] = [];
      // Chairs serve too many purposes (desk chair, reading-corner chair,
      // transitional accent chair) to assume they *must* point at a focal
      // element. Sofas are the one seat class where facing-something is
      // the whole point.
      const seating = graph.nodes.filter((n) => n.kind === "object" && n.object_class === "sofa");
      for (const seat of seating) {
        const facesEdges = graph.edges.filter((e) => e.kind === "FACES" && e.from_node_id === seat.node_id);
        const meaningfulTargets = facesEdges.filter((e) => {
          const target = graph.nodes.find((n) => n.node_id === e.to_node_id);
          if (!target) return false;
          if (target.kind === "opening") return true;
          if (target.kind === "object" && (target.object_class === "bed" || target.object_class === "television")) return true;
          return false;
        });
        if (meaningfulTargets.length > 0) {
          evaluations.push({
            evaluation_id: `eval:seat:${seat.node_id}`,
            constraint_id: "rv.seating_faces_focal_element",
            kind: "seating_faces_focal_element",
            severity: "soft",
            status: "ok",
            message: `${seat.label} faces a focal element.`,
            edge_ids: meaningfulTargets.map((e) => e.edge_id),
            node_ids: [seat.node_id, ...meaningfulTargets.map((e) => e.to_node_id)],
            metrics: { facing_targets: meaningfulTargets.length },
          });
        } else {
          evaluations.push({
            evaluation_id: `eval:seat:${seat.node_id}`,
            constraint_id: "rv.seating_faces_focal_element",
            kind: "seating_faces_focal_element",
            severity: "soft",
            status: "soft_warn",
            message: `${seat.label} faces nothing particularly interesting — consider rotating toward the bed, TV, or a window.`,
            edge_ids: facesEdges.map((e) => e.edge_id),
            node_ids: [seat.node_id],
            metrics: { facing_targets: 0 },
          });
        }
      }
      return evaluations;
    },
  };
}

function nightstandsFlankBed(): ConstraintDefinition {
  return {
    constraint_id: "rv.nightstands_flank_bed",
    kind: "nightstands_flank_bed",
    severity: "soft",
    statement:
      "Beds typically sit between two matched nightstands. When one side has a nightstand and the other doesn't, prefer evening the pair.",
    evaluate(graph: SceneGraph): ConstraintEvaluation[] {
      const evaluations: ConstraintEvaluation[] = [];
      const beds = graph.nodes.filter((n) => n.kind === "object" && n.object_class === "bed");
      for (const bed of beds) {
        const flanks = graph.edges.filter(
          (e) => e.kind === "FLANKS" && (e.evidence as { shared_neighbour_node_id?: string }).shared_neighbour_node_id === bed.node_id
        );
        if (flanks.length > 0) {
          evaluations.push({
            evaluation_id: `eval:flank:${bed.node_id}`,
            constraint_id: "rv.nightstands_flank_bed",
            kind: "nightstands_flank_bed",
            severity: "soft",
            status: "ok",
            message: `${bed.label} has matched flanking pieces.`,
            edge_ids: flanks.map((e) => e.edge_id),
            node_ids: [bed.node_id, ...flanks.flatMap((e) => [e.from_node_id, e.to_node_id])],
            metrics: { pair_count: flanks.length },
          });
          continue;
        }
        // Only warn when there's an adjacent object on one side but not
        // the other — otherwise leave the bed untagged.
        const neighbours = graph.edges.filter(
          (e) => e.kind === "ADJACENT_TO" && (e.from_node_id === bed.node_id || e.to_node_id === bed.node_id)
        );
        if (neighbours.length === 1) {
          evaluations.push({
            evaluation_id: `eval:flank:${bed.node_id}`,
            constraint_id: "rv.nightstands_flank_bed",
            kind: "nightstands_flank_bed",
            severity: "soft",
            status: "soft_warn",
            message: `${bed.label} has one adjacent piece but nothing matched on the other side.`,
            edge_ids: neighbours.map((e) => e.edge_id),
            node_ids: [bed.node_id],
            metrics: { neighbour_count: neighbours.length },
          });
        }
      }
      return evaluations;
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function describePair(graph: SceneGraph, fromId: string, toId: string, verb: string): string {
  const a = graph.nodes.find((n) => n.node_id === fromId);
  const b = graph.nodes.find((n) => n.node_id === toId);
  return `${a?.label ?? fromId} ${verb} ${b?.label ?? toId}.`;
}

function isPointInPolygon(
  point: { x: number; y: number },
  vertices: readonly { x: number; y: number }[]
): boolean {
  let inside = false;
  for (let i = 0, j = vertices.length - 1; i < vertices.length; j = i, i += 1) {
    const xi = vertices[i]!.x;
    const yi = vertices[i]!.y;
    const xj = vertices[j]!.x;
    const yj = vertices[j]!.y;
    const intersect = ((yi > point.y) !== (yj > point.y)) && point.x < ((xj - xi) * (point.y - yi)) / ((yj - yi) || 1e-12) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

// ---------------------------------------------------------------------------
// Re-exports
// ---------------------------------------------------------------------------

export type { GraphEdge, GraphNode };
