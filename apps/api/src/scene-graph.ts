/**
 * Scene graph — Phase 1 (read-only).
 *
 * Derives a spatial-relations graph from a `Scene` + its current version.
 * Pure function, no I/O, no mutations. The graph is a mirror of the
 * canonical state: swap the scene, re-compute, the graph reflects the
 * new state exactly. Every edge carries its evidence so the UI (and the
 * future agent in Phase 3) can explain *why* a relation exists.
 *
 * Coordinate frame: all node positions and polygons are in the room's
 * XY floor plane with +Z up. Wall segments are 2D line endpoints on the
 * floor. Yaw is the OBB yaw in degrees, normalised to (-180, 180].
 *
 * Reused primitives from `overlap-policy.ts` (polygon clip, area,
 * point-in-polygon) so the graph's polygon maths stay consistent with
 * hard-violation detection.
 */
import type {
  EntityId,
  NamedWallRef,
  ObjectClass,
  OBB3D,
  Opening,
  OpeningType,
  Point2D,
  Polygon2D,
  Scene,
  SceneObject,
  Shell,
  Surface,
} from "@roomview/contracts";
import {
  footprintForObject,
  footprintFromObb,
  intersectsBounds,
  pointInPolygon,
  polygonArea,
  polygonBounds,
  polygonIntersectionArea,
  type AABB2D,
} from "./overlap-policy";

// Edge-triggering constants. Each tuned so real furniture arrangements
// read like you'd expect when writing the sentence by hand. Kept at the
// top of the module so the constraint-engine refactor in Phase 2 can
// promote them straight into named `ConstraintDefinition`s.
export const GRAPH_CONSTANTS = {
  /** Min polygon-to-polygon gap for ADJACENT_TO. 15 cm is tight enough to
   * catch "the nightstand next to the bed" without capturing the whole
   * room as adjacent. */
  ADJACENT_MAX_GAP_M: 0.15,
  /** Hard-collision threshold (shared with overlap-policy.ts). */
  COLLIDE_MIN_OVERLAP_M2: 0.05,
  /** Looser threshold for chair↔table/desk pairs. A chair seat tucked
   * under a tabletop genuinely overlaps in 2D (the seat projects below
   * the tabletop) but isn't a placement bug — only flag if the overlap
   * is large enough to indicate the chair has been jammed through the
   * surface rather than pushed in. */
  COLLIDE_MIN_OVERLAP_TUCKED_M2: 0.15,
  /** Minimum vertical OBB overlap to treat a footprint collision as a
   * real collision. A TV mounted above a sofa, or a chair tucked under
   * a tabletop, can share xy footprint without occupying the same
   * volume — only flag when the solids actually share z. */
  COLLIDE_MIN_Z_OVERLAP_M: 0.10,
  /** Min dot product of object forward vector and direction-to for FACES. 0.6
   * ≈ within a 53° cone of the object's front. */
  FACES_MIN_DOT: 0.6,
  /** Max Euclidean distance for FACES (beyond this we don't assert a
   * facing relation even if the cone aligns). */
  FACES_MAX_DISTANCE_M: 3.0,
  /** Yaw tolerance (degrees) for PARALLEL_TO against a wall's azimuth
   * or its perpendicular. */
  PARALLEL_YAW_TOLERANCE_DEG: 10,
  /** Max polygon-to-wall distance for PARALLEL_TO. Keeps the edge
   * meaningful ("flush to wall") instead of firing for every
   * room-axis-aligned object against every wall. */
  PARALLEL_MAX_WALL_DISTANCE_M: 0.25,
  /** Max footprint-to-opening distance for NEAR_OPENING. */
  NEAR_OPENING_MAX_M: 0.5,
  /** Ingress rectangle depth (extending inward from the opening) for
   * OBSTRUCTS detection. Matches the 0.9m walkway guideline from the
   * stretch doc. */
  INGRESS_DEPTH_M: 0.9,
  /** FLANKS heuristic: max yaw delta (degrees) between the two candidates. */
  FLANKS_YAW_TOLERANCE_DEG: 20,
  /** FLANKS heuristic: size_z ratio band — items beyond this range are
   * too asymmetric to read as a flanking pair (wardrobe + nightstand). */
  FLANKS_SIZE_RATIO_MIN: 0.6,
  FLANKS_SIZE_RATIO_MAX: 1.6,
  /** Height above which we tag an object `tall`. Distinguishes wardrobes
   * from matching-footprint dressers. */
  TALL_Z_THRESHOLD_M: 1.5,
} as const;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type GraphNodeKind = "floor" | "ceiling" | "wall" | "opening" | "object";

export type GraphEdgeKind =
  | "SUPPORTS"
  | "HOSTED_ON"
  | "CONTAINS"
  | "ADJACENT_TO"
  | "COLLIDES"
  | "FACES"
  | "PARALLEL_TO"
  | "NEAR_OPENING"
  | "OBSTRUCTS"
  | "FLANKS";

export interface GraphNodeBase {
  node_id: string;
  kind: GraphNodeKind;
  label: string;
  source_entity_id: EntityId | null;
}

export interface FloorNode extends GraphNodeBase {
  kind: "floor";
  polygon: Polygon2D;
  area_m2: number;
  bounds: AABB2D;
  centroid: Point2D;
}

export interface CeilingNode extends GraphNodeBase {
  kind: "ceiling";
  height_m: number;
}

export interface WallNode extends GraphNodeBase {
  kind: "wall";
  wall_ref_id: EntityId;
  name: string;
  azimuth_degrees: number;
  inward_normal_xy: Point2D;
  /**
   * One or more line segments on the floor that belong to this wall.
   * Derived by matching floor-polygon edges to the wall's inward
   * normal. The midpoint of the longest segment is the wall's 2D
   * `centroid`.
   */
  segments: Array<{ a: Point2D; b: Point2D; length_m: number }>;
  length_m: number;
  centroid: Point2D;
  surface_ids: EntityId[];
}

