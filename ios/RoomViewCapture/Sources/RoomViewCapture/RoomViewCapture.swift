import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
#if canImport(RoomPlan)
import RoomPlan
#endif
#if canImport(UIKit)
import UIKit
#endif

public struct CaptureBootstrapConfiguration: Codable, Equatable, Sendable {
    public let captureEndpointPath: String
    public let handoffRedeemEndpointPath: String
    public let videoUploadEndpointTemplate: String
    public let fixturesDirectory: String

    public init(
        captureEndpointPath: String = "/captures/roomplan",
        handoffRedeemEndpointPath: String = "/handoffs/redeem",
        videoUploadEndpointTemplate: String = "/captures/{scene_id}/video",
        fixturesDirectory: String = "../../fixtures/roomplan"
    ) {
        self.captureEndpointPath = captureEndpointPath
        self.handoffRedeemEndpointPath = handoffRedeemEndpointPath
        self.videoUploadEndpointTemplate = videoUploadEndpointTemplate
        self.fixturesDirectory = fixturesDirectory
    }
}

public struct RoomPlanCaptureEnvelope: Codable, Equatable, Sendable {
    public let requestId: String
    public let clientCaptureId: String
    public let roomplanPayload: RoomPlanPayloadEnvelope
    public let captureMetadata: CaptureMetadataEnvelope
    public let supplementaryDetections: [SupplementaryDetectionEnvelope]?

    public init(
        requestId: String,
        clientCaptureId: String,
        roomplanPayload: RoomPlanPayloadEnvelope,
        captureMetadata: CaptureMetadataEnvelope,
        supplementaryDetections: [SupplementaryDetectionEnvelope]? = nil
    ) {
        self.requestId = requestId
        self.clientCaptureId = clientCaptureId
        self.roomplanPayload = roomplanPayload
        self.captureMetadata = captureMetadata
        self.supplementaryDetections = supplementaryDetections
    }

    enum CodingKeys: String, CodingKey {
        case requestId = "request_id"
        case clientCaptureId = "client_capture_id"
        case roomplanPayload = "roomplan_payload"
        case captureMetadata = "capture_metadata"
        case supplementaryDetections = "supplementary_detections"
    }
}

public struct CaptureMetadataEnvelope: Codable, Equatable, Sendable {
    public let roomTypeHint: String
    public let units: String
    public let deviceModel: String
    public let capturedAt: String
    public let videoExpected: Bool

    public init(
        roomTypeHint: String = "bedroom",
        units: String = "m",
        deviceModel: String,
        capturedAt: String,
        videoExpected: Bool
    ) {
        self.roomTypeHint = roomTypeHint
        self.units = units
        self.deviceModel = deviceModel
        self.capturedAt = capturedAt
        self.videoExpected = videoExpected
    }

    enum CodingKeys: String, CodingKey {
        case roomTypeHint = "room_type_hint"
        case units
        case deviceModel = "device_model"
        case capturedAt = "captured_at"
        case videoExpected = "video_expected"
    }
}

public struct RoomPlanPayloadEnvelope: Codable, Equatable, Sendable {
    public let schemaVersion: String
    public let roomType: String
    public let coordinateFrame: RoomCoordinateFrameEnvelope
    public let dimensions: RoomDimensionsEnvelope
    public let surfaces: [RoomPlanSurfaceSeedEnvelope]
    public let openings: [RoomPlanOpeningSeedEnvelope]
    public let objects: [RoomPlanObjectSeedEnvelope]
    public let fixedElements: [RoomPlanFixedElementSeedEnvelope]?
    public let roomCount: Int?

