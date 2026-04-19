import SwiftUI
import RoomPlan
import UIKit
import RoomViewCapture

/// The main capture screen. Wraps Apple's `RoomCaptureView` in SwiftUI, runs
/// a `RoomCaptureSession` with `RoomCaptureSessionDelegate` (not the view
/// delegate — avoids the NSCoding-conformance path), and uploads the
/// processed `CapturedRoom` to the API on Done.
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
        .navigationBarBackButtonHidden(controller.phase == .capturing)
        .sheet(item: $controller.result) { result in
            ResultScreen(
                result: result,
                webEditorURL: webEditorURL,
                onDismiss: {
                    controller.result = nil
                    dismiss()
                }
            )
        }
        .onAppear { controller.start() }
        .onDisappear { controller.stop() }
    }

    private var statusBar: some View {
        Text(controller.statusText)
            .font(.subheadline)
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            .background(.ultraThinMaterial, in: Capsule())
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
                Task { await controller.upload(apiBaseURL: apiBaseURL) }
            } label: {
                Label("Upload to Mac", systemImage: "arrow.up.circle")
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 8)
            }
            .buttonStyle(.borderedProminent)
            .disabled(controller.phase != .ready)

        case .uploading:
            ProgressView("Uploading…")
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
final class CaptureController: NSObject, ObservableObject, RoomCaptureSessionDelegate {
    enum Phase: Equatable {
        case idle
        case capturing
        case processing
        case ready
        case uploading
        case failed(String)
    }

    @Published var phase: Phase = .idle
    @Published var result: UploadResult?

    private weak var captureView: RoomCaptureView?
    private var capturedRoomData: CapturedRoomData?
    private var capturedRoom: CapturedRoom?
    private var captureStartedAt: Date?

    var statusText: String {
        switch phase {
        case .idle: return "Tap Scan to begin"
        case .capturing: return "Scanning… walk slowly around the room"
        case .processing: return "Processing scan…"
        case .ready: return "Scan ready. Upload to see it in the browser."
        case .uploading: return "Uploading to Mac…"
        case .failed(let message): return "Failed: \(message)"
        }
    }

    var canFinish: Bool {
        phase == .capturing
    }

    func attach(to view: RoomCaptureView) {
        captureView = view
        view.captureSession.delegate = self
    }

    func start() {
        guard RoomCaptureSession.isSupported, phase == .idle else {
            if !RoomCaptureSession.isSupported {
                phase = .failed("This device does not support RoomPlan (needs LiDAR).")
            }
            return
        }
        captureStartedAt = Date()
        captureView?.captureSession.run(configuration: .init())
        phase = .capturing
    }

    func finishCapture() {
        guard phase == .capturing else { return }
        phase = .processing
        captureView?.captureSession.stop(pauseARSession: false)
    }

    func stop() {
        captureView?.captureSession.stop(pauseARSession: true)
    }

    func reset() {
        capturedRoomData = nil
        capturedRoom = nil
        result = nil
        phase = .idle
        start()
    }

    // MARK: - RoomCaptureSessionDelegate

    nonisolated func captureSession(
        _ session: RoomCaptureSession,
        didEndWith data: CapturedRoomData,
        error: Error?
    ) {
        Task { @MainActor [weak self] in
            guard let self else { return }
            if let error {
                self.phase = .failed(error.localizedDescription)
                return
            }
            self.capturedRoomData = data
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

    // MARK: - Upload

    func upload(apiBaseURL: String) async {
        guard let capturedRoom, let baseURL = URL(string: apiBaseURL) else {
            phase = .failed("Invalid base URL or no captured room.")
            return
        }
        phase = .uploading
        let capturedAt = ISO8601DateFormatter().string(from: captureStartedAt ?? Date())
        let requestId = "req-ios-\(UUID().uuidString.prefix(8))"
        let clientCaptureId = "capture-ios-\(UUID().uuidString.prefix(8))"
        let deviceModel = await UIDevice.current.modelIdentifier
        let uploader = RoomPlanCaptureUploader(baseURL: baseURL)

        do {
            let payload = try capturedRoom.toRoomPlanPayloadEnvelope()
            let envelope = RoomPlanCaptureEnvelope(
                requestId: String(requestId),
                clientCaptureId: String(clientCaptureId),
                roomplanPayload: payload,
                captureMetadata: CaptureMetadataEnvelope(
                    deviceModel: deviceModel,
                    capturedAt: capturedAt,
                    videoExpected: false
                )
            )
            let response = try await uploader.uploadCapture(envelope)
            let qr = try JSONDecoder().decode(
                QRPayload.self,
                from: Data(response.qrPayload.utf8)
            )
            self.result = UploadResult(
                sceneId: response.sceneId,
                handoffToken: qr.handoffToken,
                handoffURL: response.handoffURL,
                expiresAt: response.expiresAt
            )
            phase = .ready
        } catch {
            phase = .failed(error.localizedDescription)
        }
    }
}

struct UploadResult: Identifiable {
    let sceneId: String
    let handoffToken: String
    let handoffURL: String
    let expiresAt: String
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
