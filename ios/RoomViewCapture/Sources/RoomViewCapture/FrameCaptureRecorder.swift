#if canImport(ARKit) && canImport(UIKit)
import ARKit
import CoreImage
import CoreVideo
import Foundation
import UIKit
import simd

/// Samples ARFrame evidence (RGB/depth/confidence/pose/intrinsics) while a
/// RoomPlan capture is active. The recorder is stateful and thread-confined to
/// the main actor; pipe ARFrames in from an ARSessionDelegate or from
/// `ARSession.currentFrame` polling.
@available(iOS 17.0, *)
@MainActor
public final class FrameCaptureRecorder {
    public struct Sample: Sendable {
        public let frameId: String
        public let capturedAt: Date
        public let cameraTransform: simd_float4x4
        public let intrinsics: simd_float3x3
        public let imageResolution: CGSize
        public let rgbJpegData: Data
        public let depthFloat32LEBytes: Data
        public let depthWidth: Int
        public let depthHeight: Int
        public let confidenceUInt8Bytes: Data?
        public let confidenceWidth: Int?
        public let confidenceHeight: Int?
    }

    private let minimumInterval: TimeInterval
    private let maxSampleCount: Int
    private let jpegQuality: CGFloat
    private let ciContext: CIContext
    private var lastSampledAt: Date?
    private var samples: [Sample] = []
    /// Monotonically-increasing counter for frame IDs. Does NOT reset when
    /// the ring buffer drops oldest samples — so every recorded frame gets
    /// a unique frame_id even after the buffer wraps. Without this, all
    /// post-cap frames would share the same ID (samples.count + 1), and
    /// the server's duplicate-frame-id dedup would drop all but the first.
    private var nextFrameIndex: Int = 0
    public private(set) var isActive: Bool = false

    public init(minimumInterval: TimeInterval = 0.5, maxSampleCount: Int = 32, jpegQuality: CGFloat = 0.85) {
        self.minimumInterval = minimumInterval
        self.maxSampleCount = maxSampleCount
        self.jpegQuality = jpegQuality
        self.ciContext = CIContext(options: [.useSoftwareRenderer: false])
    }

    public func start() {
        lastSampledAt = nil
        samples.removeAll(keepingCapacity: true)
        nextFrameIndex = 0
        isActive = true
    }

    public func stop() {
        isActive = false
    }

    /// Offer a frame to the recorder. The recorder enforces a minimum sampling
    /// interval so the caller can pass every frame without worrying about cost.
    public func record(arFrame: ARFrame) {
        guard isActive else { return }
        let now = Date()
        if let previous = lastSampledAt, now.timeIntervalSince(previous) < minimumInterval {
            return
        }
        guard let depthData = arFrame.sceneDepth ?? arFrame.smoothedSceneDepth else { return }
        guard let rgbData = Self.encodeJPEG(pixelBuffer: arFrame.capturedImage, context: ciContext, quality: jpegQuality) else {
            return
        }
        let depthExtract = Self.extractFloat32(pixelBuffer: depthData.depthMap)
        let confidenceExtract = depthData.confidenceMap.map { Self.extractUInt8(pixelBuffer: $0) }

        nextFrameIndex += 1
        let sample = Sample(
            frameId: String(format: "frame_%06d", nextFrameIndex),
            capturedAt: now,
            cameraTransform: arFrame.camera.transform,
            intrinsics: arFrame.camera.intrinsics,
            imageResolution: arFrame.camera.imageResolution,
            rgbJpegData: rgbData,
            depthFloat32LEBytes: depthExtract.bytes,
            depthWidth: depthExtract.width,
            depthHeight: depthExtract.height,
            confidenceUInt8Bytes: confidenceExtract?.bytes,
            confidenceWidth: confidenceExtract?.width,
            confidenceHeight: confidenceExtract?.height
        )
        samples.append(sample)
        lastSampledAt = now
        if samples.count > maxSampleCount {
            samples.removeFirst(samples.count - maxSampleCount)
        }
    }

    /// Returns up to `targetFrameCount` samples, evenly spaced across the
    /// recorder's buffer. Does not consume the buffer — call `start()` to reset.
    public func finalize(targetFrameCount: Int = 6) -> [Sample] {
        guard !samples.isEmpty else { return [] }
        let count = min(max(1, targetFrameCount), samples.count)
        if count == samples.count { return samples }
        if count == 1 { return [samples[samples.count / 2]] }
        var picked: [Sample] = []
        for index in 0 ..< count {
            let position = Int(Double(index) * Double(samples.count - 1) / Double(count - 1))
            picked.append(samples[position])
        }
        return picked
    }

    private static func encodeJPEG(pixelBuffer: CVPixelBuffer, context: CIContext, quality: CGFloat) -> Data? {
        let ciImage = CIImage(cvPixelBuffer: pixelBuffer)
        guard let cgImage = context.createCGImage(ciImage, from: ciImage.extent) else { return nil }
        let uiImage = UIImage(cgImage: cgImage)
        return uiImage.jpegData(compressionQuality: quality)
    }

    private static func extractFloat32(pixelBuffer: CVPixelBuffer) -> (bytes: Data, width: Int, height: Int) {
        CVPixelBufferLockBaseAddress(pixelBuffer, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(pixelBuffer, .readOnly) }
        let width = CVPixelBufferGetWidth(pixelBuffer)
        let height = CVPixelBufferGetHeight(pixelBuffer)
        let bytesPerRow = CVPixelBufferGetBytesPerRow(pixelBuffer)
        let rowBytes = width * MemoryLayout<Float32>.size
        var out = Data(capacity: rowBytes * height)
        guard let baseAddress = CVPixelBufferGetBaseAddress(pixelBuffer) else {
            return (out, width, height)
        }
        for row in 0 ..< height {
            let rowStart = baseAddress.advanced(by: row * bytesPerRow)
            out.append(UnsafeBufferPointer(start: rowStart.assumingMemoryBound(to: UInt8.self), count: rowBytes))
        }
        return (out, width, height)
    }

    private static func extractUInt8(pixelBuffer: CVPixelBuffer) -> (bytes: Data, width: Int, height: Int) {
        CVPixelBufferLockBaseAddress(pixelBuffer, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(pixelBuffer, .readOnly) }
        let width = CVPixelBufferGetWidth(pixelBuffer)
        let height = CVPixelBufferGetHeight(pixelBuffer)
        let bytesPerRow = CVPixelBufferGetBytesPerRow(pixelBuffer)
        let rowBytes = width
        var out = Data(capacity: rowBytes * height)
        guard let baseAddress = CVPixelBufferGetBaseAddress(pixelBuffer) else {
            return (out, width, height)
        }
        for row in 0 ..< height {
            let rowStart = baseAddress.advanced(by: row * bytesPerRow)
            out.append(UnsafeBufferPointer(start: rowStart.assumingMemoryBound(to: UInt8.self), count: rowBytes))
        }
        return (out, width, height)
    }
}
#endif
