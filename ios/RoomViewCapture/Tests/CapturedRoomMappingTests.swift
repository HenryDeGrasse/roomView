import Foundation
import Testing
import simd
@testable import RoomViewCapture

// MARK: - Shared synthetic bedroom
//
// ARKit frame: +X right, +Y up, -Z forward, right-handed.
// Synthetic room: X ∈ [0, 4], Y ∈ [0, 2.5], Z ∈ [-3, 0]. Centroid at
// ARKit (2, 1.25, -1.5). Four walls, one floor polygon via
// polygonCorners, one door on the south wall, one bed.
//
// Expected canonical mapping (x, y, z) → (x, -z, y), offset = 0:
//  - canonical room occupies [0,4] × [0,3] × [0,2.5]
//  - south wall (ARKit z = 0)  → canonical y = 0
//  - north wall (ARKit z = -3) → canonical y = 3
//  - west wall  (ARKit x = 0)  → canonical x = 0
//  - east wall  (ARKit x = 4)  → canonical x = 4

private func translation(_ x: Float, _ y: Float, _ z: Float) -> simd_float4x4 {
    var m = matrix_identity_float4x4
    m.columns.3 = simd_float4(x, y, z, 1)
    return m
}

/// Build a transform whose column 0 = uAxis, column 1 = vAxis, column 2 = nAxis,
/// column 3 = (tx, ty, tz, 1). Used for walls where the local +X runs along
/// the wall width, +Y up, +Z outward normal.
private func wallTransform(
    u: simd_float3,
    v: simd_float3,
    n: simd_float3,
    t: simd_float3
) -> simd_float4x4 {
    simd_float4x4(
        simd_float4(u.x, u.y, u.z, 0),
        simd_float4(v.x, v.y, v.z, 0),
        simd_float4(n.x, n.y, n.z, 0),
        simd_float4(t.x, t.y, t.z, 1)
    )
}

private let arkitUp = simd_float3(0, 1, 0)

