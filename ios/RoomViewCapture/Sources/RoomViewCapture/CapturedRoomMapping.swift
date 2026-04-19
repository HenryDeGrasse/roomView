import Foundation
import simd

#if canImport(RoomPlan)
import RoomPlan
#endif

// MARK: - Public input model
//
// `RoomPlanMapperInputs` mirrors the subset of `CapturedRoom` that the mapper
// consumes. Tests construct it directly with synthetic values; real app code
// builds it from a live `CapturedRoom` via the adapter below. Keeping the
// mapper pure (no RoomPlan import) lets `swift test` run on Linux-flavored
// CI too.
public struct RoomPlanMapperInputs: Equatable, Sendable {
    public enum SurfaceCategory: String, Equatable, Sendable {
        case wall
        case door
        case window
        case opening
        case floor
    }

    public enum ObjectCategory: String, Equatable, Sendable {
        case bed, sofa, chair, table, storage, television
        case refrigerator, stove, sink, washerDryer, toilet, bathtub, oven, dishwasher, fireplace, stairs
        case unknown
    }

    public struct Surface: Equatable, Sendable {
        public let identifier: UUID
        public let category: SurfaceCategory
        /// ARKit world-frame transform (Y-up, right-handed). Translation is the
        /// surface origin (Apple places it at the wall/floor center).
        public let transform: simd_float4x4
        /// (width, height, thickness). Wall width runs along the surface's
        /// local +X; height along local +Y; thickness along local +Z.
        public let dimensions: simd_float3
        /// Non-nil for openings; points at the host wall (iOS 17+).
        public let parentIdentifier: UUID?
        /// World-frame corner points (iOS 17+). Typically set for floors; may
        /// be empty for walls.
        public let polygonCorners: [simd_float3]

        public init(
            identifier: UUID,
            category: SurfaceCategory,
            transform: simd_float4x4,
            dimensions: simd_float3,
            parentIdentifier: UUID? = nil,
            polygonCorners: [simd_float3] = []
        ) {
            self.identifier = identifier
            self.category = category
            self.transform = transform
            self.dimensions = dimensions
            self.parentIdentifier = parentIdentifier
            self.polygonCorners = polygonCorners
        }
    }

    public struct Object: Equatable, Sendable {
        public let identifier: UUID
        public let category: ObjectCategory
        public let transform: simd_float4x4
        public let dimensions: simd_float3
        public let attributes: [String]

        public init(
            identifier: UUID,
            category: ObjectCategory,
            transform: simd_float4x4,
            dimensions: simd_float3,
            attributes: [String] = []
        ) {
            self.identifier = identifier
            self.category = category
            self.transform = transform
            self.dimensions = dimensions
            self.attributes = attributes
        }
    }

    public let walls: [Surface]
    public let floors: [Surface]
    public let doors: [Surface]
    public let windows: [Surface]
    public let objects: [Object]

    public init(
        walls: [Surface] = [],
        floors: [Surface] = [],
        doors: [Surface] = [],
        windows: [Surface] = [],
        objects: [Object] = []
    ) {
        self.walls = walls
        self.floors = floors
        self.doors = doors
        self.windows = windows
        self.objects = objects
    }
}

// MARK: - Errors

public enum RoomPlanMapperError: Error, Equatable, Sendable {
    case noWalls
    case degenerateFloor
}

// MARK: - Public entry point

