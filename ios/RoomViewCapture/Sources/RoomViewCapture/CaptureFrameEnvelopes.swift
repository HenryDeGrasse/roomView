import Foundation

public struct CameraIntrinsicsEnvelope: Codable, Equatable, Sendable {
    public let fx: Double
    public let fy: Double
    public let cx: Double
    public let cy: Double
    public let width: Double
    public let height: Double

    public init(fx: Double, fy: Double, cx: Double, cy: Double, width: Double, height: Double) {
        self.fx = fx
        self.fy = fy
        self.cx = cx
        self.cy = cy
        self.width = width
        self.height = height
    }
}

public struct CaptureFrameInputEnvelope: Codable, Equatable, Sendable {
    public let frameId: String
    public let capturedAt: String
    public let cameraPose: Pose3DEnvelope
    public let cameraTransform: [Double]
    public let intrinsics: CameraIntrinsicsEnvelope
    public let rgbContentType: String
    public let rgbBase64: String
    public let depthContentType: String
    public let depthBase64: String
    public let confidenceContentType: String?
    public let confidenceBase64: String?
    public let bookmarkName: String?

    public init(
        frameId: String,
        capturedAt: String,
        cameraPose: Pose3DEnvelope,
        cameraTransform: [Double],
        intrinsics: CameraIntrinsicsEnvelope,
        rgbContentType: String,
        rgbBase64: String,
        depthContentType: String,
        depthBase64: String,
        confidenceContentType: String? = nil,
        confidenceBase64: String? = nil,
        bookmarkName: String? = nil
    ) {
        self.frameId = frameId
        self.capturedAt = capturedAt
        self.cameraPose = cameraPose
        self.cameraTransform = cameraTransform
        self.intrinsics = intrinsics
        self.rgbContentType = rgbContentType
        self.rgbBase64 = rgbBase64
        self.depthContentType = depthContentType
        self.depthBase64 = depthBase64
        self.confidenceContentType = confidenceContentType
        self.confidenceBase64 = confidenceBase64
        self.bookmarkName = bookmarkName
    }

    enum CodingKeys: String, CodingKey {
        case frameId = "frame_id"
        case capturedAt = "captured_at"
        case cameraPose = "camera_pose"
        case cameraTransform = "camera_transform"
        case intrinsics
        case rgbContentType = "rgb_content_type"
        case rgbBase64 = "rgb_base64"
        case depthContentType = "depth_content_type"
        case depthBase64 = "depth_base64"
        case confidenceContentType = "confidence_content_type"
        case confidenceBase64 = "confidence_base64"
        case bookmarkName = "bookmark_name"
    }
}

public struct CaptureFramesRequestEnvelope: Codable, Equatable, Sendable {
    public let videoUploadToken: String
    public let idempotencyKey: String
    public let frames: [CaptureFrameInputEnvelope]

    public init(videoUploadToken: String, idempotencyKey: String, frames: [CaptureFrameInputEnvelope]) {
        self.videoUploadToken = videoUploadToken
        self.idempotencyKey = idempotencyKey
        self.frames = frames
    }

    enum CodingKeys: String, CodingKey {
        case videoUploadToken = "video_upload_token"
        case idempotencyKey = "idempotency_key"
        case frames
    }
}

public struct CapturedFrameAssetEnvelope: Codable, Equatable, Sendable {
    public let assetId: String
    public let uri: String
    public let contentType: String

    enum CodingKeys: String, CodingKey {
        case assetId = "asset_id"
        case uri
        case contentType = "content_type"
    }
}

public struct CapturedFrameEnvelope: Codable, Equatable, Sendable {
    public let frameId: String
    public let sceneId: String
    public let capturedAt: String
    public let bookmarkId: String?
    public let cameraPose: Pose3DEnvelope
    public let cameraTransform: [Double]
    public let intrinsics: CameraIntrinsicsEnvelope
    public let rgb: CapturedFrameAssetEnvelope
    public let depth: CapturedFrameAssetEnvelope
    public let confidence: CapturedFrameAssetEnvelope?

    enum CodingKeys: String, CodingKey {
        case frameId = "frame_id"
        case sceneId = "scene_id"
        case capturedAt = "captured_at"
        case bookmarkId = "bookmark_id"
        case cameraPose = "camera_pose"
        case cameraTransform = "camera_transform"
        case intrinsics
        case rgb
        case depth
        case confidence
    }
}

public struct CaptureFramesResponseEnvelope: Codable, Equatable, Sendable {
    public let capturedFrames: [CapturedFrameEnvelope]

    enum CodingKeys: String, CodingKey {
        case capturedFrames = "captured_frames"
    }
}