private func syntheticBedroom() -> RoomPlanMapperInputs {
    // South wall: ARKit +X is width, +Y is height, +Z is outward normal
    // (pointing toward -Y canonical, which is *outside* the room).
    let south = RoomPlanMapperInputs.Surface(
        identifier: UUID(uuidString: "00000000-0000-0000-0000-0000000000A0")!,
        category: .wall,
        transform: wallTransform(
            u: simd_float3(1, 0, 0),
            v: arkitUp,
            n: simd_float3(0, 0, 1),       // ARKit +Z; canonicalizes to (0, -1, 0) = outward
            t: simd_float3(2, 1.25, 0)
        ),
        dimensions: simd_float3(4, 2.5, 0.1)
    )
    // North wall mirror of south; outward ARKit normal -Z (canonical +Y).
    let north = RoomPlanMapperInputs.Surface(
        identifier: UUID(uuidString: "00000000-0000-0000-0000-0000000000A1")!,
        category: .wall,
        transform: wallTransform(
            u: simd_float3(-1, 0, 0),
            v: arkitUp,
            n: simd_float3(0, 0, -1),
            t: simd_float3(2, 1.25, -3)
        ),
        dimensions: simd_float3(4, 2.5, 0.1)
    )
    // West wall: width runs along ARKit -Z, outward normal ARKit -X.
    let west = RoomPlanMapperInputs.Surface(
        identifier: UUID(uuidString: "00000000-0000-0000-0000-0000000000A2")!,
        category: .wall,
        transform: wallTransform(
            u: simd_float3(0, 0, -1),
            v: arkitUp,
            n: simd_float3(-1, 0, 0),
            t: simd_float3(0, 1.25, -1.5)
        ),
        dimensions: simd_float3(3, 2.5, 0.1)
    )
    // East wall mirror of west; outward normal ARKit +X.
    let east = RoomPlanMapperInputs.Surface(
        identifier: UUID(uuidString: "00000000-0000-0000-0000-0000000000A3")!,
        category: .wall,
        transform: wallTransform(
            u: simd_float3(0, 0, 1),
            v: arkitUp,
            n: simd_float3(1, 0, 0),
            t: simd_float3(4, 1.25, -1.5)
        ),
        dimensions: simd_float3(3, 2.5, 0.1)
    )

    // Floor polygon corners in ARKit world frame.
    let floor = RoomPlanMapperInputs.Surface(
        identifier: UUID(uuidString: "00000000-0000-0000-0000-0000000000F0")!,
        category: .floor,
        transform: matrix_identity_float4x4,
        dimensions: simd_float3(4, 0.01, 3),
        polygonCorners: [
            simd_float3(0, 0, 0),
            simd_float3(4, 0, 0),
            simd_float3(4, 0, -3),
            simd_float3(0, 0, -3)
        ]
    )

    // Door on south wall: 0.9m wide × 2.1m tall, centered at ARKit (1.5, 1.05, 0).
    let door = RoomPlanMapperInputs.Surface(
        identifier: UUID(uuidString: "00000000-0000-0000-0000-0000000000D0")!,
        category: .door,
        transform: translation(1.5, 1.05, 0),
        dimensions: simd_float3(0.9, 2.1, 0.05),
        parentIdentifier: south.identifier
    )

    // Window on east wall: 1.2m wide × 1.1m tall, centered at ARKit (4, 1.4, -1.5).
    // Wall width runs along ARKit -Z; window u-offset derived from z.
    let window = RoomPlanMapperInputs.Surface(
        identifier: UUID(uuidString: "00000000-0000-0000-0000-0000000000D1")!,
        category: .window,
        transform: translation(4, 1.4, -1.5),
        dimensions: simd_float3(1.2, 1.1, 0.05),
        parentIdentifier: east.identifier
    )

    // Bed: 2m × 0.6m × 1.6m (ARKit x × y × z), centered at (2, 0.3, -1.5).
    // In canonical: center (2, 1.5, 0.3), size (2, 1.6, 0.6) after Y↔Z swap.
    let bed = RoomPlanMapperInputs.Object(
        identifier: UUID(uuidString: "00000000-0000-0000-0000-0000000000B0")!,
        category: .bed,
        transform: translation(2, 0.3, -1.5),
        dimensions: simd_float3(2, 0.6, 1.6),
        attributes: ["queen"]
    )

    return RoomPlanMapperInputs(
        walls: [south, north, west, east],
        floors: [floor],
        doors: [door],
        windows: [window],
        objects: [bed]
    )
}

// MARK: - Coordinate primitives

@Test("canonicalize point applies (x, y, z) -> (x, -z, y)")
func canonicalize_point_mapping() {
    let p = simd_float3(1, 2, 3)
    let c = canonicalize(point: p)
    #expect(c.x == 1)
    #expect(c.y == -3)
    #expect(c.z == 2)
}

@Test("canonicalize axis applies the same permutation without translation")
func canonicalize_axis_mapping() {
    #expect(canonicalizeAxis(simd_float3(0, 1, 0)) == simd_float3(0, 0, 1))  // ARKit up → canonical up
    #expect(canonicalizeAxis(simd_float3(0, 0, -1)) == simd_float3(0, 1, 0)) // ARKit forward → canonical north
    #expect(canonicalizeAxis(simd_float3(1, 0, 0)) == simd_float3(1, 0, 0))  // ARKit right → canonical east
}

// MARK: - Shell (walls + floor + ceiling)

@Test("Synthetic bedroom produces four walls, one floor, one ceiling")
func shell_surface_counts() throws {
    let envelope = try RoomPlanPayloadMapper.map(syntheticBedroom())
    let byCategory = Dictionary(grouping: envelope.surfaces, by: \.category)
    #expect(byCategory["wall"]?.count == 4)
    #expect(byCategory["floor"]?.count == 1)
    #expect(byCategory["ceiling"]?.count == 1)
}

@Test("Room dimensions come from the floor polygon bounding box")
func dimensions_from_floor_polygon() throws {
    let envelope = try RoomPlanPayloadMapper.map(syntheticBedroom())
    #expect(abs(envelope.dimensions.widthMeters - 4.0) < 1e-5)
    #expect(abs(envelope.dimensions.lengthMeters - 3.0) < 1e-5)
    #expect(abs(envelope.dimensions.ceilingHeightMeters - 2.5) < 1e-5)
    #expect(envelope.roomCount == 1)
}