public enum RoomPlanPayloadMapper {
    /// Convert `RoomPlanMapperInputs` (ARKit Y-up) into a canonical
    /// `RoomPlanPayloadEnvelope` (Z-up, +Y north, +X east, right-handed)
    /// with the room origin at a floor corner.
    public static func map(
        _ inputs: RoomPlanMapperInputs,
        schemaVersion: String = "roomplan-ios-v1",
        roomType: String = "bedroom"
    ) throws -> RoomPlanPayloadEnvelope {
        guard !inputs.walls.isEmpty else { throw RoomPlanMapperError.noWalls }

        // 1) Canonicalize every wall transform + derive a provisional room
        //    centroid for inward-normal orientation, plus a room offset so the
        //    emitted coordinates sit at the positive-octant corner.
        let canonicalWalls = inputs.walls.map { CanonicalWall($0) }
        let offset = roomOffset(walls: canonicalWalls, floors: inputs.floors)
        let centroid = canonicalCentroid(walls: canonicalWalls, offset: offset)

        // 2) Build wall surface seeds + keep the canonical surface frames in
        //    memory, keyed by identifier, for opening projection.
        var wallFrames: [UUID: WallFrame] = [:]
        var wallIdByIdentifier: [UUID: String] = [:]
        var surfaces: [RoomPlanSurfaceSeedEnvelope] = []
        var walls: [CanonicalWall] = []
        for wall in canonicalWalls {
            let frame = wall.surfaceFrame(offset: offset, roomCentroid: centroid)
            let wallId = stableId("rp-wall", wall.input.identifier)
            wallIdByIdentifier[wall.input.identifier] = wallId
            wallFrames[wall.input.identifier] = frame
            walls.append(wall)
            surfaces.append(
                RoomPlanSurfaceSeedEnvelope(
                    id: wallId,
                    category: "wall",
                    polygon: Polygon2DEnvelope(vertices: [
                        Point2DEnvelope(x: 0, y: 0),
                        Point2DEnvelope(x: wall.width, y: 0),
                        Point2DEnvelope(x: wall.width, y: wall.height),
                        Point2DEnvelope(x: 0, y: wall.height)
                    ]),
                    frame: SurfaceFrameEnvelope(
                        origin: frame.origin.toEnvelopePoint(),
                        uAxis: frame.u.toEnvelopeVector(),
                        vAxis: frame.v.toEnvelopeVector(),
                        normal: frame.normal.toEnvelopeVector()
                    )
                )
            )
        }

        // 3) Floor polygon: prefer Apple-provided polygonCorners on the
        //    detected floor; otherwise derive from wall bottom corners.
        let floorPolygon = try floorPolygon(
            floors: inputs.floors,
            walls: walls,
            offset: offset
        )
        let floorId = "rp-floor-1"
        surfaces.append(
            RoomPlanSurfaceSeedEnvelope(
                id: floorId,
                category: "floor",
                polygon: Polygon2DEnvelope(vertices: floorPolygon.map {
                    Point2DEnvelope(x: Double($0.x), y: Double($0.y))
                }),
                frame: nil
            )
        )

        // 4) Synthetic ceiling at max wall height, same polygon as the floor.
        let ceilingHeight = Double(walls.map(\.height).max() ?? 2.6)
        let ceilingId = "rp-ceiling-1"
        surfaces.append(
            RoomPlanSurfaceSeedEnvelope(
                id: ceilingId,
                category: "ceiling",
                polygon: Polygon2DEnvelope(vertices: floorPolygon.map {
                    Point2DEnvelope(x: Double($0.x), y: Double($0.y))
                }),
                frame: SurfaceFrameEnvelope(
                    origin: Point3DEnvelope(x: 0, y: 0, z: ceilingHeight),
                    uAxis: Vector3DEnvelope(x: 1, y: 0, z: 0),
                    vAxis: Vector3DEnvelope(x: 0, y: 1, z: 0),
                    normal: Vector3DEnvelope(x: 0, y: 0, z: -1)
                )
            )
        )

        // 5) Openings: doors + windows, projected into host-wall (u,v).
        let openings = buildOpenings(
            doors: inputs.doors,
            windows: inputs.windows,
            walls: walls,
            wallFrames: wallFrames,
            wallIds: wallIdByIdentifier,
            offset: offset
        )

        // 6) Objects: canonicalize pose + OBB, skip out-of-scope categories.
        let objects = inputs.objects.compactMap { obj -> RoomPlanObjectSeedEnvelope? in
            buildObject(obj, offset: offset)
        }

        // 7) Room dimensions from floor polygon bbox.
        let (widthM, lengthM) = boundingBox(of: floorPolygon)

        return RoomPlanPayloadEnvelope(
            schemaVersion: schemaVersion,
            roomType: roomType,
            coordinateFrame: RoomCoordinateFrameEnvelope(
                origin: Point3DEnvelope(x: 0, y: 0, z: 0),
                xAxis: Vector3DEnvelope(x: 1, y: 0, z: 0),
                yAxis: Vector3DEnvelope(x: 0, y: 1, z: 0),
                zAxis: Vector3DEnvelope(x: 0, y: 0, z: 1),
                northSource: "scan_forward"
            ),
            dimensions: RoomDimensionsEnvelope(
                widthMeters: Double(widthM),
                lengthMeters: Double(lengthM),
                ceilingHeightMeters: ceilingHeight
            ),
            surfaces: surfaces,
            openings: openings,
            objects: objects,
            fixedElements: nil,
            roomCount: 1
        )
    }
}

