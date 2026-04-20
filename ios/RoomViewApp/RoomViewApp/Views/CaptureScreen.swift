import SwiftUI
import RoomPlan
import UIKit
import RoomViewCapture
#if canImport(ARKit)
import ARKit
#endif

/// The main capture screen. Wraps Apple's `RoomCaptureView` in SwiftUI, runs
/// a `RoomCaptureSession` with `RoomCaptureSessionDelegate`, and drives the
/// full upload pipeline: RoomPlan → captured frames → finalize (promote to
/// fixture + kick off splat/texture bake).
///
/// Frame capture runs alongside RoomPlan: we attach an `ARSessionDelegate` to
/// the underlying `RoomCaptureSession.arSession` so the recorder samples RGB +
/// LiDAR depth + 6DoF pose at 0.5s intervals while the user walks the room.
struct CaptureScreen: View {
    let apiBaseURL: String
    let webEditorURL: String

    @StateObject private var controller = CaptureController()
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        ZStack {
            RoomCaptureViewRepresentable(controller: controller)
                .ignoresSafeArea()

            VStack {
                Spacer()
                statusBar
                actionBar
            }
            .padding()
        }
        .navigationBarBackButtonHidden(controller.phase == .capturing || controller.phase == .uploading)
        .sheet(item: $controller.result) { result in
            ResultScreen(
                result: result,
                webEditorURL: webEditorURL,
                apiBaseURL: apiBaseURL,
                onDismiss: {
                    controller.result = nil
                    dismiss()
                }
            )
        }
        .alert("Name this room", isPresented: $controller.promptingRoomLabel) {
            TextField("Living room, bedroom, kitchen…", text: $controller.roomLabel)
            Button("Upload") {
                Task { await controller.upload(apiBaseURL: apiBaseURL) }
            }
            Button("Cancel", role: .cancel) { controller.promptingRoomLabel = false }
        } message: {
            Text("The name makes it easy to find this capture in the editor later.")
        }
        .onAppear { controller.start() }
        .onDisappear { controller.stop() }
    }

    private var statusBar: some View {
        VStack(spacing: 4) {
            Text(controller.statusText)
                .font(.subheadline)
                .multilineTextAlignment(.center)
            if controller.phase == .capturing {
                Text(controller.frameCountText)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    }

    @ViewBuilder
    private var actionBar: some View {
        switch controller.phase {
        case .idle, .capturing:
            Button {
                controller.finishCapture()
            } label: {
                Label("Done", systemImage: "checkmark")
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 8)
            }
            .buttonStyle(.borderedProminent)
            .disabled(!controller.canFinish)

        case .processing, .ready:
            Button {
                controller.promptingRoomLabel = true
            } label: {
                Label("Upload to Mac", systemImage: "arrow.up.circle")
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 8)
            }
            .buttonStyle(.borderedProminent)
            .disabled(controller.phase != .ready)

        case .uploading:
            ProgressView(controller.uploadStageText)
                .frame(maxWidth: .infinity)

        case .failed:
            Button("Retry") { controller.reset() }
                .buttonStyle(.bordered)
        }
    }
}

// MARK: - UIKit bridge

private struct RoomCaptureViewRepresentable: UIViewRepresentable {
    let controller: CaptureController

    func makeUIView(context: Context) -> RoomCaptureView {
        let view = RoomCaptureView(frame: .zero)
        controller.attach(to: view)
        return view
    }

    func updateUIView(_ uiView: RoomCaptureView, context: Context) {}
}

// MARK: - Capture controller

@MainActor
final class CaptureController: NSObject, ObservableObject {
    enum Phase: Equatable {
        case idle
        case capturing
        case processing
        case ready
        case uploading
        case failed(String)
    }

    enum UploadStage: Equatable {
        case idle
        case roomplan
        case frames
        case finalize
    }

    @Published var phase: Phase = .idle
    @Published var result: UploadResult?
    @Published var recordedFrameCount: Int = 0
    @Published var uploadStage: UploadStage = .idle
    @Published var promptingRoomLabel: Bool = false
    @Published var roomLabel: String = ""

    private weak var captureView: RoomCaptureView?
    private var capturedRoomData: CapturedRoomData?
    private var capturedRoom: CapturedRoom?
    private var captureStartedAt: Date?

    // Ring-buffer cap. 256 × 0.5s = ~2 min of scan before we start dropping
    // the oldest samples. Covers every realistic room-walk duration. Each
    // sample is ~500KB (RGB+depth+confidence) → ~125MB peak RAM, well within
    // an iPhone Pro's budget.
    private let frameRecorder: FrameCaptureRecorder = FrameCaptureRecorder(
        minimumInterval: 0.5,
        maxSampleCount: 256,
        jpegQuality: 0.85
    )
    private let sessionProxy = RoomCaptureSessionDelegateProxy()
    private let arSessionProxy = ARSessionDelegateProxy()