    public init(
        schemaVersion: String,
        roomType: String = "bedroom",
        coordinateFrame: RoomCoordinateFrameEnvelope,
        dimensions: RoomDimensionsEnvelope,
        surfaces: [RoomPlanSurfaceSeedEnvelope],
        openings: [RoomPlanOpeningSeedEnvelope],
        objects: [RoomPlanObjectSeedEnvelope],
        fixedElements: [RoomPlanFixedElementSeedEnvelope]? = nil,
        roomCount: Int? = nil
    ) {
        self.schemaVersion = schemaVersion
        self.roomType = roomType
        self.coordinateFrame = coordinateFrame
        self.dimensions = dimensions
        self.surfaces = surfaces
        self.openings = openings
        self.objects = objects
        self.fixedElements = fixedElements
        self.roomCount = roomCount
    }

    enum CodingKeys: String, CodingKey {
        case schemaVersion = "schema_version"
        case roomType = "room_type"
        case coordinateFrame = "coordinate_frame"
        case dimensions
        case surfaces
        case openings
        case objects
        case fixedElements = "fixed_elements"
        case roomCount = "room_count"
    }
}

public struct RoomDimensionsEnvelope: Codable, Equatable, Sendable {
    public let widthMeters: Double
    public let lengthMeters: Double
    public let ceilingHeightMeters: Double

    public init(widthMeters: Double, lengthMeters: Double, ceilingHeightMeters: Double) {
        self.widthMeters = widthMeters
        self.lengthMeters = lengthMeters
        self.ceilingHeightMeters = ceilingHeightMeters
    }

    enum CodingKeys: String, CodingKey {
        case widthMeters = "width_m"
        case lengthMeters = "length_m"
        case ceilingHeightMeters = "ceiling_height_m"
    }
}

public struct RoomCoordinateFrameEnvelope: Codable, Equatable, Sendable {
    public let origin: Point3DEnvelope
    public let xAxis: Vector3DEnvelope
    public let yAxis: Vector3DEnvelope
    public let zAxis: Vector3DEnvelope
    public let northSource: String

    public init(
        origin: Point3DEnvelope,
        xAxis: Vector3DEnvelope,
        yAxis: Vector3DEnvelope,
        zAxis: Vector3DEnvelope,
        northSource: String = "scan_forward"
    ) {
        self.origin = origin
        self.xAxis = xAxis
        self.yAxis = yAxis
        self.zAxis = zAxis
        self.northSource = northSource
    }

    enum CodingKeys: String, CodingKey {
        case origin
        case xAxis = "x_axis"
        case yAxis = "y_axis"
        case zAxis = "z_axis"
        case northSource = "north_source"
    }
}

public struct RoomPlanSurfaceSeedEnvelope: Codable, Equatable, Sendable {
    public let id: String
    public let category: String
    public let polygon: Polygon2DEnvelope
    public let frame: SurfaceFrameEnvelope?

    public init(id: String, category: String, polygon: Polygon2DEnvelope, frame: SurfaceFrameEnvelope?) {
        self.id = id
        self.category = category
        self.polygon = polygon
        self.frame = frame
    }
}

public struct RoomPlanOpeningSeedEnvelope: Codable, Equatable, Sendable {
    public let id: String
    public let category: String
    public let hostSurfaceId: String
    public let rect: RectOnSurfaceEnvelope

    public init(id: String, category: String, hostSurfaceId: String, rect: RectOnSurfaceEnvelope) {
        self.id = id
        self.category = category
        self.hostSurfaceId = hostSurfaceId
        self.rect = rect
    }

    enum CodingKeys: String, CodingKey {
        case id
        case category
        case hostSurfaceId = "host_surface_id"
        case rect
    }
}

public struct RoomPlanObjectSeedEnvelope: Codable, Equatable, Sendable {
    public let id: String
    public let category: String
    public let pose: Pose3DEnvelope
    public let obb: OBB3DEnvelope
    public let attributes: [String]

    public init(id: String, category: String, pose: Pose3DEnvelope, obb: OBB3DEnvelope, attributes: [String]) {
        self.id = id
        self.category = category
        self.pose = pose
        self.obb = obb
        self.attributes = attributes
    }
}