// MARK: - Coordinate conversion
//
// ARKit world frame: +X right, +Y up, -Z forward, right-handed.
// Canonical room frame: +X east, +Y north, +Z up, right-handed.
// Chosen mapping: canonical(x, y, z) = arkit(x, -z, y).
// Rationale: ARKit's "forward" (where the device points at scan start) maps
// to canonical north (+Y), ARKit's up maps to canonical up, and handedness
// is preserved. The fixture at fixtures/roomplan/bedroom-primary/scene.json
// encodes the *already-canonical* frame, so this mapping is what converts
// live phone data into that frame.
@inline(__always)
func canonicalize(point p: simd_float3) -> simd_float3 {
    simd_float3(p.x, -p.z, p.y)
}

@inline(__always)
func canonicalizeAxis(_ v: simd_float3) -> simd_float3 {
    simd_float3(v.x, -v.z, v.y)
}

// MARK: - Internal helpers

struct CanonicalWall {
    let input: RoomPlanMapperInputs.Surface
    let center: simd_float3            // canonical, pre-offset
    let uAxis: simd_float3             // unit
    let vAxis: simd_float3             // unit; (0,0,1) for plumb walls
    let normalAxis: simd_float3        // unit, raw (may need flip)
    let width: Double
    let height: Double

    init(_ surface: RoomPlanMapperInputs.Surface) {
        self.input = surface
        // ARKit transform columns: 0 = local +X (wall width direction), 1 = +Y
        // (wall height direction), 2 = +Z (wall thickness / outward normal),
        // 3 = translation.
        let T = surface.transform
        let arkitCenter = simd_float3(T.columns.3.x, T.columns.3.y, T.columns.3.z)
        let arkitU = normalize(simd_float3(T.columns.0.x, T.columns.0.y, T.columns.0.z))
        let arkitV = normalize(simd_float3(T.columns.1.x, T.columns.1.y, T.columns.1.z))
        let arkitN = normalize(simd_float3(T.columns.2.x, T.columns.2.y, T.columns.2.z))
        self.center = canonicalize(point: arkitCenter)
        self.uAxis = normalize(canonicalizeAxis(arkitU))
        self.vAxis = normalize(canonicalizeAxis(arkitV))
        self.normalAxis = normalize(canonicalizeAxis(arkitN))
        self.width = Double(surface.dimensions.x)
        self.height = Double(surface.dimensions.y)
    }

    /// Wall bottom-left corner in canonical, post-offset coordinates.
    func surfaceFrame(offset: simd_float3, roomCentroid: simd_float3) -> WallFrame {
        let centerShifted = center - offset
        // Flip normal to face inward if it currently points away from centroid.
        var n = normalAxis
        if simd_dot(roomCentroid - centerShifted, n) < 0 { n = -n }
        let origin = centerShifted
            - 0.5 * Float(width) * uAxis
            - 0.5 * Float(height) * vAxis
        return WallFrame(origin: origin, u: uAxis, v: vAxis, normal: normalize(n))
    }
}

struct WallFrame {
    let origin: simd_float3
    let u: simd_float3
    let v: simd_float3
    let normal: simd_float3
}

