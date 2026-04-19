/**
 * Shared OBJECT_OVERLAP policy for ingest and mutation validation.
 *
 * Two independent copies of this check used to live in roomplan-ingest.ts
 * and mutation-engine.ts and drifted: ingest flagged any AABB intersection
 * while the mutation engine only flagged intersection areas above a
 * threshold. That meant a freshly-scanned room could land with
 * "hard violations" the mutation engine wouldn't have flagged, and every
 * subsequent edit inherited them and threw.
 *
 * One shared definition avoids the drift. The policy:
 *
 *   - `canObjectsLegallyOverlap` covers structural reasons two OBBs are
 *     allowed to coincide (non-floor-supported pair, rug, parent/child).
 *   - `isTolerableFurnitureOverlap` covers physical-reality reasons
 *     furniture boxes can touch without being a bug: shared wall-mount
 *     clusters, nightstand/lamp neighbors, chairs tucked under desks
 *     or tables. Small cabinet-cluster-style overlaps are tolerated;
 *     chair-under-desk is tolerated at any size because that is the
 *     literal physical configuration.
 *   - `exceedsOverlapThreshold` is the coarse area gate applied when
 *     neither of the above exemptions fires.
 *
 * Call `findHardObjectOverlaps` with an iterable of SceneObjects; it
 * returns pairs that should be reported as `OBJECT_OVERLAP` hard
 * violations. Callers can wrap each pair in their own violation struct.
 */
import type { ObjectClass, OBB3D, Point2D, Polygon2D, SceneObject } from "@roomview/contracts";

const HARD_OVERLAP_AREA_THRESHOLD_M2 = 0.18;
const WALL_CLUSTER_SMALLER_AREA_M2 = 0.35;

const CHAIR_TUCK_UNDER_CLASSES = new Set<ObjectClass>(["desk", "table"]);

export interface HardOverlap {
  left: SceneObject;
  right: SceneObject;
  overlap_area_m2: number;
}

export function canObjectsLegallyOverlap(left: SceneObject, right: SceneObject): boolean {
  if (left.support.support_kind !== "floor" || right.support.support_kind !== "floor") {
    return true;
  }
  if (left.class === "rug" || right.class === "rug") {
    return true;
  }
  if (left.parent_id === right.object_id || right.parent_id === left.object_id) {
    return true;
  }
  return false;
}

export function isTolerableFurnitureOverlap(left: SceneObject, right: SceneObject, smallerAreaM2: number): boolean {
  const leftClass = left.class;
  const rightClass = right.class;

  // Chairs tuck under desks and tables. Physical reality — not a bug —
  // so allow regardless of overlap size.
  if (
    (leftClass === "chair" && CHAIR_TUCK_UNDER_CLASSES.has(rightClass)) ||
    (rightClass === "chair" && CHAIR_TUCK_UNDER_CLASSES.has(leftClass))
  ) {
    return true;
  }

  // Wall-mount clusters: nightstands beside beds, lamps beside
  // nightstands, decor mounted on the same wall. These sit close by
  // design and may have slightly overlapping annotations. Tolerated
  // only when the smaller footprint is modest.
  const sharedHostSurface =
    (left.host?.host_surface_id && left.host.host_surface_id === right.host?.host_surface_id) ?? false;
  const hasNightstand = leftClass === "nightstand" || rightClass === "nightstand";
  const hasLamp = leftClass === "lamp" || rightClass === "lamp";
  if ((sharedHostSurface || hasNightstand || hasLamp) && smallerAreaM2 <= WALL_CLUSTER_SMALLER_AREA_M2) {
    return true;
  }

  return false;
}

export function exceedsOverlapThreshold(overlapAreaM2: number): boolean {
  return overlapAreaM2 > HARD_OVERLAP_AREA_THRESHOLD_M2;
}

export function footprintFromObb(obb: OBB3D): Polygon2D {
  const halfX = obb.size_x / 2;
  const halfY = obb.size_y / 2;
  const radians = (obb.yaw_degrees * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const corners: Point2D[] = [
    { x: -halfX, y: -halfY },
    { x: halfX, y: -halfY },
    { x: halfX, y: halfY },
    { x: -halfX, y: halfY },
  ];
  return {
    vertices: corners.map((corner) => ({
      x: obb.center.x + corner.x * cos - corner.y * sin,
      y: obb.center.y + corner.x * sin + corner.y * cos,
    })),
  };
}

export interface AABB2D {
  min_x: number;
  max_x: number;
  min_y: number;
  max_y: number;
}

export function polygonBounds(polygon: Polygon2D): AABB2D {
  let min_x = Infinity;
  let max_x = -Infinity;
  let min_y = Infinity;
  let max_y = -Infinity;
  for (const vertex of polygon.vertices) {
    if (vertex.x < min_x) min_x = vertex.x;
    if (vertex.x > max_x) max_x = vertex.x;
    if (vertex.y < min_y) min_y = vertex.y;
    if (vertex.y > max_y) max_y = vertex.y;
  }
  return { min_x, max_x, min_y, max_y };
}

export function boundsArea(bounds: AABB2D): number {
  return Math.max(0, bounds.max_x - bounds.min_x) * Math.max(0, bounds.max_y - bounds.min_y);
}

export function intersectsBounds(a: AABB2D, b: AABB2D): boolean {
  return !(a.max_x <= b.min_x || a.min_x >= b.max_x || a.max_y <= b.min_y || a.min_y >= b.max_y);
}

export function intersectionArea(a: AABB2D, b: AABB2D): number {
  const overlapX = Math.max(0, Math.min(a.max_x, b.max_x) - Math.max(a.min_x, b.min_x));
  const overlapY = Math.max(0, Math.min(a.max_y, b.max_y) - Math.max(a.min_y, b.min_y));
  return overlapX * overlapY;
}

export function findHardObjectOverlaps(objects: readonly SceneObject[]): HardOverlap[] {
  const overlaps: HardOverlap[] = [];
  for (let index = 0; index < objects.length; index += 1) {
    const left = objects[index]!;
    const leftBounds = polygonBounds(footprintFromObb(left.obb));
    for (let inner = index + 1; inner < objects.length; inner += 1) {
      const right = objects[inner]!;
      if (canObjectsLegallyOverlap(left, right)) {
        continue;
      }
      const rightBounds = polygonBounds(footprintFromObb(right.obb));
      if (!intersectsBounds(leftBounds, rightBounds)) {
        continue;
      }
      const overlapArea = intersectionArea(leftBounds, rightBounds);
      const smallerArea = Math.min(boundsArea(leftBounds), boundsArea(rightBounds));
      if (isTolerableFurnitureOverlap(left, right, smallerArea)) {
        continue;
      }
      if (exceedsOverlapThreshold(overlapArea)) {
        overlaps.push({ left, right, overlap_area_m2: overlapArea });
      }
    }
  }
  return overlaps;
}
