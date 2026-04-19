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

// MARK: - Finalize capture

/// Sent by the iOS app after RoomPlan + frames are uploaded. Tells the server
/// to promote the capture into a persistent fixture dir and kick off the
/// splat-generate → bake-wall-textures pipeline.
public struct FinalizeCaptureRequestEnvelope: Codable, Equatable, Sendable {
    public let videoUploadToken: String
    public let idempotencyKey: String
    /// Optional human-readable room label (e.g. "Living room"). Used to build
    /// the fixture_id slug. `nil` falls back to a timestamped id.
    public let roomLabel: String?

    public init(videoUploadToken: String, idempotencyKey: String, roomLabel: String? = nil) {
        self.videoUploadToken = videoUploadToken
        self.idempotencyKey = idempotencyKey
        self.roomLabel = roomLabel
    }

    enum CodingKeys: String, CodingKey {
        case videoUploadToken = "video_upload_token"
        case idempotencyKey = "idempotency_key"
        case roomLabel = "room_label"
    }
}

public struct FinalizeCaptureResultEnvelope: Codable, Equatable, Sendable {
    public let fixtureId: String
    public let fixtureURL: String
    public let sceneURL: String

    enum CodingKeys: String, CodingKey {
        case fixtureId = "fixture_id"
        case fixtureURL = "fixture_url"
        case sceneURL = "scene_url"
    }
}

public struct JobRecordEnvelope: Codable, Equatable, Sendable {
    public let jobId: String
    public let sceneId: String
    public let jobKind: String
    public let status: String
    public let stage: String?
    public let progressMessage: String?
    public let errorCode: String?

    enum CodingKeys: String, CodingKey {
        case jobId = "job_id"
        case sceneId = "scene_id"
        case jobKind = "job_kind"
        case status
        case stage
        case progressMessage = "progress_message"
        case errorCode = "error_code"
    }
}

public struct FinalizeCaptureResponseEnvelope: Codable, Equatable, Sendable {
    public let job: JobRecordEnvelope
    public let result: FinalizeCaptureResultEnvelope
}

public struct JobReadResponseEnvelope: Codable, Equatable, Sendable {
    public let job: JobRecordEnvelope
    public let capturePipelineResult: FinalizeCaptureResultEnvelope?

    enum CodingKeys: String, CodingKey {
        case job
        case capturePipelineResult = "capture_pipeline_result"
    }
}
