import Foundation

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

public enum RoomViewCaptureWorkspace {
    public static let defaultBootstrap = CaptureBootstrapConfiguration()
}