public struct RoomPlanFixedElementSeedEnvelope: Codable, Equatable, Sendable {
    public let id: String
    public let category: String
    public let pose: Pose3DEnvelope
    public let obb: OBB3DEnvelope
    public let attributes: [String]?
    public let hostSurfaceId: String?

    public init(
        id: String,
        category: String,
        pose: Pose3DEnvelope,
        obb: OBB3DEnvelope,
        attributes: [String]? = nil,
        hostSurfaceId: String? = nil
    ) {
        self.id = id
        self.category = category
        self.pose = pose
        self.obb = obb
        self.attributes = attributes
        self.hostSurfaceId = hostSurfaceId
    }

    enum CodingKeys: String, CodingKey {
        case id
        case category
        case pose
        case obb
        case attributes
        case hostSurfaceId = "host_surface_id"
    }
}

public struct SupplementaryDetectionEnvelope: Codable, Equatable, Sendable {
    public let detectionId: String
    public let label: String
    public let obb: OBB3DEnvelope
    public let confidence: Double

    public init(detectionId: String, label: String, obb: OBB3DEnvelope, confidence: Double) {
        self.detectionId = detectionId
        self.label = label
        self.obb = obb
        self.confidence = confidence
    }

    enum CodingKeys: String, CodingKey {
        case detectionId = "detection_id"
        case label
        case obb
        case confidence
    }
}

public struct RoomPlanCaptureResponseEnvelope: Codable, Equatable, Sendable {
    public let sceneId: String
    public let sceneVersion: Int
    public let sceneSnapshotId: String
    public let handoffURL: String
    public let qrPayload: String
    public let expiresAt: String
    public let videoUploadToken: String?

    public init(
        sceneId: String,
        sceneVersion: Int,
        sceneSnapshotId: String,
        handoffURL: String,
        qrPayload: String,
        expiresAt: String,
        videoUploadToken: String?
    ) {
        self.sceneId = sceneId
        self.sceneVersion = sceneVersion
        self.sceneSnapshotId = sceneSnapshotId
        self.handoffURL = handoffURL
        self.qrPayload = qrPayload
        self.expiresAt = expiresAt
        self.videoUploadToken = videoUploadToken
    }

    enum CodingKeys: String, CodingKey {
        case sceneId = "scene_id"
        case sceneVersion = "scene_version"
        case sceneSnapshotId = "scene_snapshot_id"
        case handoffURL = "handoff_url"
        case qrPayload = "qr_payload"
        case expiresAt = "expires_at"
        case videoUploadToken = "video_upload_token"
    }
}

public struct HandoffRedeemRequestEnvelope: Codable, Equatable, Sendable {
    public let handoffToken: String

    public init(handoffToken: String) {
        self.handoffToken = handoffToken
    }

    enum CodingKeys: String, CodingKey {
        case handoffToken = "handoff_token"
    }
}

public struct HandoffRedeemResponseEnvelope: Codable, Equatable, Sendable {
    public let sceneId: String
    public let sessionId: String
    public let redeemedAt: String
    public let expiresAt: String

    public init(sceneId: String, sessionId: String, redeemedAt: String, expiresAt: String) {
        self.sceneId = sceneId
        self.sessionId = sessionId
        self.redeemedAt = redeemedAt
        self.expiresAt = expiresAt
    }

    enum CodingKeys: String, CodingKey {
        case sceneId = "scene_id"
        case sessionId = "session_id"
        case redeemedAt = "redeemed_at"
        case expiresAt = "expires_at"
    }
}

public struct VideoUploadRequestEnvelope: Codable, Equatable, Sendable {
    public let videoUploadToken: String
    public let contentType: String

    public init(videoUploadToken: String, contentType: String) {
        self.videoUploadToken = videoUploadToken
        self.contentType = contentType
    }

    enum CodingKeys: String, CodingKey {
        case videoUploadToken = "video_upload_token"
        case contentType = "content_type"
    }
}

public struct Point2DEnvelope: Codable, Equatable, Sendable {
    public let x: Double
    public let y: Double

