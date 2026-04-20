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

    /// Path template for the per-scene finalize endpoint.
    var finalizeEndpointTemplate: String {
        "/captures/{scene_id}/finalize"
    }

    /// Path template for polling a specific job record.
    var jobReadEndpointTemplate: String {
        "/jobs/{job_id}"
    }
}

public extension RoomViewCaptureCompanion {
    static func framesUploadURL(sceneId: String, baseURL: URL, configuration: CaptureBootstrapConfiguration = .init()) -> URL {
        let resolved = configuration.framesUploadEndpointTemplate.replacingOccurrences(of: "{scene_id}", with: sceneId)
        return appendTrimmedPath(resolved, to: baseURL)
    }

    static func finalizeCaptureURL(sceneId: String, baseURL: URL, configuration: CaptureBootstrapConfiguration = .init()) -> URL {
        let resolved = configuration.finalizeEndpointTemplate.replacingOccurrences(of: "{scene_id}", with: sceneId)
        return appendTrimmedPath(resolved, to: baseURL)
    }

    static func jobReadURL(jobId: String, baseURL: URL, configuration: CaptureBootstrapConfiguration = .init()) -> URL {
        let resolved = configuration.jobReadEndpointTemplate.replacingOccurrences(of: "{job_id}", with: jobId)
        return appendTrimmedPath(resolved, to: baseURL)
    }

    static func encodeCaptureFramesRequest(_ request: CaptureFramesRequestEnvelope) throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        return try encoder.encode(request)
    }

    static func encodeFinalizeCaptureRequest(_ request: FinalizeCaptureRequestEnvelope) throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        return try encoder.encode(request)
    }

    private static func appendTrimmedPath(_ path: String, to baseURL: URL) -> URL {
        path
            .split(separator: "/")
            .map(String.init)
            .filter { !$0.isEmpty }
            .reduce(baseURL) { partial, component in
                partial.appendingPathComponent(component)
            }
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

    /// Posts a `FinalizeCaptureRequestEnvelope` to `/captures/{scene_id}/finalize`.
    /// The server promotes the capture into a persistent fixture dir and kicks
    /// off the splat + texture pipeline. The returned job can be polled via
    /// `pollJob(jobId:)` until it hits status=ready/failed.
    func finalizeCapture(sceneId: String, request: FinalizeCaptureRequestEnvelope) async throws -> FinalizeCaptureResponseEnvelope {
        let url = RoomViewCaptureCompanion.finalizeCaptureURL(sceneId: sceneId, baseURL: baseURL, configuration: configuration)
        var urlRequest = URLRequest(url: url)
        urlRequest.httpMethod = "POST"
        urlRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")
        urlRequest.httpBody = try RoomViewCaptureCompanion.encodeFinalizeCaptureRequest(request)
        let (data, response) = try await session.data(for: urlRequest)
        guard let http = response as? HTTPURLResponse, (200 ..< 300).contains(http.statusCode) else {
            let code = (response as? HTTPURLResponse)?.statusCode ?? -1
            throw RoomViewCaptureCompanionError.unsuccessfulStatusCode(code, String(data: data, encoding: .utf8))
        }
        return try JSONDecoder().decode(FinalizeCaptureResponseEnvelope.self, from: data)
    }

    /// GET /jobs/{jobId} — returns current job state so the iOS UI can show
    /// "generating splat…" / "baking textures…" / "ready" progress.
    /// Accepts either a redeemed scene session token or the raw handoff token
    /// from the capture response (for the companion-app polling flow).
    func pollJob(jobId: String, sessionToken: String? = nil) async throws -> JobReadResponseEnvelope {
        let url = RoomViewCaptureCompanion.jobReadURL(jobId: jobId, baseURL: baseURL, configuration: configuration)
        var urlRequest = URLRequest(url: url)
        urlRequest.httpMethod = "GET"
        if let sessionToken {
            urlRequest.setValue("Bearer \(sessionToken)", forHTTPHeaderField: "Authorization")
        }
        let (data, response) = try await session.data(for: urlRequest)
        guard let http = response as? HTTPURLResponse, (200 ..< 300).contains(http.statusCode) else {
            let code = (response as? HTTPURLResponse)?.statusCode ?? -1
            throw RoomViewCaptureCompanionError.unsuccessfulStatusCode(code, String(data: data, encoding: .utf8))
        }
        return try JSONDecoder().decode(JobReadResponseEnvelope.self, from: data)
    }
}

#if canImport(ARKit) && canImport(UIKit)
@available(iOS 17.0, *)
public enum FrameInputBuilder {
    /// Builds a `CaptureFrameInputEnvelope` from a sampled ARKit frame. Depth
    /// and confidence are serialized as NumPy .npy so the render bench can
    /// consume the same files.
    ///
    /// `canonicalOffset` is the room origin offset computed by
    /// `RoomPlanMapperInputs` — pass it so frame poses land in the same
    /// canonical-post-offset coordinate frame as the shell surfaces.
    /// Default `.zero` preserves the pre-alignment behavior for callers that
    /// haven't yet threaded the offset through.
    public static func build(
        sample: FrameCaptureRecorder.Sample,
        canonicalOffset: simd_float3 = .zero,
        isoFormatter: ISO8601DateFormatter? = nil
    ) -> CaptureFrameInputEnvelope {
        let formatter = isoFormatter ?? {
            let formatter = ISO8601DateFormatter()
            formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            return formatter
        }()
        let poseRecord = CaptureBundleWriter.poseRecord(
            for: sample.cameraTransform,
            canonicalOffset: canonicalOffset
        )
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