@Test("Floor polygon is CCW with corners at the positive octant")
func floor_polygon_ccw_positive_octant() throws {
    let envelope = try RoomPlanPayloadMapper.map(syntheticBedroom())
    let floor = try #require(envelope.surfaces.first { $0.category == "floor" })
    let vertices = floor.polygon.vertices
    #expect(vertices.count == 4)
    // All non-negative.
    for v in vertices {
        #expect(v.x >= 0)
        #expect(v.y >= 0)
    }
    // Shoelace sum > 0 (CCW) for a canonical-frame 2D polygon viewed from +Z.
    var area = 0.0
    for i in 0..<vertices.count {
        let a = vertices[i]
        let b = vertices[(i + 1) % vertices.count]
        area += a.x * b.y - b.x * a.y
    }
    #expect(area > 0)
}

@Test("South wall (ARKit z=0) emits canonical frame at y=0 with inward normal +Y")
func south_wall_frame_is_canonical() throws {
    let envelope = try RoomPlanPayloadMapper.map(syntheticBedroom())
    // South wall center canonical (2, 0, 1.25), origin at (0, 0, 0), u = +X,
    // v = +Z, inward normal = +Y.
    let south = try #require(
        envelope.surfaces.first { surface in
            guard let frame = surface.frame else { return false }
            return surface.category == "wall"
                && abs(frame.origin.y) < 1e-4
                && abs(frame.origin.z) < 1e-4
                && abs(frame.origin.x) < 1e-4
        }
    )
    let frame = try #require(south.frame)
    #expect(approx(frame.uAxis, Vector3DEnvelope(x: 1, y: 0, z: 0)))
    #expect(approx(frame.vAxis, Vector3DEnvelope(x: 0, y: 0, z: 1)))
    #expect(approx(frame.normal, Vector3DEnvelope(x: 0, y: 1, z: 0)))
    // Boundary is the full wall rectangle, openings cut separately.
    let vs = south.polygon.vertices
    #expect(vs.count == 4)
    #expect(approx(vs[0], Point2DEnvelope(x: 0, y: 0)))
    #expect(approx(vs[2], Point2DEnvelope(x: 4, y: 2.5)))
}

@Test("All four walls have unit-length axes and inward-facing normals")
func walls_axes_unit_length_and_inward() throws {
    let envelope = try RoomPlanPayloadMapper.map(syntheticBedroom())
    let walls = envelope.surfaces.filter { $0.category == "wall" }
    #expect(walls.count == 4)
    let roomCenter = Vector3DEnvelope(x: 2, y: 1.5, z: 1.25)
    for wall in walls {
        let frame = try #require(wall.frame)
        #expect(abs(magnitude(frame.uAxis) - 1) < 1e-4)
        #expect(abs(magnitude(frame.vAxis) - 1) < 1e-4)
        #expect(abs(magnitude(frame.normal) - 1) < 1e-4)
        // Wall center = origin + (w/2)u + (h/2)v. Normal should point
        // roughly toward the room centroid from that center.
        let w = wall.polygon.vertices.map(\.x).max() ?? 0
        let h = wall.polygon.vertices.map(\.y).max() ?? 0
        let cx = frame.origin.x + 0.5 * w * frame.uAxis.x + 0.5 * h * frame.vAxis.x
        let cy = frame.origin.y + 0.5 * w * frame.uAxis.y + 0.5 * h * frame.vAxis.y
        let cz = frame.origin.z + 0.5 * w * frame.uAxis.z + 0.5 * h * frame.vAxis.z
        let dx = roomCenter.x - cx
        let dy = roomCenter.y - cy
        let dz = roomCenter.z - cz
        let dot = dx * frame.normal.x + dy * frame.normal.y + dz * frame.normal.z
        #expect(dot > 0, "Wall normal must face the room interior (dot=\(dot))")
    }
}

// MARK: - Openings

