/**
 * Hard-violation policy — physics-only, two rules.
 *
 * History note: this file used to carry a small zoo of exemptions
 * (canObjectsLegallyOverlap, isTolerableFurnitureOverlap, wall-cluster
 * tolerances, chair-tuck-under-desk, rug special cases) that existed to
 * paper over OBB-sized footprints that were loose by several cm. Now
 * that each object's `footprint_polygon` is the true mesh-derived shape,
 * real collisions and non-collisions separate cleanly on geometry alone
 * and the exemptions are dead weight.
 *
 * Kept rules:
 *   - OBJECT_OVERLAP: two floor-supported objects whose footprint
 *     polygons intersect by more than a small epsilon. No class-aware
 *     exemptions — if they really touch, the geometry says so.
 *   - OUT_OF_BOUNDS: object's footprint majority-outside the floor
 *     polygon (enforced at the caller; this module's helpers power it).
 *
 * Dropped rules:
 *   - OPENING_BLOCKED / CLEARANCE_VIOLATION — they depended on keepout
 *     zones RoomPlan produces unreliably and on arbitrary walkway
 *     thresholds. They belong in a future soft-scoring layer, not in
 *     hard violations.
 */
import type { OBB3D, Point2D, Polygon2D, SceneObject } from "@roomview/contracts";

// 0.05 m² ≈ 22 cm × 22 cm. Large enough to be visibly a collision,
// small enough that real furniture-on-furniture contact (two
// floor-supported pieces pushed together) still registers. Mesh bleed
// at object boundaries typically sits at 0.005–0.03 m² — below this.
const HARD_OVERLAP_AREA_THRESHOLD_M2 = 0.05;

// Two objects whose footprints intersect in XY can still be physically
// non-colliding if they occupy different Z ranges — a rug under a bed,
// a wall-mounted shelf above a dresser, or two storage cabinets at
// different shelf heights (common in captured LiDAR where "storage" is
// a catch-all class). Require ≥10 cm of shared vertical space before
// counting as a hard violation. Matches scene-graph's COLLIDE_MIN_Z_OVERLAP_M
// so the two systems agree on what a collision is.
const HARD_OVERLAP_MIN_Z_OVERLAP_M = 0.10;

