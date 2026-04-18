import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
#if canImport(ARKit) && canImport(UIKit)
import ARKit
import simd
#endif

public extension CaptureBootstrapConfiguration {
    /// Path template for the per-scene frame-upload endpoint. The `{scene_id}`
    /// placeholder is substituted by `RoomViewCaptureCompanion.framesUploadURL`.
    var framesUploadEndpointTemplate: String {
        "/captures/{scene_id}/frames"
    }
}

public extension RoomViewCaptureCompanion {
    static func framesUploadURL(sceneId: String, baseURL: URL, configuration: CaptureBootstrapConfiguration = .init()) -> URL {
        let resolved = configuration.framesUploadEndpointTemplate.replacingOccurrences(of: "{scene_id}", with: sceneId)
        return resolved
            .split(separator: "/")
            .map(String.init)
            .filter { !$0.isEmpty }
            .reduce(baseURL) { partial, component in
                partial.appendingPathComponent(component)
            }
    }

    static func encodeCaptureFramesRequest(_ request: CaptureFramesRequestEnvelope) throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        return try encoder.encode(request)
    }
}

@available(macOS 12.0, iOS 15.0, *)
public extension RoomPlanCaptureUploader {
    /// Posts a `CaptureFramesRequestEnvelope` to `/captures/{scene_id}/frames`.
    /// The caller is responsible for base64-encoding frame bytes (RGB as JPEG,
    /// depth/confidence as NumPy .npy).
    func uploadCaptureFrames(sceneId: String, request: CaptureFramesRequestEnvelope) async throws -> CaptureFramesResponseEnvelope {
        let url = RoomViewCaptureCompanion.framesUploadURL(sceneId: sceneId, baseURL: baseURL, configuration: configuration)
        var urlRequest = URLRequest(url: url)
        urlRequest.httpMethod = "POST"
        urlRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")
        urlRequest.httpBody = try RoomViewCaptureCompanion.encodeCaptureFramesRequest(request)
        let (data, response) = try await session.data(for: urlRequest)
        guard let http = response as? HTTPURLResponse, (200 ..< 300).contains(http.statusCode) else {
            let code = (response as? HTTPURLResponse)?.statusCode ?? -1
            throw RoomViewCaptureCompanionError.unsuccessfulStatusCode(code, String(data: data, encoding: .utf8))
        }
        return try JSONDecoder().decode(CaptureFramesResponseEnvelope.self, from: data)
    }
}

#if canImport(ARKit) && canImport(UIKit)
@available(iOS 17.0, *)
public enum FrameInputBuilder {
    /// Builds a `CaptureFrameInputEnvelope` from a sampled ARKit frame. Depth
    /// and confidence are serialized as NumPy .npy so the render bench can
    /// consume the same files.
    public static func build(sample: FrameCaptureRecorder.Sample, isoFormatter: ISO8601DateFormatter? = nil) -> CaptureFrameInputEnvelope {
        let formatter = isoFormatter ?? {
            let formatter = ISO8601DateFormatter()
            formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            return formatter
        }()
        let poseRecord = CaptureBundleWriter.poseRecord(for: sample.cameraTransform)
        let intrinsics = CaptureBundleWriter.intrinsicsEnvelope(matrix: sample.intrinsics, imageResolution: sample.imageResolution)
        let depthNpy = NumpyEncoder.encodeFloat32(
            bytes: sample.depthFloat32LEBytes,
            width: sample.depthWidth,
            height: sample.depthHeight
        )
        var confidenceContentType: String? = nil
        var confidenceBase64: String? = nil
        if let confidenceBytes = sample.confidenceUInt8Bytes,
           let confidenceWidth = sample.confidenceWidth,
           let confidenceHeight = sample.confidenceHeight {
            let confidenceNpy = NumpyEncoder.encodeUInt8(bytes: confidenceBytes, width: confidenceWidth, height: confidenceHeight)
            confidenceBase64 = confidenceNpy.base64EncodedString()
            confidenceContentType = "application/x-numpy"
        }
        return CaptureFrameInputEnvelope(
            frameId: sample.frameId,
            capturedAt: formatter.string(from: sample.capturedAt),
            cameraPose: poseRecord.cameraPose,
            cameraTransform: poseRecord.cameraTransform,
            intrinsics: intrinsics,
            rgbContentType: "image/jpeg",
            rgbBase64: sample.rgbJpegData.base64EncodedString(),
            depthContentType: "application/x-numpy",
            depthBase64: depthNpy.base64EncodedString(),
            confidenceContentType: confidenceContentType,
            confidenceBase64: confidenceBase64,
            bookmarkName: nil
        )
    }
}
#endif