@Test("Door on south wall projects to min_u≈1.05, min_v=0")
func door_projects_to_south_wall() throws {
    let envelope = try RoomPlanPayloadMapper.map(syntheticBedroom())
    let door = try #require(envelope.openings.first { $0.category == "door" })
    #expect(abs(door.rect.width - 0.9) < 1e-4)
    #expect(abs(door.rect.height - 2.1) < 1e-4)
    // Door center ARKit (1.5, 1.05, 0) → canonical (1.5, 0, 1.05). On south
    // wall (origin (0,0,0), u=+X, v=+Z): delta=(1.5, 0, 1.05), u=1.5, v=1.05.
    // min_u = 1.5 - 0.45 = 1.05; min_v = max(0, 1.05 - 1.05) = 0.
    #expect(abs(door.rect.minU - 1.05) < 1e-4)
    #expect(abs(door.rect.minV) < 1e-4)
}

@Test("Window on east wall projects to plausible u (along canonical +Y) and v≈0.85")
func window_projects_to_east_wall() throws {
    let envelope = try RoomPlanPayloadMapper.map(syntheticBedroom())
    let window = try #require(envelope.openings.first { $0.category == "window" })
    #expect(abs(window.rect.width - 1.2) < 1e-4)
    #expect(abs(window.rect.height - 1.1) < 1e-4)
    // Window center ARKit (4, 1.4, -1.5) → canonical (4, 1.5, 1.4). East wall
    // canonical-frame u runs along canonical +Y (from west to north side of
    // scan), so u = 1.5 - 1.5·u_origin ≈ half of wall length ⇒ min_u ≈ 0.9.
    // v = 1.4 - 0.55 = 0.85 above the floor.
    #expect(window.rect.minU >= 0)
    #expect(abs(window.rect.minV - 0.85) < 1e-3)
    // Sanity: window cutout fits inside its wall (east wall width = 3).
    #expect(window.rect.minU + window.rect.width <= 3.0 + 1e-3)
}

@Test("Each opening references a known wall id")
func openings_host_id_resolves_to_wall_in_surfaces() throws {
    let envelope = try RoomPlanPayloadMapper.map(syntheticBedroom())
    let wallIds = Set(envelope.surfaces.filter { $0.category == "wall" }.map(\.id))
    for opening in envelope.openings {
        #expect(wallIds.contains(opening.hostSurfaceId))
    }
}

// MARK: - Objects

@Test("Bed object converts dimensions with y↔z swap and places pose at floor contact")
func bed_object_has_swapped_dimensions_and_floor_pose() throws {
    let envelope = try RoomPlanPayloadMapper.map(syntheticBedroom())
    let bed = try #require(envelope.objects.first)
    #expect(bed.category == "bed")
    #expect(bed.attributes.contains("queen"))
    // canonical center: ARKit (2, 0.3, -1.5) → (2, 1.5, 0.3).
    #expect(abs(bed.obb.center.x - 2.0) < 1e-4)
    #expect(abs(bed.obb.center.y - 1.5) < 1e-4)
    #expect(abs(bed.obb.center.z - 0.3) < 1e-4)
    // dimensions (x, y, z)=(2, 0.6, 1.6) → (size_x, size_y, size_z)=(2, 1.6, 0.6).
    #expect(abs(bed.obb.sizeX - 2.0) < 1e-4)
    #expect(abs(bed.obb.sizeY - 1.6) < 1e-4)
    #expect(abs(bed.obb.sizeZ - 0.6) < 1e-4)
    // pose.position.z is always 0 (floor contact), per fixture convention.
    #expect(bed.pose.position.z == 0)
    #expect(abs(bed.pose.position.x - 2.0) < 1e-4)
    #expect(abs(bed.pose.position.y - 1.5) < 1e-4)
    // Identity rotation → yaw 0.
    #expect(abs(bed.pose.yawDegrees) < 1e-4)
}

@Test("Non-bedroom object categories are dropped client-side")
func filters_kitchen_and_bath_categories_out() throws {
    let refrigerator = RoomPlanMapperInputs.Object(
        identifier: UUID(),
        category: .refrigerator,
        transform: translation(2, 1, -1),
        dimensions: simd_float3(0.9, 1.8, 0.7)
    )
    let inputs = RoomPlanMapperInputs(
        walls: syntheticBedroom().walls,
        floors: syntheticBedroom().floors,
        objects: [refrigerator]
    )
    let envelope = try RoomPlanPayloadMapper.map(inputs)
    #expect(envelope.objects.isEmpty)
}