/// Choose a room-origin offset so all canonical coordinates are non-negative
/// and the floor corner at (0,0,0) is the canonical room origin.
func roomOffset(
    walls: [CanonicalWall],
    floors: [RoomPlanMapperInputs.Surface]
) -> simd_float3 {
    var pts: [simd_float3] = []
    for wall in walls {
        let c = wall.center
        let halfW = 0.5 * Float(wall.width)
        pts.append(c + halfW * wall.uAxis)
        pts.append(c - halfW * wall.uAxis)
        pts.append(c - 0.5 * Float(wall.height) * wall.vAxis)
    }
    for floor in floors {
        for corner in floor.polygonCorners {
            pts.append(canonicalize(point: corner))
        }
    }
    guard !pts.isEmpty else { return .zero }
    let minX = pts.map(\.x).min() ?? 0
    let minY = pts.map(\.y).min() ?? 0
    // z offset is chosen so floor contact sits at z=0.
    let minZ = pts.map(\.z).min() ?? 0
    return simd_float3(minX, minY, minZ)
}

func canonicalCentroid(walls: [CanonicalWall], offset: simd_float3) -> simd_float3 {
    guard !walls.isEmpty else { return .zero }
    let sum = walls.reduce(simd_float3.zero) { $0 + ($1.center - offset) }
    return sum / Float(walls.count)
}

/// Build the floor polygon in canonical 2D (x,y) coordinates, CCW-wound.
func floorPolygon(
    floors: [RoomPlanMapperInputs.Surface],
    walls: [CanonicalWall],
    offset: simd_float3
) throws -> [simd_float2] {
    var ring: [simd_float2] = []
    if let floor = floors.first, !floor.polygonCorners.isEmpty {
        ring = floor.polygonCorners.map { corner in
            let c = canonicalize(point: corner) - offset
            return simd_float2(c.x, c.y)
        }
    } else {
        // Fall back to wall bottom-center (in canonical XY) ordered by angle
        // around the centroid. Works for simple convex rooms.
        let centers = walls.map { wall -> simd_float2 in
            let c = wall.center - offset
            return simd_float2(c.x, c.y)
        }
        guard centers.count >= 3 else { throw RoomPlanMapperError.degenerateFloor }
        let cx = centers.map(\.x).reduce(0, +) / Float(centers.count)
        let cy = centers.map(\.y).reduce(0, +) / Float(centers.count)
        ring = centers.sorted { a, b in
            atan2(a.y - cy, a.x - cx) < atan2(b.y - cy, b.x - cx)
        }
    }
    guard ring.count >= 3 else { throw RoomPlanMapperError.degenerateFloor }
    if shoelaceArea(ring) < 0 { ring.reverse() }
    return ring
}

func shoelaceArea(_ ring: [simd_float2]) -> Float {
    var sum: Float = 0
    for i in 0..<ring.count {
        let a = ring[i]
        let b = ring[(i + 1) % ring.count]
        sum += a.x * b.y - b.x * a.y
    }
    return 0.5 * sum
}

func boundingBox(of ring: [simd_float2]) -> (Float, Float) {
    let xs = ring.map(\.x)
    let ys = ring.map(\.y)
    let w = (xs.max() ?? 0) - (xs.min() ?? 0)
    let l = (ys.max() ?? 0) - (ys.min() ?? 0)
    return (w, l)
}

// MARK: - Openings

func buildOpenings(
    doors: [RoomPlanMapperInputs.Surface],
    windows: [RoomPlanMapperInputs.Surface],
    walls: [CanonicalWall],
    wallFrames: [UUID: WallFrame],
    wallIds: [UUID: String],
    offset: simd_float3
) -> [RoomPlanOpeningSeedEnvelope] {
    var out: [RoomPlanOpeningSeedEnvelope] = []
    for door in doors {
        if let seed = projectOpening(door, category: "door", walls: walls, wallFrames: wallFrames, wallIds: wallIds, offset: offset) {
            out.append(seed)
        }
    }
    for window in windows {
        if let seed = projectOpening(window, category: "window", walls: walls, wallFrames: wallFrames, wallIds: wallIds, offset: offset) {
            out.append(seed)
        }
    }
    return out
}