    public init(x: Double, y: Double) {
        self.x = x
        self.y = y
    }
}

public struct Point3DEnvelope: Codable, Equatable, Sendable {
    public let x: Double
    public let y: Double
    public let z: Double

    public init(x: Double, y: Double, z: Double) {
        self.x = x
        self.y = y
        self.z = z
    }
}

public typealias Vector3DEnvelope = Point3DEnvelope

public struct Polygon2DEnvelope: Codable, Equatable, Sendable {
    public let vertices: [Point2DEnvelope]

    public init(vertices: [Point2DEnvelope]) {
        self.vertices = vertices
    }
}

public struct SurfaceFrameEnvelope: Codable, Equatable, Sendable {
    public let origin: Point3DEnvelope
    public let uAxis: Vector3DEnvelope
    public let vAxis: Vector3DEnvelope
    public let normal: Vector3DEnvelope

    public init(origin: Point3DEnvelope, uAxis: Vector3DEnvelope, vAxis: Vector3DEnvelope, normal: Vector3DEnvelope) {
        self.origin = origin
        self.uAxis = uAxis
        self.vAxis = vAxis
        self.normal = normal
    }

    enum CodingKeys: String, CodingKey {
        case origin
        case uAxis = "u_axis"
        case vAxis = "v_axis"
        case normal
    }
}

public struct RectOnSurfaceEnvelope: Codable, Equatable, Sendable {
    public let minU: Double
    public let minV: Double
    public let width: Double
    public let height: Double

    public init(minU: Double, minV: Double, width: Double, height: Double) {
        self.minU = minU
        self.minV = minV
        self.width = width
        self.height = height
    }

    enum CodingKeys: String, CodingKey {
        case minU = "min_u"
        case minV = "min_v"
        case width
        case height
    }
}

public struct Pose3DEnvelope: Codable, Equatable, Sendable {
    public let position: Point3DEnvelope
    public let yawDegrees: Double

    public init(position: Point3DEnvelope, yawDegrees: Double) {
        self.position = position
        self.yawDegrees = yawDegrees
    }

    enum CodingKeys: String, CodingKey {
        case position
        case yawDegrees = "yaw_degrees"
    }
}

public struct OBB3DEnvelope: Codable, Equatable, Sendable {
    public let center: Point3DEnvelope
    public let sizeX: Double
    public let sizeY: Double
    public let sizeZ: Double
    public let yawDegrees: Double

    public init(center: Point3DEnvelope, sizeX: Double, sizeY: Double, sizeZ: Double, yawDegrees: Double) {
        self.center = center
        self.sizeX = sizeX
        self.sizeY = sizeY
        self.sizeZ = sizeZ
        self.yawDegrees = yawDegrees
    }

    enum CodingKeys: String, CodingKey {
        case center
        case sizeX = "size_x"
        case sizeY = "size_y"
        case sizeZ = "size_z"
        case yawDegrees = "yaw_degrees"
    }
}

public enum RoomViewCaptureCompanionError: Error, Equatable, Sendable {
    case invalidResponse
    case unsuccessfulStatusCode(Int, String?)
}

extension RoomViewCaptureCompanionError: LocalizedError {
    public var errorDescription: String? {
        switch self {
        case .invalidResponse:
            return "The Mac returned an invalid response."
        case let .unsuccessfulStatusCode(code, payload):
            let trimmedPayload = payload?.trimmingCharacters(in: .whitespacesAndNewlines)
            if let details = parseCompanionErrorPayload(trimmedPayload) {
                switch (details.reasonCode, details.message) {
                case let (.some(reasonCode), .some(message)):
                    return "The Mac returned HTTP \(code) (\(reasonCode)): \(message)"
                case let (.some(reasonCode), .none):
                    return "The Mac returned HTTP \(code) (\(reasonCode))."
                case let (.none, .some(message)):
                    return "The Mac returned HTTP \(code): \(message)"
                case (.none, .none):
                    break
                }
            }
            if let trimmedPayload, !trimmedPayload.isEmpty {
                return "The Mac returned HTTP \(code): \(trimmedPayload)"
            }
            return "The Mac returned HTTP \(code)."
        }
    }
}