// MARK: - Validator smoke (snake_case JSON + required fields)

@Test("Mapped envelope round-trips through JSON with API snake_case keys")
func mapped_envelope_json_has_snake_case_keys() throws {
    let envelope = try RoomPlanPayloadMapper.map(syntheticBedroom())
    let request = RoomPlanCaptureEnvelope(
        requestId: "req-test",
        clientCaptureId: "capture-test",
        roomplanPayload: envelope,
        captureMetadata: CaptureMetadataEnvelope(
            deviceModel: "iPhoneTest",
            capturedAt: "2026-04-18T12:00:00Z",
            videoExpected: false
        )
    )
    let data = try RoomViewCaptureCompanion.encodeCaptureRequest(request)
    let json = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
    let payload = try #require(json["roomplan_payload"] as? [String: Any])
    // Required fields the server validator checks first.
    #expect(payload["schema_version"] as? String == "roomplan-ios-v1")
    #expect(payload["room_type"] as? String == "bedroom")
    #expect(payload["room_count"] as? Int == 1)
    let surfaces = try #require(payload["surfaces"] as? [[String: Any]])
    let categories = Set(surfaces.compactMap { $0["category"] as? String })
    #expect(categories == ["wall", "floor", "ceiling"])
    // Every opening's host_surface_id must reference a surface id (validator
    // rejects orphans at apps/api/src/roomplan-ingest.ts:2358).
    let surfaceIds = Set(surfaces.compactMap { $0["id"] as? String })
    let openings = (payload["openings"] as? [[String: Any]]) ?? []
    for opening in openings {
        let hostId = try #require(opening["host_surface_id"] as? String)
        #expect(surfaceIds.contains(hostId))
    }
}

@Test("Mapper throws when no walls are present")
func mapper_requires_at_least_one_wall() {
    let inputs = RoomPlanMapperInputs(walls: [])
    #expect(throws: RoomPlanMapperError.noWalls) {
        _ = try RoomPlanPayloadMapper.map(inputs)
    }
}

// MARK: - Sample artifact for hand-verification
//
// Emits a full RoomPlanCaptureEnvelope for the synthetic bedroom to a temp
// file. Feed it through the existing validator harness:
//
//   npx --yes tsx ./scripts/import-capture-bundle.mts \
//       --synthetic --payload /tmp/roomview-ios-mapper-sample.json
//
// This exercises the same ingest code path the real phone upload will hit.

@Test("Emits a full capture envelope for out-of-band validator round-trip")
func emits_sample_envelope_for_round_trip() throws {
    let envelope = try RoomPlanPayloadMapper.map(syntheticBedroom())
    let request = RoomPlanCaptureEnvelope(
        requestId: "req-ios-mapper-sample",
        clientCaptureId: "capture-ios-mapper-sample",
        roomplanPayload: envelope,
        captureMetadata: CaptureMetadataEnvelope(
            deviceModel: "iPhoneTest",
            capturedAt: "2026-04-18T12:00:00Z",
            videoExpected: false
        )
    )
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys, .prettyPrinted]
    let data = try encoder.encode(request)
    let url = URL(fileURLWithPath: "/tmp/roomview-ios-mapper-sample.json")
    try data.write(to: url)
    #expect(FileManager.default.fileExists(atPath: url.path))
}

// MARK: - Comparison helpers

private func approx(_ a: Point2DEnvelope, _ b: Point2DEnvelope, tol: Double = 1e-4) -> Bool {
    abs(a.x - b.x) < tol && abs(a.y - b.y) < tol
}

private func approx(_ a: Vector3DEnvelope, _ b: Vector3DEnvelope, tol: Double = 1e-4) -> Bool {
    abs(a.x - b.x) < tol && abs(a.y - b.y) < tol && abs(a.z - b.z) < tol
}

private func magnitude(_ v: Vector3DEnvelope) -> Double {
    (v.x * v.x + v.y * v.y + v.z * v.z).squareRoot()
}
