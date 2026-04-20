#if canImport(ARKit) && canImport(UIKit)
import Foundation
import simd

/// Serializes a RoomPlan capture + sampled ARKit frame evidence to a directory
/// on disk. The layout matches what `scripts/import-capture-bundle.mts
/// --bundle <path>` reads.
@available(iOS 17.0, *)
public enum CaptureBundleWriter {
    public struct BundleManifest: Codable, Equatable, Sendable {
        public struct FrameRef: Codable, Equatable, Sendable {
            public let frameId: String
            public let capturedAt: String
            public let rgbPath: String
            public let depthPath: String
            public let confidencePath: String?
            public let posePath: String
            public let intrinsicsPath: String

            enum CodingKeys: String, CodingKey {
                case frameId = "frame_id"
                case capturedAt = "captured_at"
                case rgbPath = "rgb_path"
                case depthPath = "depth_path"
                case confidencePath = "confidence_path"
                case posePath = "pose_path"
                case intrinsicsPath = "intrinsics_path"
            }
        }

        public let captureId: String
        public let roomplanRequestPath: String
        public let frames: [FrameRef]

        enum CodingKeys: String, CodingKey {
            case captureId = "capture_id"
            case roomplanRequestPath = "roomplan_request_path"
            case frames
        }
    }

    public struct PoseRecord: Codable, Equatable, Sendable {
        public let cameraTransform: [Double]
        public let cameraPose: Pose3DEnvelope

        enum CodingKeys: String, CodingKey {
            case cameraTransform = "camera_transform"
            case cameraPose = "camera_pose"
        }
    }

    public static func write(
        bundleDirectory: URL,
        captureId: String,
        captureRequest: RoomPlanCaptureEnvelope,
        samples: [FrameCaptureRecorder.Sample]
    ) throws -> BundleManifest {
        let fileManager = FileManager.default
        try fileManager.createDirectory(at: bundleDirectory, withIntermediateDirectories: true)
        let framesDirectory = bundleDirectory.appendingPathComponent("frames", isDirectory: true)
        try fileManager.createDirectory(at: framesDirectory, withIntermediateDirectories: true)

        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .prettyPrinted]

        let roomplanRequestPath = "roomplan_request.json"
        let roomplanData = try RoomViewCaptureCompanion.encodeCaptureRequest(captureRequest)
        try roomplanData.write(to: bundleDirectory.appendingPathComponent(roomplanRequestPath))

        let isoFormatter = ISO8601DateFormatter()
        isoFormatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]

        var frameRefs: [BundleManifest.FrameRef] = []
        for sample in samples {
            let baseName = sample.frameId
            let rgbPath = "frames/\(baseName).jpg"
            let depthPath = "frames/\(baseName).depth.npy"
            let confidencePath: String? = sample.confidenceUInt8Bytes != nil ? "frames/\(baseName).confidence.npy" : nil
            let posePath = "frames/\(baseName).pose.json"
            let intrinsicsPath = "frames/\(baseName).intrinsics.json"

            try sample.rgbJpegData.write(to: bundleDirectory.appendingPathComponent(rgbPath))
            let depthNpy = NumpyEncoder.encodeFloat32(
                bytes: sample.depthFloat32LEBytes,
                width: sample.depthWidth,
                height: sample.depthHeight
            )
            try depthNpy.write(to: bundleDirectory.appendingPathComponent(depthPath))
            if let confidenceBytes = sample.confidenceUInt8Bytes,
               let confidenceWidth = sample.confidenceWidth,
               let confidenceHeight = sample.confidenceHeight,
               let confidenceRelative = confidencePath {
                let confidenceNpy = NumpyEncoder.encodeUInt8(bytes: confidenceBytes, width: confidenceWidth, height: confidenceHeight)
                try confidenceNpy.write(to: bundleDirectory.appendingPathComponent(confidenceRelative))
            }

            let pose = Self.poseRecord(for: sample.cameraTransform)
            let poseData = try encoder.encode(pose)
            try poseData.write(to: bundleDirectory.appendingPathComponent(posePath))

            let intrinsics = Self.intrinsicsEnvelope(
                matrix: sample.intrinsics,
                imageResolution: sample.imageResolution
            )
            let intrinsicsData = try encoder.encode(intrinsics)
            try intrinsicsData.write(to: bundleDirectory.appendingPathComponent(intrinsicsPath))

            frameRefs.append(
                BundleManifest.FrameRef(
                    frameId: sample.frameId,
                    capturedAt: isoFormatter.string(from: sample.capturedAt),
                    rgbPath: rgbPath,
                    depthPath: depthPath,
                    confidencePath: confidencePath,
                    posePath: posePath,
                    intrinsicsPath: intrinsicsPath
                )
            )
        }

        let manifest = BundleManifest(captureId: captureId, roomplanRequestPath: roomplanRequestPath, frames: frameRefs)
        let manifestData = try encoder.encode(manifest)
        try manifestData.write(to: bundleDirectory.appendingPathComponent("manifest.json"))
        return manifest
    }

    public static func poseRecord(for transform: simd_float4x4) -> PoseRecord {
        // Convert ARKit's OpenGL-convention camera transform (camera-local
        // +Y up, -Z forward) into the OpenCV convention that the server-side
        // splat-generate.py + bake-wall-textures.py pipeline expects
        // (camera-local +Y down, +Z forward). Without this flip, unprojected
        // RGBD pixels land in rotated world positions → splat gaussians
        // cluster in a few spots instead of covering the room.
        //
        // T_opencv = T_arkit × diag(1, -1, -1, 1)
        // which negates columns 1 (Y) and 2 (Z) of the 4×4; column 3
        // (translation) is unchanged so the camera origin stays put.
        let arkitToOpenCV = simd_float4x4(
            simd_float4(1, 0, 0, 0),
            simd_float4(0, -1, 0, 0),
            simd_float4(0, 0, -1, 0),
            simd_float4(0, 0, 0, 1)
        )
        let opencvTransform = transform * arkitToOpenCV

        var columnMajor: [Double] = []
        columnMajor.reserveCapacity(16)
        for column in 0 ..< 4 {
            let col = opencvTransform[column]
            columnMajor.append(Double(col.x))
            columnMajor.append(Double(col.y))
            columnMajor.append(Double(col.z))
            columnMajor.append(Double(col.w))
        }
        // cameraPose metadata (position + yaw) stays derived from the ORIGINAL
        // ARKit transform so yaw_degrees keeps its human-intuitive meaning
        // (camera looks along -Z in ARKit). Only camera_transform is converted
        // because that's what the unprojection pipeline consumes.
        let origin = transform.columns.3
        let forward = -simd_float3(transform.columns.2.x, transform.columns.2.y, transform.columns.2.z)
        let yawRadians = atan2(Double(forward.x), Double(forward.z))
        let yawDegrees = yawRadians * 180.0 / .pi
        return PoseRecord(
            cameraTransform: columnMajor,
            cameraPose: Pose3DEnvelope(
                position: Point3DEnvelope(x: Double(origin.x), y: Double(origin.y), z: Double(origin.z)),
                yawDegrees: yawDegrees
            )
        )
    }

    public static func intrinsicsEnvelope(matrix: simd_float3x3, imageResolution: CGSize) -> CameraIntrinsicsEnvelope {
        return CameraIntrinsicsEnvelope(
            fx: Double(matrix.columns.0.x),
            fy: Double(matrix.columns.1.y),
            cx: Double(matrix.columns.2.x),
            cy: Double(matrix.columns.2.y),
            width: Double(imageResolution.width),
            height: Double(imageResolution.height)
        )
    }
}
#endif