    override init() {
        super.init()
        sessionProxy.controller = self
        arSessionProxy.controller = self
    }

    var statusText: String {
        switch phase {
        case .idle: return "Tap Scan to begin"
        case .capturing: return "Scanning… walk slowly around the room"
        case .processing: return "Processing scan…"
        case .ready: return recordedFrameCount == 0
            ? "Scan ready — no depth frames captured, textures will be placeholders"
            : "Scan ready. Upload to see it in the browser."
        case .uploading: return uploadStageText
        case .failed(let message): return "Failed: \(message)"
        }
    }

    var frameCountText: String {
        if recordedFrameCount == 0 {
            return "Waiting for LiDAR depth frame…"
        }
        return "\(recordedFrameCount) frame\(recordedFrameCount == 1 ? "" : "s") buffered"
    }

    var uploadStageText: String {
        switch uploadStage {
        case .idle: return "Uploading…"
        case .roomplan: return "Uploading scan to Mac…"
        case .frames: return "Uploading \(recordedFrameCount) frames…"
        case .finalize: return "Starting texture bake on Mac…"
        }
    }

    var canFinish: Bool {
        phase == .capturing
    }

    func attach(to view: RoomCaptureView) {
        captureView = view
        view.captureSession.delegate = sessionProxy
        // Tap the underlying ARSession so the recorder gets every ARFrame
        // (not just the RoomPlan-summarized events). ARFrame.sceneDepth
        // is populated on LiDAR devices; on iOS 17+ this usually works
        // alongside an active RoomCaptureSession. If it doesn't, the
        // recorder silently drops frames without depth.
        view.captureSession.arSession.delegate = arSessionProxy
    }

    func start() {
        guard RoomCaptureSession.isSupported, phase == .idle else {
            if !RoomCaptureSession.isSupported {
                phase = .failed("This device does not support RoomPlan (needs LiDAR).")
            }
            return
        }
        captureStartedAt = Date()
        frameRecorder.start()
        recordedFrameCount = 0
        captureView?.captureSession.run(configuration: .init())
        phase = .capturing
    }

    func finishCapture() {
        guard phase == .capturing else { return }
        phase = .processing
        frameRecorder.stop()
        captureView?.captureSession.stop(pauseARSession: false)
    }

    func stop() {
        frameRecorder.stop()
        captureView?.captureSession.stop(pauseARSession: true)
    }

    func reset() {
        capturedRoomData = nil
        capturedRoom = nil
        result = nil
        recordedFrameCount = 0
        uploadStage = .idle
        roomLabel = ""
        phase = .idle
        start()
    }

    fileprivate func recordARFrame(_ frame: ARFrame) {
        frameRecorder.record(arFrame: frame)
        let currentCount = frameRecorder.finalize(targetFrameCount: 64).count
        if currentCount != recordedFrameCount {
            recordedFrameCount = currentCount
        }
    }

    fileprivate func didEndCapture(data: CapturedRoomData, error: Error?) {
        if let error {
            phase = .failed(error.localizedDescription)
            return
        }
        capturedRoomData = data
        Task { @MainActor in
            do {
                let builder = RoomBuilder(options: [.beautifyObjects])
                let room = try await builder.capturedRoom(from: data)
                self.capturedRoom = room
                self.phase = .ready
            } catch {
                self.phase = .failed("Processing failed: \(error.localizedDescription)")
            }
        }
    }

    // MARK: - Upload pipeline