func projectOpening(
    _ opening: RoomPlanMapperInputs.Surface,
    category: String,
    walls: [CanonicalWall],
    wallFrames: [UUID: WallFrame],
    wallIds: [UUID: String],
    offset: simd_float3
) -> RoomPlanOpeningSeedEnvelope? {
    let arkitCenter = simd_float3(
        opening.transform.columns.3.x,
        opening.transform.columns.3.y,
        opening.transform.columns.3.z
    )
    let center = canonicalize(point: arkitCenter) - offset
    // Prefer parentIdentifier (iOS 17+); otherwise nearest wall within 0.6m.
    let host: (CanonicalWall, WallFrame)?
    if let parentId = opening.parentIdentifier,
       let wall = walls.first(where: { $0.input.identifier == parentId }),
       let frame = wallFrames[parentId] {
        host = (wall, frame)
    } else {
        host = nearestHostWall(to: center, walls: walls, frames: wallFrames)
    }
    guard let (wall, frame) = host,
          let wallId = wallIds[wall.input.identifier] else { return nil }
    let delta = center - frame.origin
    let u = Double(simd_dot(delta, frame.u))
    let v = Double(simd_dot(delta, frame.v))
    let width = Double(opening.dimensions.x)
    let height = Double(opening.dimensions.y)
    // Clamp floor-flush openings (doors) to v=0 if tiny negative due to scan
    // noise, so the validator accepts min_v >= 0 polygons. The ingest
    // validator doesn't strictly require this, but three.js hole-carving
    // fails on polygons with negative min_v.
    let minU = u - width / 2
    let minV = max(0, v - height / 2)
    return RoomPlanOpeningSeedEnvelope(
        id: stableId("rp-\(category)", opening.identifier),
        category: category,
        hostSurfaceId: wallId,
        rect: RectOnSurfaceEnvelope(
            minU: minU,
            minV: minV,
            width: width,
            height: height
        )
    )
}

func nearestHostWall(
    to point: simd_float3,
    walls: [CanonicalWall],
    frames: [UUID: WallFrame]
) -> (CanonicalWall, WallFrame)? {
    var best: (CanonicalWall, WallFrame, Float)?
    for wall in walls {
        guard let frame = frames[wall.input.identifier] else { continue }
        // Distance from point to the wall plane.
        let d = abs(simd_dot(point - frame.origin, frame.normal))
        if best == nil || d < best!.2 {
            best = (wall, frame, d)
        }
    }
    guard let chosen = best, chosen.2 < 0.6 else { return best.map { ($0.0, $0.1) } }
    return (chosen.0, chosen.1)
}

// MARK: - Objects

func buildObject(
    _ obj: RoomPlanMapperInputs.Object,
    offset: simd_float3
) -> RoomPlanObjectSeedEnvelope? {
    guard let categoryString = editableObjectCategory(obj.category) else { return nil }
    let T = obj.transform
    let arkitCenter = simd_float3(T.columns.3.x, T.columns.3.y, T.columns.3.z)
    let canonicalCenter = canonicalize(point: arkitCenter) - offset
    // Yaw: extract from the object's +X axis projected into the canonical XY
    // plane. ARKit object-local +X is transform.columns.0.
    let arkitU = normalize(simd_float3(T.columns.0.x, T.columns.0.y, T.columns.0.z))
    let canonicalU = normalize(canonicalizeAxis(arkitU))
    let yaw = atan2f(canonicalU.y, canonicalU.x) * 180.0 / .pi
    // Axis-swap dimensions: ARKit (x, y, z) -> canonical (x, z, y).
    let sx = Double(obj.dimensions.x)
    let sy = Double(obj.dimensions.z)
    let sz = Double(obj.dimensions.y)
    return RoomPlanObjectSeedEnvelope(
        id: stableId("rp-\(categoryString)", obj.identifier),
        category: categoryString,
        pose: Pose3DEnvelope(
            position: Point3DEnvelope(
                x: Double(canonicalCenter.x),
                y: Double(canonicalCenter.y),
                z: 0  // pose.z = floor contact per fixture convention
            ),
            yawDegrees: Double(yaw)
        ),
        obb: OBB3DEnvelope(
            center: Point3DEnvelope(
                x: Double(canonicalCenter.x),
                y: Double(canonicalCenter.y),
                z: Double(canonicalCenter.z)
            ),
            sizeX: sx,
            sizeY: sy,
            sizeZ: sz,
            yawDegrees: Double(yaw)
        ),
        attributes: obj.attributes
    )
}

