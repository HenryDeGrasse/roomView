import SwiftUI
import UIKit
import RoomViewCapture

/// Shown after a successful capture upload. Displays the handoff token, a
/// tap-to-copy row, a button that opens the web editor, and (when the finalize
/// pipeline was kicked off) a live progress indicator for the splat + texture
/// bake. Once the pipeline lands, the "Open replayable fixture" link goes
/// straight to `/?fixture=<id>` on the laptop so the user can re-open the same
/// room without re-scanning.
struct ResultScreen: View {
    let result: UploadResult
    let webEditorURL: String
    let apiBaseURL: String
    let onDismiss: () -> Void

    @State private var pipelineStatus: String = "queued"
    @State private var pipelineStage: String? = nil
    @State private var pipelineMessage: String? = nil
    @State private var pipelineFixtureURL: String? = nil
    @State private var pipelineError: String? = nil
    @State private var pollTask: Task<Void, Never>? = nil

    private var handoffEditorURL: URL? {
        guard var components = URLComponents(string: webEditorURL) else { return nil }
        var queryItems = components.queryItems ?? []
        queryItems.append(URLQueryItem(name: "handoff_token", value: result.handoffToken))
        components.queryItems = queryItems
        return components.url
    }

    private var fixtureEditorURL: URL? {
        let urlString = pipelineFixtureURL ?? result.fixtureURL
        guard let urlString else { return nil }
        return URL(string: urlString)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Scene") {
                    LabeledContent("Scene ID", value: result.sceneId)
                        .textSelection(.enabled)
                    LabeledContent("Frames uploaded", value: "\(result.frameCount)")
                    LabeledContent("Expires", value: result.expiresAt)
                        .font(.caption)
                }

                if result.finalizeJobId != nil {
                    Section("Texture bake") {
                        Label(pipelineStatus.capitalized, systemImage: pipelineStatusIcon)
                            .foregroundStyle(pipelineStatusColor)
                        if let stage = pipelineStage {
                            Text("Stage: \(stage)")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        if let message = pipelineMessage {
                            Text(message)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        if let error = pipelineError {
                            Text(error)
                                .font(.caption)
                                .foregroundStyle(.red)
                        }
                    }
                }

                if let fixtureEditorURL {
                    Section("Replayable fixture") {
                        Link(destination: fixtureEditorURL) {
                            Label("Open room in browser", systemImage: "safari")
                        }
                        if let fixtureId = result.fixtureId {
                            LabeledContent("Fixture ID", value: fixtureId)
                                .font(.caption.monospaced())
                                .textSelection(.enabled)
                        }
                        Text(fixtureEditorURL.absoluteString)
                            .font(.caption2.monospaced())
                            .foregroundStyle(.secondary)
                            .textSelection(.enabled)
                        Text("This URL shows the persistent capture — re-open it any time from the fixture picker.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }

                Section("Handoff token (one-shot)") {
                    Text(result.handoffToken)
                        .font(.caption.monospaced())
                        .textSelection(.enabled)
                    Button {
                        UIPasteboard.general.string = result.handoffToken
                    } label: {
                        Label("Copy token", systemImage: "doc.on.doc")
                    }
                    if let handoffEditorURL {
                        Link(destination: handoffEditorURL) {
                            Label("Open handoff URL", systemImage: "link")
                        }
                    }
                }
            }
            .navigationTitle("Uploaded")
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") {
                        pollTask?.cancel()
                        onDismiss()
                    }
                }
            }
        }
        .onAppear {
            guard result.finalizeJobId != nil else { return }
            pollTask = Task { await pollPipeline() }
        }
        .onDisappear {
            pollTask?.cancel()
        }
    }

    private var pipelineStatusIcon: String {
        switch pipelineStatus {
        case "ready": return "checkmark.circle.fill"
        case "failed": return "xmark.octagon.fill"
        case "processing": return "arrow.triangle.2.circlepath"
        default: return "clock"
        }
    }

    private var pipelineStatusColor: Color {
        switch pipelineStatus {
        case "ready": return .green
        case "failed": return .red
        case "processing": return .blue
        default: return .secondary
        }
    }

    private func pollPipeline() async {
        guard let jobId = result.finalizeJobId else { return }
        guard let baseURL = URL(string: apiBaseURL) else { return }
        let uploader = RoomPlanCaptureUploader(baseURL: baseURL)
        let pollIntervalNanos: UInt64 = 2_000_000_000 // 2s

        while !Task.isCancelled {
            do {
                let response = try await uploader.pollJob(jobId: jobId, sessionToken: result.handoffToken)
                pipelineError = nil
                pipelineStatus = response.job.status
                pipelineStage = response.job.stage
                pipelineMessage = response.job.progressMessage
                if let result = response.capturePipelineResult {
                    pipelineFixtureURL = result.fixtureURL
                }
                if response.job.status == "failed" {
                    pipelineError = response.job.errorCode ?? response.job.progressMessage
                    return
                }
                if response.job.status == "ready" {
                    return
                }
            } catch {
                pipelineError = error.localizedDescription
                // Keep polling — transient network errors shouldn't kill the UX.
            }
            try? await Task.sleep(nanoseconds: pollIntervalNanos)
        }
    }
}