    func upload(apiBaseURL: String) async {
        promptingRoomLabel = false
        guard let capturedRoom, let baseURL = URL(string: apiBaseURL) else {
            phase = .failed("Invalid base URL or no captured room.")
            return
        }

        phase = .uploading
        uploadStage = .roomplan

        // Upload 128 evenly-spaced frames max. At ~500KB each, that's ~64MB
        // of JSON-base64 over LAN — ~5-10 seconds on Wi-Fi. More frames give
        // the splat generator and texture baker better coverage at the cost
        // of upload time.
        let samples = frameRecorder.finalize(targetFrameCount: 128)
        let videoExpected = !samples.isEmpty
        let capturedAt = ISO8601DateFormatter().string(from: captureStartedAt ?? Date())
        let requestId = "req-ios-\(UUID().uuidString.prefix(8))"
        let clientCaptureId = "capture-ios-\(UUID().uuidString.prefix(8))"
        let deviceModel = await UIDevice.current.modelIdentifier
        let uploader = RoomPlanCaptureUploader(baseURL: baseURL)
        let trimmedLabel = roomLabel.trimmingCharacters(in: .whitespacesAndNewlines)

        do {
            // --- Stage 1: RoomPlan payload -----------------------------
            let payload = try capturedRoom.toRoomPlanPayloadEnvelope()
            let envelope = RoomPlanCaptureEnvelope(
                requestId: String(requestId),
                clientCaptureId: String(clientCaptureId),
                roomplanPayload: payload,
                captureMetadata: CaptureMetadataEnvelope(
                    deviceModel: deviceModel,
                    capturedAt: capturedAt,
                    videoExpected: videoExpected
                )
            )
            let captureResponse = try await uploader.uploadCapture(envelope)
            let qr = try JSONDecoder().decode(
                QRPayload.self,
                from: Data(captureResponse.qrPayload.utf8)
            )

            // --- Stage 2: captured frames (best-effort) ---------------
            // If the scan produced any frames with depth, post them. If
            // there were zero, skip this stage and the server falls back
            // to RANSAC-fit walls when finalizing.
            if !samples.isEmpty, let videoUploadToken = captureResponse.videoUploadToken {
                uploadStage = .frames
                let frameInputs = samples.map { sample in
                    FrameInputBuilder.build(sample: sample)
                }
                let framesRequest = CaptureFramesRequestEnvelope(
                    videoUploadToken: videoUploadToken,
                    idempotencyKey: UUID().uuidString,
                    frames: frameInputs
                )
                _ = try await uploader.uploadCaptureFrames(
                    sceneId: captureResponse.sceneId,
                    request: framesRequest
                )
            }

            // --- Stage 3: finalize (promote + kick pipeline) ----------
            var finalizeResult: FinalizeCaptureResultEnvelope?
            var finalizeJob: JobRecordEnvelope?
            if !samples.isEmpty, let videoUploadToken = captureResponse.videoUploadToken {
                uploadStage = .finalize
                let finalizeResponse = try await uploader.finalizeCapture(
                    sceneId: captureResponse.sceneId,
                    request: FinalizeCaptureRequestEnvelope(
                        videoUploadToken: videoUploadToken,
                        idempotencyKey: UUID().uuidString,
                        roomLabel: trimmedLabel.isEmpty ? nil : trimmedLabel
                    )
                )
                finalizeResult = finalizeResponse.result
                finalizeJob = finalizeResponse.job
            }

            self.result = UploadResult(
                sceneId: captureResponse.sceneId,
                handoffToken: qr.handoffToken,
                handoffURL: captureResponse.handoffURL,
                expiresAt: captureResponse.expiresAt,
                frameCount: samples.count,
                finalizeJobId: finalizeJob?.jobId,
                fixtureId: finalizeResult?.fixtureId,
                fixtureURL: finalizeResult?.fixtureURL
            )
            phase = .ready
            uploadStage = .idle
        } catch {
            phase = .failed(error.localizedDescription)
            uploadStage = .idle
        }
    }
}

// MARK: - Delegate proxies
//
// RoomCaptureSessionDelegate and ARSessionDelegate both need `nonisolated`
// callbacks, but CaptureController is @MainActor. We route the callbacks
// through lightweight NSObject proxies that dispatch to the controller on the
// main actor — cleaner than juggling async overloads on the controller itself.

private final class RoomCaptureSessionDelegateProxy: NSObject, RoomCaptureSessionDelegate {
    weak var controller: CaptureController?

    nonisolated func captureSession(
        _ session: RoomCaptureSession,
        didEndWith data: CapturedRoomData,
        error: Error?
    ) {
        Task { @MainActor [weak self] in
            self?.controller?.didEndCapture(data: data, error: error)
        }
    }
}

private final class ARSessionDelegateProxy: NSObject, ARSessionDelegate {
    weak var controller: CaptureController?

    nonisolated func session(_ session: ARSession, didUpdate frame: ARFrame) {
        Task { @MainActor [weak self] in
            self?.controller?.recordARFrame(frame)
        }
    }
}

struct UploadResult: Identifiable {
    let sceneId: String
    let handoffToken: String
    let handoffURL: String
    let expiresAt: String
    let frameCount: Int
    let finalizeJobId: String?
    let fixtureId: String?
    let fixtureURL: String?
    var id: String { handoffToken }
}

private struct QRPayload: Decodable {
    let handoffToken: String
    enum CodingKeys: String, CodingKey { case handoffToken = "handoff_token" }
}

private extension UIDevice {
    var modelIdentifier: String {
        get async {
            var systemInfo = utsname()
            uname(&systemInfo)
            return withUnsafePointer(to: &systemInfo.machine) {
                $0.withMemoryRebound(to: CChar.self, capacity: 1) { String(cString: $0) }
            }
        }
    }
}
