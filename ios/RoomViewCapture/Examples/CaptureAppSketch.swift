// Non-compiling reference sketch. Copy into your app target (not the Swift
// Package), adjust bundle IDs / base URL, and iterate. This file is ignored by
// the package because it lives outside `Sources/`.
//
// Minimum surface area to exercise the Milestone 1 pipeline end-to-end:
//   1. Host a RoomPlan capture view.
//   2. Attach an ARSessionDelegate that forwards ARFrames into
//      FrameCaptureRecorder.
//   3. On "Save", post the RoomPlan payload, then post the sampled frames.

#if canImport(SwiftUI) && canImport(RoomPlan) && canImport(ARKit)
import ARKit
import RoomPlan
import RoomViewCapture
import SwiftUI
import UIKit

@available(iOS 17.0, *)
@MainActor
final class CaptureController: NSObject, ObservableObject, ARSessionDelegate {
    @Published var status: String = "Ready"
    @Published var lastSceneId: String?

    let coordinator: RoomPlanCaptureCoordinator
    let uploader: RoomPlanCaptureUploader
    let recorder: FrameCaptureRecorder
    private var capturedRoom: CapturedRoom?

    init(apiBaseURL: URL) {
        self.coordinator = RoomPlanCaptureCoordinator(baseURL: apiBaseURL)
        self.uploader = RoomPlanCaptureUploader(baseURL: apiBaseURL)
        self.recorder = FrameCaptureRecorder(minimumInterval: 0.5, maxSampleCount: 32)
        super.init()
    }

    func start() {
        recorder.start()
        coordinator.startCapture()
        // Sidecar delegate — forwards ARFrames to the recorder.
        coordinator.captureSession.arSession.delegate = self
        status = "Capturing"
    }

    func stop() {
        coordinator.stopCapture()
        recorder.stop()
        status = "Stopped"
    }

    nonisolated func session(_ session: ARSession, didUpdate frame: ARFrame) {
        Task { @MainActor in recorder.record(arFrame: frame) }
    }

    // Called after RoomPlan's delegate fires captureSession(_:didEndWith:error:).
    func save(capturedRoom: CapturedRoom) async {
        self.capturedRoom = capturedRoom
        status = "Uploading capture"
        do {
            // You provide the CapturedRoom → RoomPlanPayloadEnvelope mapping.
            // RoomPlan gives walls/floor/objects; map them into the existing
            // RoomPlanPayloadEnvelope struct (shapes match the TS contract).
            let captureResponse = try await coordinator.uploadCapture(
                capturedRoom: capturedRoom,
                requestId: UUID().uuidString,
                clientCaptureId: UUID().uuidString,
                deviceModel: UIDevice.current.model,
                capturedAt: ISO8601DateFormatter().string(from: Date()),
                videoExpected: true,
                payloadBuilder: { room in
                    // TODO: fill in from `room` — this is the bulk of the work
                    // your app still owes. Start with minimal walls/floor and
                    // iterate.
                    fatalError("Implement CapturedRoom → RoomPlanPayloadEnvelope mapping")
                }
            )
            lastSceneId = captureResponse.sceneId
            status = "Uploading frames"

            let samples = recorder.finalize(targetFrameCount: 6)
            let frameInputs = samples.map(FrameInputBuilder.build(sample:))
            let request = CaptureFramesRequestEnvelope(
                videoUploadToken: captureResponse.videoUploadToken ?? "",
                idempotencyKey: UUID().uuidString,
                frames: frameInputs
            )
            let response = try await uploader.uploadCaptureFrames(sceneId: captureResponse.sceneId, request: request)
            status = "Uploaded \(response.capturedFrames.count) frames · scene \(captureResponse.sceneId)"
        } catch {
            status = "Failed: \(error.localizedDescription)"
        }
    }
}

@available(iOS 17.0, *)
struct RoomCaptureViewRepresentable: UIViewRepresentable {
    let coordinator: RoomPlanCaptureCoordinator
    func makeUIView(context: Context) -> RoomCaptureView { coordinator.captureView }
    func updateUIView(_ uiView: RoomCaptureView, context: Context) {}
}

@available(iOS 17.0, *)
struct CaptureScreen: View {
    @StateObject private var controller = CaptureController(
        apiBaseURL: URL(string: "http://127.0.0.1:3000")!
    )

    var body: some View {
        VStack(spacing: 12) {
            Text(controller.status).font(.caption).foregroundStyle(.secondary)
            RoomCaptureViewRepresentable(coordinator: controller.coordinator)
                .frame(maxHeight: .infinity)
            HStack {
                Button("Start") { controller.start() }
                Button("Stop") { controller.stop() }
                // Save becomes active once RoomPlan's delegate hands you a
                // CapturedRoom. Wire that up in a RoomCaptureSessionDelegate.
            }
        }.padding()
    }
}
#endif