export interface OpeningNode extends GraphNodeBase {
  kind: "opening";
  opening_id: EntityId;
  type: OpeningType;
  host_wall_node_id: string | null;
  floor_segment: { a: Point2D; b: Point2D } | null;
  ingress_polygon: Polygon2D | null;
  centroid: Point2D | null;
}

export interface ObjectNode extends GraphNodeBase {
  kind: "object";
  object_id: EntityId;
  object_class: ObjectClass;
  obb: OBB3D;
  yaw_degrees: number;
  footprint_polygon: Polygon2D;
  footprint_bounds: AABB2D;
  forward_vector_xy: Point2D;
  tall: boolean;
  centroid: Point2D;
}

export type GraphNode = FloorNode | CeilingNode | WallNode | OpeningNode | ObjectNode;

export interface GraphEdge<E extends Record<string, unknown> = Record<string, unknown>> {
  edge_id: string;
  kind: GraphEdgeKind;
  from_node_id: string;
  to_node_id: string;
  symmetric: boolean;
  strength: number;
  evidence: E;
}

export interface GraphWarning {
  code:
    | "DEGENERATE_OBB"
    | "MISSING_FOOTPRINT"
    | "ORPHAN_SUPPORT"
    | "SUPPORT_CYCLE"
    | "WALL_NO_FLOOR_EDGE"
    | "OPENING_WITHOUT_WALL"
    | "DUPLICATE_NODE_ID"
    | "INVALID_YAW";
  entity_id: EntityId | null;
  message: string;
}

export interface RoomSummary {
  room_id: EntityId;
  room_type: string;
  floor_area_m2: number;
  ceiling_height_m: number;
  object_count: number;
  opening_count: number;
  wall_count: number;
  node_count: number;
  edge_count: number;
}