private func parseCompanionErrorPayload(_ payload: String?) -> (reasonCode: String?, message: String?)? {
    guard let payload, let data = payload.data(using: .utf8) else {
        return nil
    }
    guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
        return nil
    }
    let reasonCode = json["reason_code"] as? String
    let message = json["message"] as? String
    if reasonCode == nil && message == nil {
        return nil
    }
    return (reasonCode, message)
}

@available(macOS 12.0, iOS 15.0, *)
public final class RoomPlanCaptureUploader: @unchecked Sendable {
    internal let baseURL: URL
    internal let session: URLSession
    internal let configuration: CaptureBootstrapConfiguration

    public init(
        baseURL: URL,
        session: URLSession = .shared,
        configuration: CaptureBootstrapConfiguration = .init()
    ) {
        self.baseURL = baseURL
        self.session = session
        self.configuration = configuration
    }

    public func uploadCapture(_ request: RoomPlanCaptureEnvelope) async throws -> RoomPlanCaptureResponseEnvelope {
        var urlRequest = URLRequest(url: RoomViewCaptureCompanion.captureURL(baseURL: baseURL, configuration: configuration))
        urlRequest.httpMethod = "POST"
        urlRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")
        urlRequest.httpBody = try RoomViewCaptureCompanion.encodeCaptureRequest(request)

        let (data, response) = try await session.data(for: urlRequest)
        try Self.validate(response: response, data: data)
        return try JSONDecoder().decode(RoomPlanCaptureResponseEnvelope.self, from: data)
    }

    public func redeemHandoff(_ request: HandoffRedeemRequestEnvelope) async throws -> HandoffRedeemResponseEnvelope {
        var urlRequest = URLRequest(url: RoomViewCaptureCompanion.redeemURL(baseURL: baseURL, configuration: configuration))
        urlRequest.httpMethod = "POST"
        urlRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")
        urlRequest.httpBody = try RoomViewCaptureCompanion.encodeHandoffRedeemRequest(request)

        let (data, response) = try await session.data(for: urlRequest)
        try Self.validate(response: response, data: data)
        return try JSONDecoder().decode(HandoffRedeemResponseEnvelope.self, from: data)
    }

    public func uploadVideo(sceneId: String, videoData: Data, request: VideoUploadRequestEnvelope) async throws -> String {
        _ = videoData

        var urlRequest = URLRequest(url: RoomViewCaptureCompanion.videoUploadURL(sceneId: sceneId, baseURL: baseURL, configuration: configuration))
        urlRequest.httpMethod = "POST"
        urlRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")
        urlRequest.httpBody = try RoomViewCaptureCompanion.encodeVideoUploadRequest(request)

        let (data, response) = try await session.data(for: urlRequest)
        try Self.validate(response: response, data: data)
        let decoded = try JSONDecoder().decode(VideoUploadJobEnvelope.self, from: data)
        return decoded.jobId
    }

    private static func validate(response: URLResponse, data: Data) throws {
        guard let httpResponse = response as? HTTPURLResponse else {
            throw RoomViewCaptureCompanionError.invalidResponse
        }
        guard (200 ..< 300).contains(httpResponse.statusCode) else {
            throw RoomViewCaptureCompanionError.unsuccessfulStatusCode(
                httpResponse.statusCode,
                String(data: data, encoding: .utf8)
            )
        }
    }
}

private struct VideoUploadJobEnvelope: Codable, Equatable, Sendable {
    let jobId: String

    enum CodingKeys: String, CodingKey {
        case jobId = "job_id"
    }
}