/// Map RoomPlan object categories to the repo's editable class strings.
/// Returns nil for categories outside the bedroom MVP (server would coerce
/// them to `generic_obstacle` anyway; filtering here keeps scenes clean).
func editableObjectCategory(_ category: RoomPlanMapperInputs.ObjectCategory) -> String? {
    switch category {
    case .bed: return "bed"
    case .sofa: return "sofa"
    case .chair: return "chair"
    case .table: return "table"
    case .storage: return "storage"
    case .television: return "television"
    default: return nil
    }
}

// MARK: - Utilities

func stableId(_ prefix: String, _ uuid: UUID) -> String {
    // Short, readable IDs the server will re-namespace anyway.
    let tail = uuid.uuidString.replacingOccurrences(of: "-", with: "").prefix(8).lowercased()
    return "\(prefix)-\(tail)"
}

extension simd_float3 {
    func toEnvelopePoint() -> Point3DEnvelope {
        Point3DEnvelope(x: Double(x), y: Double(y), z: Double(z))
    }

    func toEnvelopeVector() -> Vector3DEnvelope {
        Vector3DEnvelope(x: Double(x), y: Double(y), z: Double(z))
    }
}

// MARK: - CapturedRoom adapter
//
// Kept minimal on purpose: all it does is lift the Apple fields into our
// intermediate struct. The arithmetic lives in `RoomPlanPayloadMapper.map`
// where it's unit-testable without RoomPlan.
#if canImport(RoomPlan)
@available(iOS 17.0, *)
public extension CapturedRoom {
    func toRoomPlanPayloadEnvelope(
        schemaVersion: String = "roomplan-ios-v1"
    ) throws -> RoomPlanPayloadEnvelope {
        let inputs = RoomPlanMapperInputs(capturedRoom: self)
        return try RoomPlanPayloadMapper.map(inputs, schemaVersion: schemaVersion)
    }
}

@available(iOS 17.0, *)
extension RoomPlanMapperInputs {
    init(capturedRoom: CapturedRoom) {
        self.init(
            walls: capturedRoom.walls.map { RoomPlanMapperInputs.Surface(surface: $0, category: .wall) },
            floors: capturedRoom.floors.map { RoomPlanMapperInputs.Surface(surface: $0, category: .floor) },
            doors: capturedRoom.doors.map { RoomPlanMapperInputs.Surface(surface: $0, category: .door) },
            windows: capturedRoom.windows.map { RoomPlanMapperInputs.Surface(surface: $0, category: .window) },
            objects: capturedRoom.objects.map { RoomPlanMapperInputs.Object(object: $0) }
        )
    }
}

@available(iOS 17.0, *)
extension RoomPlanMapperInputs.Surface {
    init(surface: CapturedRoom.Surface, category: RoomPlanMapperInputs.SurfaceCategory) {
        let corners: [simd_float3] = {
            // polygonCorners is iOS 17+; access guarded by the @available tag
            // on the enclosing file.
            return surface.polygonCorners
        }()
        self.init(
            identifier: surface.identifier,
            category: category,
            transform: surface.transform,
            dimensions: surface.dimensions,
            parentIdentifier: surface.parentIdentifier,
            polygonCorners: corners
        )
    }
}

@available(iOS 17.0, *)
extension RoomPlanMapperInputs.Object {
    init(object: CapturedRoom.Object) {
        self.init(
            identifier: object.identifier,
            category: RoomPlanMapperInputs.ObjectCategory(object.category),
            transform: object.transform,
            dimensions: object.dimensions,
            attributes: []
        )
    }
}

@available(iOS 17.0, *)
extension RoomPlanMapperInputs.ObjectCategory {
    init(_ rpCategory: CapturedRoom.Object.Category) {
        switch rpCategory {
        case .bed: self = .bed
        case .sofa: self = .sofa
        case .chair: self = .chair
        case .table: self = .table
        case .storage: self = .storage
        case .television: self = .television
        case .refrigerator: self = .refrigerator
        case .stove: self = .stove
        case .sink: self = .sink
        case .washerDryer: self = .washerDryer
        case .toilet: self = .toilet
        case .bathtub: self = .bathtub
        case .oven: self = .oven
        case .dishwasher: self = .dishwasher
        case .fireplace: self = .fireplace
        case .stairs: self = .stairs
        @unknown default: self = .unknown
        }
    }
}
#endif