export interface SceneGraph {
  scene_id: string;
  scene_version: number;
  computed_at: string;
  coordinate_frame: "room_xy_z_up";
  room_summary: RoomSummary;
  nodes: GraphNode[];
  edges: GraphEdge[];
  warnings: GraphWarning[];
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export interface BuildGraphOptions {
  /** Override ISO timestamp (for deterministic tests). */
  now?: () => string;
}

export function buildSceneGraph(scene: Scene, options: BuildGraphOptions = {}): SceneGraph {
  const warnings: GraphWarning[] = [];
  const now = options.now ?? (() => new Date().toISOString());

  const room = scene.snapshot.state.room;
  const shell = room.shell;

  const floorNode = buildFloorNode(shell);
  const ceilingNode = buildCeilingNode(shell);
  const wallNodes = buildWallNodes(shell, warnings);
  const openingNodes = buildOpeningNodes(shell, wallNodes, warnings);
  const objectNodes = buildObjectNodes(room.objects ?? [], warnings);

  const nodes: GraphNode[] = [
    floorNode,
    ...(ceilingNode ? [ceilingNode] : []),
    ...wallNodes,
    ...openingNodes,
    ...objectNodes,
  ];

  dedupeNodeIds(nodes, warnings);

  const edges: GraphEdge[] = [];
  let edgeCounter = 0;
  const nextEdgeId = () => `e:${(edgeCounter += 1).toString(36).padStart(4, "0")}`;

  // Structural edges (directly from scene.json relations)
  edges.push(...buildSupportsEdges(room.objects ?? [], floorNode, wallNodes, objectNodes, warnings, nextEdgeId));
  edges.push(...buildHostedOnEdges(room.objects ?? [], wallNodes, objectNodes, shell.surfaces, nextEdgeId));
  edges.push(...buildContainsEdges(openingNodes, wallNodes, nextEdgeId));

  // Geometric edges. COLLIDES runs AFTER the structural SUPPORTS pass so
  // that a pair recorded as "A supports B" (TV on top of a dresser) is
  // not double-counted as a footprint collision — the xy overlap is
  // intentional contact, not a placement bug.
  const supportingPairKeys = new Set(
    edges.filter((e) => e.kind === "SUPPORTS").map((e) => pairKey(e.from_node_id, e.to_node_id))
  );
  edges.push(...buildCollidesEdges(objectNodes, supportingPairKeys, nextEdgeId));
  const collidingPairKeys = new Set(
    edges.filter((e) => e.kind === "COLLIDES").map((e) => pairKey(e.from_node_id, e.to_node_id))
  );
  edges.push(...buildAdjacentEdges(objectNodes, collidingPairKeys, nextEdgeId));
  edges.push(...buildFacesEdges(objectNodes, wallNodes, openingNodes, nextEdgeId));
  edges.push(...buildParallelToEdges(objectNodes, wallNodes, nextEdgeId));
  edges.push(...buildOpeningProximityEdges(objectNodes, openingNodes, nextEdgeId));
  edges.push(...buildFlanksEdges(objectNodes, edges, nextEdgeId));

  const summary: RoomSummary = {
    room_id: room.room_id,
    room_type: room.room_type,
    floor_area_m2: round(floorNode.area_m2, 3),
    ceiling_height_m: round(shell.ceiling_height ?? 0, 3),
    object_count: objectNodes.length,
    opening_count: openingNodes.length,
    wall_count: wallNodes.length,
    node_count: nodes.length,
    edge_count: edges.length,
  };

  return {
    scene_id: scene.head.scene_id,
    scene_version: scene.head.current_scene_version,
    computed_at: now(),
    coordinate_frame: "room_xy_z_up",
    room_summary: summary,
    nodes,
    edges,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Node builders
// ---------------------------------------------------------------------------

function buildFloorNode(shell: Shell): FloorNode {
  const polygon = shell.floor_polygon;
  const bounds = polygonBounds(polygon);
  const centroid = polygonCentroid(polygon) ?? {
    x: (bounds.min_x + bounds.max_x) / 2,
    y: (bounds.min_y + bounds.max_y) / 2,
  };
  return {
    node_id: "floor",
    kind: "floor",
    label: "floor",
    source_entity_id: null,
    polygon,
    area_m2: polygonArea(polygon),
    bounds,
    centroid,
  };
}

function buildCeilingNode(shell: Shell): CeilingNode | null {
  if (typeof shell.ceiling_height !== "number" || !Number.isFinite(shell.ceiling_height)) {
    return null;
  }
  return {
    node_id: "ceiling",
    kind: "ceiling",
    label: "ceiling",
    source_entity_id: null,
    height_m: shell.ceiling_height,
  };
}

function buildWallNodes(shell: Shell, warnings: GraphWarning[]): WallNode[] {
  const floorEdges = floorPolygonEdges(shell.floor_polygon);
  const results: WallNode[] = [];
  for (const ref of shell.named_wall_refs) {
    const matchedSegments = matchFloorEdgesToWall(floorEdges, ref);
    if (matchedSegments.length === 0) {
      warnings.push({
        code: "WALL_NO_FLOOR_EDGE",
        entity_id: ref.wall_ref_id,
        message: `Wall ${ref.name} has no matching floor polygon edge; segments will be empty.`,
      });
    }
    const length_m = matchedSegments.reduce((sum, seg) => sum + seg.length_m, 0);
    const centroid = matchedSegments.length > 0
      ? longestSegmentMidpoint(matchedSegments)
      : { x: 0, y: 0 };
    results.push({
      node_id: wallNodeId(ref.wall_ref_id),
      kind: "wall",
      label: ref.name,
      source_entity_id: ref.wall_ref_id,
      wall_ref_id: ref.wall_ref_id,
      name: ref.name,
      azimuth_degrees: ref.azimuth_degrees,
      inward_normal_xy: ref.inward_normal_xy,
      segments: matchedSegments,
      length_m: round(length_m, 3),
      centroid,
      surface_ids: ref.surface_ids,
    });
  }
  return results;
}

function buildOpeningNodes(
  shell: Shell,
  wallNodes: WallNode[],
  warnings: GraphWarning[]
): OpeningNode[] {
  const wallBySurfaceId = new Map<EntityId, WallNode>();
  for (const wall of wallNodes) {
    for (const surfaceId of wall.surface_ids) {
      wallBySurfaceId.set(surfaceId, wall);
    }
  }
  const results: OpeningNode[] = [];
  for (const opening of shell.openings) {
    const hostWall = wallBySurfaceId.get(opening.host_surface_id) ?? null;
    if (!hostWall) {
      warnings.push({
        code: "OPENING_WITHOUT_WALL",
        entity_id: opening.opening_id,
        message: `Opening ${opening.opening_id} has no host wall; host_surface_id=${opening.host_surface_id}.`,
      });
    }
    const floorSegment = hostWall ? projectOpeningToFloor(opening, hostWall) : null;
    const ingressPolygon = floorSegment && hostWall
      ? buildIngressPolygon(floorSegment, hostWall.inward_normal_xy)
      : null;
    const centroid = floorSegment
      ? { x: (floorSegment.a.x + floorSegment.b.x) / 2, y: (floorSegment.a.y + floorSegment.b.y) / 2 }
      : null;
    results.push({
      node_id: openingNodeId(opening.opening_id),
      kind: "opening",
      label: openingLabel(opening, hostWall),
      source_entity_id: opening.opening_id,
      opening_id: opening.opening_id,
      type: opening.type,
      host_wall_node_id: hostWall?.node_id ?? null,
      floor_segment: floorSegment,
      ingress_polygon: ingressPolygon,
      centroid,
    });
  }
  return results;
}

function buildObjectNodes(objects: readonly SceneObject[], warnings: GraphWarning[]): ObjectNode[] {
  const results: ObjectNode[] = [];
  for (const obj of objects) {
    if (!obj || !obj.obb || !Number.isFinite(obj.obb.size_x) || !Number.isFinite(obj.obb.size_y)) {
      warnings.push({
        code: "DEGENERATE_OBB",
        entity_id: obj?.object_id ?? null,
        message: `Object ${obj?.object_id ?? "<unknown>"} has a missing or non-finite OBB; skipped.`,
      });
      continue;
    }
    if (obj.obb.size_x <= 1e-4 || obj.obb.size_y <= 1e-4) {
      warnings.push({
        code: "DEGENERATE_OBB",
        entity_id: obj.object_id,
        message: `Object ${obj.object_id} has a zero-size OBB; skipped.`,
      });
      continue;
    }
    let yaw = obj.obb.yaw_degrees;
    if (!Number.isFinite(yaw)) {
      warnings.push({
        code: "INVALID_YAW",
        entity_id: obj.object_id,
        message: `Object ${obj.object_id} has non-finite yaw; normalised to 0.`,
      });
      yaw = 0;
    }
    yaw = normaliseYawDegrees(yaw);

    let footprint = footprintForObject(obj);
    if (!footprint.vertices || footprint.vertices.length < 3) {
      warnings.push({
        code: "MISSING_FOOTPRINT",
        entity_id: obj.object_id,
        message: `Object ${obj.object_id} footprint invalid; falling back to OBB rectangle.`,
      });
      footprint = footprintFromObb(obj.obb);
    }

    const forward = forwardVectorXY(yaw);
    const centroid = polygonCentroid(footprint) ?? { x: obj.obb.center.x, y: obj.obb.center.y };
    const tall = obj.obb.size_z > GRAPH_CONSTANTS.TALL_Z_THRESHOLD_M;

    results.push({
      node_id: objectNodeId(obj.object_id),
      kind: "object",
      label: objectLabel(obj),
      source_entity_id: obj.object_id,
      object_id: obj.object_id,
      object_class: obj.class,
      obb: obj.obb,
      yaw_degrees: yaw,
      footprint_polygon: footprint,
      footprint_bounds: polygonBounds(footprint),
      forward_vector_xy: forward,
      tall,
      centroid,
    });
  }
  return results;
}

function dedupeNodeIds(nodes: GraphNode[], warnings: GraphWarning[]): void {
  const seen = new Map<string, GraphNode>();
  for (const node of nodes) {
    if (seen.has(node.node_id)) {
      warnings.push({
        code: "DUPLICATE_NODE_ID",
        entity_id: node.source_entity_id,
        message: `Duplicate node_id ${node.node_id}; first wins.`,
      });
    } else {
      seen.set(node.node_id, node);
    }
  }
}

// ---------------------------------------------------------------------------
// Edge builders — structural
// ---------------------------------------------------------------------------

function buildSupportsEdges(
  objects: readonly SceneObject[],
  floor: FloorNode,
  walls: readonly WallNode[],
  objectNodes: readonly ObjectNode[],
  warnings: GraphWarning[],
  nextEdgeId: () => string
): GraphEdge[] {
  const edges: GraphEdge[] = [];
  const wallBySurfaceId = new Map<EntityId, WallNode>();
  for (const wall of walls) {
    for (const surfaceId of wall.surface_ids) {
      wallBySurfaceId.set(surfaceId, wall);
    }
  }
  const objectNodeById = new Map<EntityId, ObjectNode>();
  for (const node of objectNodes) objectNodeById.set(node.object_id, node);

  // Cycle detection for object→object support chains
  const stack = new Set<EntityId>();
  const cyclic = new Set<EntityId>();
  function visit(objId: EntityId, trail: EntityId[]): void {
    if (stack.has(objId)) {
      for (const id of trail) cyclic.add(id);
      return;
    }
    stack.add(objId);
    const owner = objects.find((o) => o.object_id === objId);
    if (owner && owner.support.support_kind === "object") {
      const parent = owner.support.support_entity_id;
      if (parent) visit(parent, [...trail, objId]);
    }
    stack.delete(objId);
  }
  for (const obj of objects) {
    if (obj.support.support_kind === "object") visit(obj.object_id, [obj.object_id]);
  }

  for (const obj of objects) {
    const supportKind = obj.support.support_kind;
    const supportId = obj.support.support_entity_id;
    const targetNode = objectNodeById.get(obj.object_id);
    if (!targetNode) continue;

    if (supportKind === "floor") {
      edges.push({
        edge_id: nextEdgeId(),
        kind: "SUPPORTS",
        from_node_id: floor.node_id,
        to_node_id: targetNode.node_id,
        symmetric: false,
        strength: 1,
        evidence: { support_kind: "floor" },
      });
    } else if (supportKind === "wall") {
      const wall = supportId ? wallBySurfaceId.get(supportId) : undefined;
      if (wall) {
        edges.push({
          edge_id: nextEdgeId(),
          kind: "SUPPORTS",
          from_node_id: wall.node_id,
          to_node_id: targetNode.node_id,
          symmetric: false,
          strength: 1,
          evidence: { support_kind: "wall" },
        });
      } else {
        warnings.push({
          code: "ORPHAN_SUPPORT",
          entity_id: obj.object_id,
          message: `Object ${obj.object_id} wall support surface_id ${supportId} not found.`,
        });
      }
    } else if (supportKind === "object") {
      if (cyclic.has(obj.object_id)) {
        warnings.push({
          code: "SUPPORT_CYCLE",
          entity_id: obj.object_id,
          message: `Support chain through object ${obj.object_id} is cyclic; SUPPORTS edge suppressed.`,
        });
        continue;
      }
      const parent = supportId ? objectNodeById.get(supportId) : undefined;
      if (parent) {
        edges.push({
          edge_id: nextEdgeId(),
          kind: "SUPPORTS",
          from_node_id: parent.node_id,
          to_node_id: targetNode.node_id,
          symmetric: false,
          strength: 1,
          evidence: { support_kind: "object" },
        });
      } else {
        warnings.push({
          code: "ORPHAN_SUPPORT",
          entity_id: obj.object_id,
          message: `Object ${obj.object_id} object support id ${supportId} not found.`,
        });
      }
    } else if (supportKind === "ceiling") {
      edges.push({
        edge_id: nextEdgeId(),
        kind: "SUPPORTS",
        from_node_id: "ceiling",
        to_node_id: targetNode.node_id,
        symmetric: false,
        strength: 1,
        evidence: { support_kind: "ceiling" },
      });
    }
  }
  return edges;
}

function buildHostedOnEdges(
  objects: readonly SceneObject[],
  walls: readonly WallNode[],
  objectNodes: readonly ObjectNode[],
  _surfaces: readonly Surface[],
  nextEdgeId: () => string
): GraphEdge[] {
  const edges: GraphEdge[] = [];
  const wallBySurfaceId = new Map<EntityId, WallNode>();
  for (const wall of walls) {
    for (const surfaceId of wall.surface_ids) wallBySurfaceId.set(surfaceId, wall);
  }
  const objectNodeById = new Map<EntityId, ObjectNode>();
  for (const node of objectNodes) objectNodeById.set(node.object_id, node);

  for (const obj of objects) {
    if (!obj.host) continue;
    const hostWall = wallBySurfaceId.get(obj.host.host_surface_id);
    const target = objectNodeById.get(obj.object_id);
    if (!hostWall || !target) continue;
    edges.push({
      edge_id: nextEdgeId(),
      kind: "HOSTED_ON",
      from_node_id: target.node_id,
      to_node_id: hostWall.node_id,
      symmetric: false,
      strength: 1,
      evidence: { relation_type: obj.host.relation_type },
    });
  }
  return edges;
}

function buildContainsEdges(
  openings: readonly OpeningNode[],
  _walls: readonly WallNode[],
  nextEdgeId: () => string
): GraphEdge[] {
  const edges: GraphEdge[] = [];
  for (const opening of openings) {
    if (!opening.host_wall_node_id) continue;
    edges.push({
      edge_id: nextEdgeId(),
      kind: "CONTAINS",
      from_node_id: opening.host_wall_node_id,
      to_node_id: opening.node_id,
      symmetric: false,
      strength: 1,
      evidence: { opening_type: opening.type },
    });
  }
  return edges;
}

// ---------------------------------------------------------------------------
// Edge builders — geometric
// ---------------------------------------------------------------------------

function buildCollidesEdges(
  objects: readonly ObjectNode[],
  supportingPairKeys: ReadonlySet<string>,
  nextEdgeId: () => string
): GraphEdge[] {
  const edges: GraphEdge[] = [];
  for (let i = 0; i < objects.length; i += 1) {
    const a = objects[i]!;
    for (let j = i + 1; j < objects.length; j += 1) {
      const b = objects[j]!;
      if (!intersectsBounds(a.footprint_bounds, b.footprint_bounds)) continue;
      // Skip pairs already declared as a support relationship — a TV on
      // a dresser has an xy overlap *by design*.
      if (supportingPairKeys.has(pairKey(a.node_id, b.node_id))) continue;
      // Require the OBBs to actually share vertical space. A picture
      // frame mounted above a chair or a lamp on a table can have
      // significant footprint overlap without the solid parts colliding.
      const aTop = (a.obb.center.z ?? 0) + (a.obb.size_z ?? 0) / 2;
      const aBot = (a.obb.center.z ?? 0) - (a.obb.size_z ?? 0) / 2;
      const bTop = (b.obb.center.z ?? 0) + (b.obb.size_z ?? 0) / 2;
      const bBot = (b.obb.center.z ?? 0) - (b.obb.size_z ?? 0) / 2;
      const zOverlap = Math.min(aTop, bTop) - Math.max(aBot, bBot);
      if (zOverlap <= GRAPH_CONSTANTS.COLLIDE_MIN_Z_OVERLAP_M) continue;
      const overlap = polygonIntersectionArea(a.footprint_polygon, b.footprint_polygon);
      // Tucked-seating exemption: a chair pushed in at a table or desk
      // naturally overlaps in 2D because the seat projects under the
      // tabletop. Only flag if the overlap is large enough to be a real
      // clip rather than a normal tuck.
      const threshold = isTuckedSeatingPair(a, b)
        ? GRAPH_CONSTANTS.COLLIDE_MIN_OVERLAP_TUCKED_M2
        : GRAPH_CONSTANTS.COLLIDE_MIN_OVERLAP_M2;
      if (overlap > threshold) {
        edges.push({
          edge_id: nextEdgeId(),
          kind: "COLLIDES",
          from_node_id: a.node_id,
          to_node_id: b.node_id,
          symmetric: true,
          strength: Math.min(1, overlap / 0.5),
          evidence: {
            overlap_area_m2: round(overlap, 3),
            z_overlap_m: round(zOverlap, 3),
          },
        });
      }
    }
  }
  return edges;
}

function isTuckedSeatingPair(a: ObjectNode, b: ObjectNode): boolean {
  const SEATING_CLASSES = new Set<ObjectClass>(["chair"]);
  const SURFACE_CLASSES = new Set<ObjectClass>(["table", "desk"]);
  return (
    (SEATING_CLASSES.has(a.object_class) && SURFACE_CLASSES.has(b.object_class)) ||
    (SEATING_CLASSES.has(b.object_class) && SURFACE_CLASSES.has(a.object_class))
  );
}

function buildAdjacentEdges(
  objects: readonly ObjectNode[],
  collidingPairKeys: Set<string>,
  nextEdgeId: () => string
): GraphEdge[] {
  const edges: GraphEdge[] = [];
  const maxGap = GRAPH_CONSTANTS.ADJACENT_MAX_GAP_M;
  for (let i = 0; i < objects.length; i += 1) {
    const a = objects[i]!;
    for (let j = i + 1; j < objects.length; j += 1) {
      const b = objects[j]!;
      if (collidingPairKeys.has(pairKey(a.node_id, b.node_id))) continue;
      // Cheap reject: bounds gap beyond maxGap in either axis.
      const bx = a.footprint_bounds;
      const by = b.footprint_bounds;
      const dx = Math.max(0, Math.max(bx.min_x, by.min_x) - Math.min(bx.max_x, by.max_x));
      const dy = Math.max(0, Math.max(bx.min_y, by.min_y) - Math.min(bx.max_y, by.max_y));
      if (dx > maxGap || dy > maxGap) continue;
      const gap = polygonToPolygonGap(a.footprint_polygon, b.footprint_polygon);
      if (gap > maxGap) continue;
      const centroidDist = distance2D(a.centroid, b.centroid);
      edges.push({
        edge_id: nextEdgeId(),
        kind: "ADJACENT_TO",
        from_node_id: a.node_id,
        to_node_id: b.node_id,
        symmetric: true,
        strength: 1 - gap / maxGap,
        evidence: {
          polygon_gap_m: round(gap, 3),
          centroid_distance_m: round(centroidDist, 3),
        },
      });
    }
  }
  return edges;
}

function buildFacesEdges(
  objects: readonly ObjectNode[],
  walls: readonly WallNode[],
  openings: readonly OpeningNode[],
  nextEdgeId: () => string
): GraphEdge[] {
  const edges: GraphEdge[] = [];
  for (const source of objects) {
    if (source.forward_vector_xy.x === 0 && source.forward_vector_xy.y === 0) continue;
    // object→object
    for (const target of objects) {
      if (target.node_id === source.node_id) continue;
      const { dot, distance } = facingScore(source, target.centroid);
      if (distance > GRAPH_CONSTANTS.FACES_MAX_DISTANCE_M) continue;
      if (dot < GRAPH_CONSTANTS.FACES_MIN_DOT) continue;
      if (hasLineOfSightOccluder(source, target, objects)) continue;
      edges.push({
        edge_id: nextEdgeId(),
        kind: "FACES",
        from_node_id: source.node_id,
        to_node_id: target.node_id,
        symmetric: false,
        strength: round((dot - GRAPH_CONSTANTS.FACES_MIN_DOT) / (1 - GRAPH_CONSTANTS.FACES_MIN_DOT), 3),
        evidence: {
          dot: round(dot, 3),
          distance_m: round(distance, 3),
        },
      });
    }
    // object→opening
    for (const opening of openings) {
      if (!opening.centroid) continue;
      const { dot, distance } = facingScore(source, opening.centroid);
      if (distance > GRAPH_CONSTANTS.FACES_MAX_DISTANCE_M) continue;
      if (dot < GRAPH_CONSTANTS.FACES_MIN_DOT) continue;
      edges.push({
        edge_id: nextEdgeId(),
        kind: "FACES",
        from_node_id: source.node_id,
        to_node_id: opening.node_id,
        symmetric: false,
        strength: round((dot - GRAPH_CONSTANTS.FACES_MIN_DOT) / (1 - GRAPH_CONSTANTS.FACES_MIN_DOT), 3),
        evidence: { dot: round(dot, 3), distance_m: round(distance, 3) },
      });
    }
    // object→wall (uses wall centroid; good enough for Phase 1)
    for (const wall of walls) {
      if (wall.segments.length === 0) continue;
      const { dot, distance } = facingScore(source, wall.centroid);
      if (distance > GRAPH_CONSTANTS.FACES_MAX_DISTANCE_M) continue;
      if (dot < GRAPH_CONSTANTS.FACES_MIN_DOT) continue;
      edges.push({
        edge_id: nextEdgeId(),
        kind: "FACES",
        from_node_id: source.node_id,
        to_node_id: wall.node_id,
        symmetric: false,
        strength: round((dot - GRAPH_CONSTANTS.FACES_MIN_DOT) / (1 - GRAPH_CONSTANTS.FACES_MIN_DOT), 3),
        evidence: { dot: round(dot, 3), distance_m: round(distance, 3) },
      });
    }
  }
  return edges;
}

function buildParallelToEdges(
  objects: readonly ObjectNode[],
  walls: readonly WallNode[],
  nextEdgeId: () => string
): GraphEdge[] {
  const edges: GraphEdge[] = [];
  const tolerance = GRAPH_CONSTANTS.PARALLEL_YAW_TOLERANCE_DEG;
  for (const obj of objects) {
    for (const wall of walls) {
      // A wall's orientation is defined by its inward normal vector;
      // the azimuth field (a compass-label, 0/90/180/270) often does
      // not match the normal direction in real RoomPlan captures
      // where rooms are rotated off the cardinal axes. Use the normal
      // direction instead so "parallel" genuinely means aligned with
      // the wall's physical axes.
      const wallNormalDeg = (Math.atan2(wall.inward_normal_xy.y, wall.inward_normal_xy.x) * 180) / Math.PI;
      const delta = parallelYawDelta(obj.yaw_degrees, wallNormalDeg);
      if (delta > tolerance) continue;
      if (wall.segments.length === 0) continue;
      let nearestDistance = Infinity;
      for (const seg of wall.segments) {
        const d = polygonToSegmentDistance(obj.footprint_polygon, seg.a, seg.b);
        if (d < nearestDistance) nearestDistance = d;
      }
      if (nearestDistance > GRAPH_CONSTANTS.PARALLEL_MAX_WALL_DISTANCE_M) continue;
      edges.push({
        edge_id: nextEdgeId(),
        kind: "PARALLEL_TO",
        from_node_id: obj.node_id,
        to_node_id: wall.node_id,
        symmetric: false,
        strength: round(1 - delta / tolerance, 3),
        evidence: {
          yaw_delta_deg: round(delta, 3),
          wall_distance_m: round(nearestDistance, 3),
        },
      });
    }
  }
  return edges;
}

function buildOpeningProximityEdges(
  objects: readonly ObjectNode[],
  openings: readonly OpeningNode[],
  nextEdgeId: () => string
): GraphEdge[] {
  const edges: GraphEdge[] = [];
  for (const obj of objects) {
    for (const opening of openings) {
      if (!opening.floor_segment) continue;
      const distance = polygonToSegmentDistance(
        obj.footprint_polygon,
        opening.floor_segment.a,
        opening.floor_segment.b
      );
      if (opening.ingress_polygon) {
        const overlap = polygonIntersectionArea(obj.footprint_polygon, opening.ingress_polygon);
        if (overlap > 0.02) {
          edges.push({
            edge_id: nextEdgeId(),
            kind: "OBSTRUCTS",
            from_node_id: obj.node_id,
            to_node_id: opening.node_id,
            symmetric: false,
            strength: Math.min(1, overlap / polygonArea(opening.ingress_polygon)),
            evidence: {
              overlap_area_m2: round(overlap, 3),
              ingress_area_m2: round(polygonArea(opening.ingress_polygon), 3),
            },
          });
        }
      }
      if (distance <= GRAPH_CONSTANTS.NEAR_OPENING_MAX_M) {
        edges.push({
          edge_id: nextEdgeId(),
          kind: "NEAR_OPENING",
          from_node_id: obj.node_id,
          to_node_id: opening.node_id,
          symmetric: false,
          strength: round(1 - distance / GRAPH_CONSTANTS.NEAR_OPENING_MAX_M, 3),
          evidence: { distance_m: round(distance, 3) },
        });
      }
    }
  }
  return edges;
}

function buildFlanksEdges(
  objects: readonly ObjectNode[],
  existingEdges: readonly GraphEdge[],
  nextEdgeId: () => string
): GraphEdge[] {
  const adjMap = new Map<string, GraphEdge>();
  for (const e of existingEdges) {
    if (e.kind === "ADJACENT_TO") {
      adjMap.set(pairKey(e.from_node_id, e.to_node_id), e);
    }
  }
  const edges: GraphEdge[] = [];
  // Typical pattern: pair of objects of the same non-bed class, both
  // adjacent to a shared third node (the bed), with matching yaw and
  // comparable size_z. We emit FLANKS between the pair (not the bed).
  const beds = objects.filter((o) => o.object_class === "bed");
  const candidates = objects.filter((o) => o.object_class !== "bed");
  for (const bed of beds) {
    // find objects adjacent to the bed
    const adjacentToBed: ObjectNode[] = [];
    for (const c of candidates) {
      if (adjMap.has(pairKey(bed.node_id, c.node_id))) adjacentToBed.push(c);
    }
    // pair them up
    for (let i = 0; i < adjacentToBed.length; i += 1) {
      const a = adjacentToBed[i]!;
      for (let j = i + 1; j < adjacentToBed.length; j += 1) {
        const b = adjacentToBed[j]!;
        if (a.object_class !== b.object_class) continue;
        const yawDelta = parallelYawDelta(a.yaw_degrees, b.yaw_degrees);
        if (yawDelta > GRAPH_CONSTANTS.FLANKS_YAW_TOLERANCE_DEG) continue;
        const ratio = safeRatio(a.obb.size_z, b.obb.size_z);
        if (ratio < GRAPH_CONSTANTS.FLANKS_SIZE_RATIO_MIN || ratio > GRAPH_CONSTANTS.FLANKS_SIZE_RATIO_MAX) {
          continue;
        }
        edges.push({
          edge_id: nextEdgeId(),
          kind: "FLANKS",
          from_node_id: a.node_id,
          to_node_id: b.node_id,
          symmetric: true,
          strength: 1 - yawDelta / GRAPH_CONSTANTS.FLANKS_YAW_TOLERANCE_DEG,
          evidence: {
            shared_neighbour_node_id: bed.node_id,
            yaw_delta_deg: round(yawDelta, 3),
            size_z_ratio: round(ratio, 3),
          },
        });
      }
    }
  }
  return edges;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function objectNodeId(id: EntityId): string {
  return `object:${id}`;
}
function wallNodeId(id: EntityId): string {
  return `wall:${id}`;
}
function openingNodeId(id: EntityId): string {
  return `opening:${id}`;
}

function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function safeRatio(a: number, b: number): number {
  if (a === 0 && b === 0) return 1;
  if (a === 0 || b === 0) return Infinity;
  return Math.min(a, b) / Math.max(a, b);
}

function normaliseYawDegrees(yaw: number): number {
  const wrapped = ((yaw % 360) + 540) % 360 - 180;
  return wrapped;
}

function forwardVectorXY(yawDegrees: number): Point2D {
  const r = (yawDegrees * Math.PI) / 180;
  return { x: Math.cos(r), y: Math.sin(r) };
}

function polygonCentroid(polygon: Polygon2D): Point2D | null {
  const verts = polygon.vertices;
  if (verts.length < 3) return null;
  let twiceArea = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < verts.length; i += 1) {
    const a = verts[i]!;
    const b = verts[(i + 1) % verts.length]!;
    const cross = a.x * b.y - b.x * a.y;
    twiceArea += cross;
    cx += (a.x + b.x) * cross;
    cy += (a.y + b.y) * cross;
  }
  if (Math.abs(twiceArea) < 1e-12) {
    // Degenerate; fall back to vertex mean.
    let sx = 0;
    let sy = 0;
    for (const v of verts) {
      sx += v.x;
      sy += v.y;
    }
    return { x: sx / verts.length, y: sy / verts.length };
  }
  const factor = 1 / (3 * twiceArea);
  return { x: cx * factor, y: cy * factor };
}

function floorPolygonEdges(floor: Polygon2D): Array<{ a: Point2D; b: Point2D; normal: Point2D; length: number }> {
  const edges: Array<{ a: Point2D; b: Point2D; normal: Point2D; length: number }> = [];
  const verts = floor.vertices;
  for (let i = 0; i < verts.length; i += 1) {
    const a = verts[i]!;
    const b = verts[(i + 1) % verts.length]!;
    const ex = b.x - a.x;
    const ey = b.y - a.y;
    const len = Math.hypot(ex, ey);
    if (len < 1e-6) continue;
    // CCW floor ⇒ inward normal = (+90° rotation of edge) / len = (-ey, ex) / len.
    const nx = -ey / len;
    const ny = ex / len;
    edges.push({ a, b, normal: { x: nx, y: ny }, length: len });
  }
  return edges;
}

function matchFloorEdgesToWall(
  edges: Array<{ a: Point2D; b: Point2D; normal: Point2D; length: number }>,
  wall: NamedWallRef
): Array<{ a: Point2D; b: Point2D; length_m: number }> {
  const result: Array<{ a: Point2D; b: Point2D; length_m: number }> = [];
  for (const edge of edges) {
    const dot = edge.normal.x * wall.inward_normal_xy.x + edge.normal.y * wall.inward_normal_xy.y;
    // Normals aligned within ~15° (cos 15° ≈ 0.966). We keep it slightly
    // looser to tolerate RoomPlan's rounded normals.
    if (dot > 0.94) {
      result.push({ a: edge.a, b: edge.b, length_m: edge.length });
    }
  }
  return result;
}

function longestSegmentMidpoint(segments: Array<{ a: Point2D; b: Point2D; length_m: number }>): Point2D {
  let best = segments[0]!;
  for (const s of segments) if (s.length_m > best.length_m) best = s;
  return { x: (best.a.x + best.b.x) / 2, y: (best.a.y + best.b.y) / 2 };
}

function projectOpeningToFloor(opening: Opening, wall: WallNode): { a: Point2D; b: Point2D } | null {
  // The opening's rect_on_surface has min_u and width along the wall's
  // horizontal axis. RoomPlan uses a wall-local frame where u runs along
  // the surface's horizontal. We approximate by taking the wall's
  // longest floor segment (its dominant stretch) and slicing a sub-segment
  // of width `rect.width` starting at `rect.min_u`. min_u can exceed
  // segment length when surfaces inside a wall are split; clamp.
  if (wall.segments.length === 0) return null;
  // Pick the segment that the opening most likely sits on: if only one,
  // take it; otherwise pick the longest. Good enough for Phase 1.
  let best = wall.segments[0]!;
  for (const s of wall.segments) if (s.length_m > best.length_m) best = s;
  const total = best.length_m;
  const dx = (best.b.x - best.a.x) / total;
  const dy = (best.b.y - best.a.y) / total;
  const startOffset = clamp(opening.rect.min_u, 0, total);
  const endOffset = clamp(opening.rect.min_u + opening.rect.width, 0, total);
  return {
    a: { x: best.a.x + dx * startOffset, y: best.a.y + dy * startOffset },
    b: { x: best.a.x + dx * endOffset, y: best.a.y + dy * endOffset },
  };
}

function buildIngressPolygon(
  segment: { a: Point2D; b: Point2D },
  inwardNormal: Point2D
): Polygon2D {
  const nx = inwardNormal.x;
  const ny = inwardNormal.y;
  const mag = Math.hypot(nx, ny) || 1;
  const ux = (nx / mag) * GRAPH_CONSTANTS.INGRESS_DEPTH_M;
  const uy = (ny / mag) * GRAPH_CONSTANTS.INGRESS_DEPTH_M;
  return {
    vertices: [
      segment.a,
      segment.b,
      { x: segment.b.x + ux, y: segment.b.y + uy },
      { x: segment.a.x + ux, y: segment.a.y + uy },
    ],
  };
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function facingScore(source: ObjectNode, target: Point2D): { dot: number; distance: number } {
  const dx = target.x - source.centroid.x;
  const dy = target.y - source.centroid.y;
  const dist = Math.hypot(dx, dy);
  if (dist < 1e-6) return { dot: 0, distance: 0 };
  const ux = dx / dist;
  const uy = dy / dist;
  const dot = source.forward_vector_xy.x * ux + source.forward_vector_xy.y * uy;
  return { dot, distance: dist };
}

function hasLineOfSightOccluder(
  source: ObjectNode,
  target: ObjectNode,
  objects: readonly ObjectNode[]
): boolean {
  const a = source.centroid;
  const b = target.centroid;
  for (const other of objects) {
    if (other.node_id === source.node_id || other.node_id === target.node_id) continue;
    if (segmentIntersectsPolygon(a, b, other.footprint_polygon)) return true;
  }
  return false;
}

function segmentIntersectsPolygon(a: Point2D, b: Point2D, polygon: Polygon2D): boolean {
  // If either endpoint is inside, the segment touches the polygon.
  if (pointInPolygon(a.x, a.y, polygon) || pointInPolygon(b.x, b.y, polygon)) return true;
  const verts = polygon.vertices;
  for (let i = 0; i < verts.length; i += 1) {
    const p = verts[i]!;
    const q = verts[(i + 1) % verts.length]!;
    if (segmentsIntersect(a, b, p, q)) return true;
  }
  return false;
}

function segmentsIntersect(p1: Point2D, p2: Point2D, p3: Point2D, p4: Point2D): boolean {
  const d1 = cross(p4.x - p3.x, p4.y - p3.y, p1.x - p3.x, p1.y - p3.y);
  const d2 = cross(p4.x - p3.x, p4.y - p3.y, p2.x - p3.x, p2.y - p3.y);
  const d3 = cross(p2.x - p1.x, p2.y - p1.y, p3.x - p1.x, p3.y - p1.y);
  const d4 = cross(p2.x - p1.x, p2.y - p1.y, p4.x - p1.x, p4.y - p1.y);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) {
    return true;
  }
  return false;
}

function cross(ax: number, ay: number, bx: number, by: number): number {
  return ax * by - ay * bx;
}

function parallelYawDelta(yawA: number, azimuth: number): number {
  // Two orientations are parallel if their yaw differs by 0° or 180°;
  // perpendicular if 90° or 270°. We return the minimum over all four
  // so objects flush against a wall register regardless of whether
  // they're "facing into" or "back-to" the wall.
  const deltas = [0, 90, 180, 270].map((k) => {
    const d = Math.abs(normaliseYawDegrees(yawA - azimuth - k));
    return Math.min(d, 360 - d);
  });
  return Math.min(...deltas);
}

function polygonToPolygonGap(a: Polygon2D, b: Polygon2D): number {
  // Minimum distance between two polygons. Zero when they touch or
  // overlap. We use vertex-to-edge distance both ways; fine for convex
  // inputs, conservatively large for non-convex.
  if (polygonsIntersect(a, b)) return 0;
  let best = Infinity;
  for (const v of a.vertices) best = Math.min(best, polygonVertexDistance(v, b));
  for (const v of b.vertices) best = Math.min(best, polygonVertexDistance(v, a));
  return best;
}

function polygonsIntersect(a: Polygon2D, b: Polygon2D): boolean {
  // Any vertex inside? Any edge crossing?
  for (const v of a.vertices) if (pointInPolygon(v.x, v.y, b)) return true;
  for (const v of b.vertices) if (pointInPolygon(v.x, v.y, a)) return true;
  const av = a.vertices;
  const bv = b.vertices;
  for (let i = 0; i < av.length; i += 1) {
    const p1 = av[i]!;
    const p2 = av[(i + 1) % av.length]!;
    for (let j = 0; j < bv.length; j += 1) {
      const p3 = bv[j]!;
      const p4 = bv[(j + 1) % bv.length]!;
      if (segmentsIntersect(p1, p2, p3, p4)) return true;
    }
  }
  return false;
}

function polygonVertexDistance(v: Point2D, polygon: Polygon2D): number {
  let best = Infinity;
  const verts = polygon.vertices;
  for (let i = 0; i < verts.length; i += 1) {
    const a = verts[i]!;
    const b = verts[(i + 1) % verts.length]!;
    best = Math.min(best, pointToSegmentDistance(v, a, b));
  }
  return best;
}

function pointToSegmentDistance(p: Point2D, a: Point2D, b: Point2D): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-12) {
    return distance2D(p, a);
  }
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  t = clamp(t, 0, 1);
  return distance2D(p, { x: a.x + t * dx, y: a.y + t * dy });
}

function polygonToSegmentDistance(polygon: Polygon2D, a: Point2D, b: Point2D): number {
  let best = Infinity;
  for (const v of polygon.vertices) best = Math.min(best, pointToSegmentDistance(v, a, b));
  // If the segment passes through the polygon, distance is zero.
  if (segmentIntersectsPolygon(a, b, polygon)) return 0;
  return best;
}

function distance2D(a: Point2D, b: Point2D): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

function objectLabel(obj: SceneObject): string {
  return obj.attributes && obj.attributes.length > 0
    ? `${obj.attributes[0]} ${obj.class}`
    : String(obj.class);
}

function openingLabel(opening: Opening, wall: WallNode | null): string {
  return wall ? `${opening.type} · ${wall.name}` : opening.type;
}