export interface HardOverlap {
  left: SceneObject;
  right: SceneObject;
  overlap_area_m2: number;
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

/**
 * Return the object's tight mesh-derived footprint when available,
 * otherwise fall back to the OBB rectangle. Prefer this over
 * `footprintFromObb(obj.obb)` in any validation or layout path so the
 * engine uses the truest-known shape for overlap / bounds / clearance
 * checks.
 */
export function footprintForObject(object: SceneObject): Polygon2D {
  const stored = object.footprint_polygon;
  if (stored && Array.isArray(stored.vertices) && stored.vertices.length >= 3) {
    return { vertices: stored.vertices };
  }
  return footprintFromObb(object.obb);
}

/**
 * Signed area of a polygon (shoelace). Positive for CCW, negative for CW.
 */
function polygonSignedArea(vertices: readonly Point2D[]): number {
  if (vertices.length < 3) return 0;
  let sum = 0;
  for (let i = 0; i < vertices.length; i += 1) {
    const a = vertices[i]!;
    const b = vertices[(i + 1) % vertices.length]!;
    sum += a.x * b.y - b.x * a.y;
  }
  return sum / 2;
}

export function polygonArea(polygon: Polygon2D): number {
  return Math.abs(polygonSignedArea(polygon.vertices));
}

function ensureCCW(vertices: readonly Point2D[]): Point2D[] {
  return polygonSignedArea(vertices) < 0 ? [...vertices].reverse() : [...vertices];
}

function segmentIntersection(p1: Point2D, p2: Point2D, p3: Point2D, p4: Point2D): Point2D {
  // Line-line intersection assuming non-parallel inputs (true for convex-polygon
  // clipping when a prev/curr pair straddles a clip edge).
  const d1x = p2.x - p1.x;
  const d1y = p2.y - p1.y;
  const d2x = p4.x - p3.x;
  const d2y = p4.y - p3.y;
  const denom = d1x * d2y - d1y * d2x;
  if (Math.abs(denom) < 1e-12) return p2;
  const t = ((p3.x - p1.x) * d2y - (p3.y - p1.y) * d2x) / denom;
  return { x: p1.x + t * d1x, y: p1.y + t * d1y };
}

/**
 * Sutherland-Hodgman convex polygon clipping. Returns the subject polygon
 * clipped against the clip polygon. REQUIRES the clip polygon to be
 * convex (subject can be any simple polygon). Both inputs must be
 * CCW-ordered. Returns an empty array when the polygons don't overlap.
 */
function clipConvex(subject: readonly Point2D[], clip: readonly Point2D[]): Point2D[] {
  let output: Point2D[] = [...subject];
  for (let i = 0; i < clip.length; i += 1) {
    if (output.length === 0) return [];
    const a = clip[i]!;
    const b = clip[(i + 1) % clip.length]!;
    const edgeX = b.x - a.x;
    const edgeY = b.y - a.y;
    const input = output;
    output = [];
    const insideOf = (p: Point2D) => edgeX * (p.y - a.y) - edgeY * (p.x - a.x) >= 0;
    for (let j = 0; j < input.length; j += 1) {
      const curr = input[j]!;
      const prev = input[(j - 1 + input.length) % input.length]!;
      const currIn = insideOf(curr);
      const prevIn = insideOf(prev);
      if (currIn) {
        if (!prevIn) output.push(segmentIntersection(prev, curr, a, b));
        output.push(curr);
      } else if (prevIn) {
        output.push(segmentIntersection(prev, curr, a, b));
      }
    }
  }
  return output;
}

/**
 * True polygon-vs-polygon intersection area. Both inputs must be
 * convex for the Sutherland-Hodgman path below to return a correct
 * result. Convex hulls from scipy (what extract-object-footprints.py
 * produces) satisfy this. For mixed cases, callers should fall back to
 * `intersectionArea(polygonBounds(a), polygonBounds(b))`.
 */
export function polygonIntersectionArea(a: Polygon2D, b: Polygon2D): number {
  if (a.vertices.length < 3 || b.vertices.length < 3) return 0;
  const subject = ensureCCW(a.vertices);
  const clip = ensureCCW(b.vertices);
  const clipped = clipConvex(subject, clip);
  if (clipped.length < 3) return 0;
  return Math.abs(polygonSignedArea(clipped));
}

/**
 * Point-in-polygon via ray casting. Handles non-convex polygons.
 */
export function pointInPolygon(px: number, py: number, polygon: Polygon2D): boolean {
  const verts = polygon.vertices;
  let inside = false;
  for (let i = 0, j = verts.length - 1; i < verts.length; j = i, i += 1) {
    const xi = verts[i]!.x;
    const yi = verts[i]!.y;
    const xj = verts[j]!.x;
    const yj = verts[j]!.y;
    const intersect = ((yi > py) !== (yj > py)) && px < ((xj - xi) * (py - yi)) / ((yj - yi) || 1e-12) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

/**
 * True iff every vertex of `inner` is inside `outer`. For typical
 * room-floor / object-footprint pairs this is equivalent to containment
 * since object footprints are convex.
 */
export function polygonContainsPolygon(outer: Polygon2D, inner: Polygon2D): boolean {
  for (const v of inner.vertices) {
    if (!pointInPolygon(v.x, v.y, outer)) return false;
  }
  return true;
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
  const footprints = objects.map((obj) => footprintForObject(obj));
  const bounds = footprints.map((fp) => polygonBounds(fp));

  for (let index = 0; index < objects.length; index += 1) {
    const left = objects[index]!;
    // Only floor-supported objects can physically collide. Wall-mounted
    // art, ceiling fixtures, things on-top-of other things don't need
    // to fight for floor space.
    if (left.support.support_kind !== "floor") continue;
    for (let inner = index + 1; inner < objects.length; inner += 1) {
      const right = objects[inner]!;
      if (right.support.support_kind !== "floor") continue;
      if (!intersectsBounds(bounds[index]!, bounds[inner]!)) continue;
      if (!sharesVerticalSpace(left.obb, right.obb)) continue;
      const overlapArea = polygonIntersectionArea(footprints[index]!, footprints[inner]!);
      if (exceedsOverlapThreshold(overlapArea)) {
        overlaps.push({ left, right, overlap_area_m2: overlapArea });
      }
    }
  }
  return overlaps;
}

function sharesVerticalSpace(a: OBB3D, b: OBB3D): boolean {
  const aTop = (a.center.z ?? 0) + (a.size_z ?? 0) / 2;
  const aBot = (a.center.z ?? 0) - (a.size_z ?? 0) / 2;
  const bTop = (b.center.z ?? 0) + (b.size_z ?? 0) / 2;
  const bBot = (b.center.z ?? 0) - (b.size_z ?? 0) / 2;
  return Math.min(aTop, bTop) - Math.max(aBot, bBot) > HARD_OVERLAP_MIN_Z_OVERLAP_M;
}