#if canImport(RoomPlan) && canImport(UIKit)
@available(macOS 12.0, iOS 15.0, *)
@MainActor
public final class RoomPlanCaptureCoordinator {
    public let captureView: RoomCaptureView
    private let uploader: RoomPlanCaptureUploader
    private let configuration: CaptureBootstrapConfiguration

    public var captureSession: RoomCaptureSession {
        captureView.captureSession
    }

    public init(
        baseURL: URL,
        session: URLSession = .shared,
        configuration: CaptureBootstrapConfiguration = .init(),
        captureView: RoomCaptureView = RoomCaptureView(frame: .zero)
    ) {
        self.captureView = captureView
        self.uploader = RoomPlanCaptureUploader(baseURL: baseURL, session: session, configuration: configuration)
        self.configuration = configuration
    }

    public func startCapture() {
        let sessionConfiguration = RoomCaptureSession.Configuration()
        captureSession.run(configuration: sessionConfiguration)
    }

    public func stopCapture() {
        captureSession.stop()
    }

    public func uploadCapture(
        capturedRoom: CapturedRoom,
        requestId: String,
        clientCaptureId: String,
        deviceModel: String,
        capturedAt: String,
        videoExpected: Bool,
        supplementaryDetections: [SupplementaryDetectionEnvelope]? = nil,
        payloadBuilder: (CapturedRoom) throws -> RoomPlanPayloadEnvelope
    ) async throws -> RoomPlanCaptureResponseEnvelope {
        let roomplanPayload = try payloadBuilder(capturedRoom)
        let envelope = RoomPlanCaptureEnvelope(
            requestId: requestId,
            clientCaptureId: clientCaptureId,
            roomplanPayload: roomplanPayload,
            captureMetadata: CaptureMetadataEnvelope(
                deviceModel: deviceModel,
                capturedAt: capturedAt,
                videoExpected: videoExpected
            ),
            supplementaryDetections: supplementaryDetections
        )
        return try await uploader.uploadCapture(envelope)
    }

    public func uploadVideo(sceneId: String, videoUploadToken: String, contentType: String, videoData: Data) async throws -> String {
        try await uploader.uploadVideo(
            sceneId: sceneId,
            videoData: videoData,
            request: VideoUploadRequestEnvelope(videoUploadToken: videoUploadToken, contentType: contentType)
        )
    }
}
#endif

public enum RoomViewCaptureCompanion {
    public static func captureURL(baseURL: URL, configuration: CaptureBootstrapConfiguration = .init()) -> URL {
        appendPath(configuration.captureEndpointPath, to: baseURL)
    }

    public static func redeemURL(baseURL: URL, configuration: CaptureBootstrapConfiguration = .init()) -> URL {
        appendPath(configuration.handoffRedeemEndpointPath, to: baseURL)
    }

    public static func videoUploadURL(sceneId: String, baseURL: URL, configuration: CaptureBootstrapConfiguration = .init()) -> URL {
        let resolved = configuration.videoUploadEndpointTemplate.replacingOccurrences(of: "{scene_id}", with: sceneId)
        return appendPath(resolved, to: baseURL)
    }

    public static func encodeCaptureRequest(_ request: RoomPlanCaptureEnvelope) throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        return try encoder.encode(request)
    }

    public static func encodeHandoffRedeemRequest(_ request: HandoffRedeemRequestEnvelope) throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        return try encoder.encode(request)
    }

    public static func encodeVideoUploadRequest(_ request: VideoUploadRequestEnvelope) throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        return try encoder.encode(request)
    }

    private static func appendPath(_ path: String, to baseURL: URL) -> URL {
        trimmedPathComponents(path).reduce(baseURL) { partialURL, component in
            partialURL.appendingPathComponent(component)
        }
    }

    private static func trimmedPathComponents(_ path: String) -> [String] {
        path
            .split(separator: "/")
            .map(String.init)
            .filter { !$0.isEmpty }
    }
}

public enum RoomViewCaptureWorkspace {
    public static let defaultBootstrap = CaptureBootstrapConfiguration()
}
