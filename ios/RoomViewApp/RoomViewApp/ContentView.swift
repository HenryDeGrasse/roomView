import SwiftUI

struct ContentView: View {
    @AppStorage("apiBaseURL") private var apiBaseURL: String = "http://192.168.1.20:3000"
    @AppStorage("webEditorURL") private var webEditorURL: String = "http://192.168.1.20:4288"
    @State private var captureScreenActive = false
    @State private var healthStatus: HealthStatus = .unknown
    @State private var healthMessage: String = ""

    var body: some View {
        NavigationStack {
            Form {
                Section("Mac dev server") {
                    TextField("API base URL", text: $apiBaseURL)
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)
                        .keyboardType(.URL)
                    TextField("Web editor base URL", text: $webEditorURL)
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)
                        .keyboardType(.URL)
                    Text("Mac: `ipconfig getifaddr en0` · phone must be on the same Wi-Fi.")
                        .font(.caption)
                        .foregroundStyle(.secondary)

                    Button {
                        Task { await testConnection() }
                    } label: {
                        Label("Test Mac connection", systemImage: "antenna.radiowaves.left.and.right")
                    }
                    .disabled(apiBaseURL.isEmpty)

                    if healthStatus != .unknown {
                        Label(healthMessage, systemImage: healthIcon)
                            .font(.caption)
                            .foregroundStyle(healthColor)
                    }
                }

                Section {
                    Button {
                        captureScreenActive = true
                    } label: {
                        Label("Scan a room", systemImage: "arkit")
                            .frame(maxWidth: .infinity)
                    }
                    .disabled(apiBaseURL.isEmpty)
                }

                Section("Troubleshooting") {
                    Text("• If connection test fails, confirm `npm run dev` is running on the Mac and the LAN IP hasn't changed.")
                    Text("• First-run uploads may hang ~60s while Python deps install on the Mac.")
                    Text("• If you scan but see 'no depth frames buffered' — your iOS version may not support depth during RoomPlan. Upload still works but splat/textures are skipped.")
                }
                .font(.caption)
                .foregroundStyle(.secondary)
            }
            .navigationTitle("RoomView Capture")
            .navigationDestination(isPresented: $captureScreenActive) {
                CaptureScreen(
                    apiBaseURL: apiBaseURL,
                    webEditorURL: webEditorURL
                )
            }
        }
    }

    private enum HealthStatus: Equatable {
        case unknown, ok, degraded, failed
    }

    private var healthIcon: String {
        switch healthStatus {
        case .ok: return "checkmark.circle.fill"
        case .degraded: return "exclamationmark.triangle.fill"
        case .failed: return "xmark.octagon.fill"
        case .unknown: return "questionmark.circle"
        }
    }

    private var healthColor: Color {
        switch healthStatus {
        case .ok: return .green
        case .degraded: return .orange
        case .failed: return .red
        case .unknown: return .secondary
        }
    }

    private func testConnection() async {
        healthStatus = .unknown
        healthMessage = "Testing…"
        guard let url = URL(string: "\(apiBaseURL)/health") else {
            healthStatus = .failed
            healthMessage = "Invalid API URL."
            return
        }
        do {
            var request = URLRequest(url: url)
            request.timeoutInterval = 5
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
                healthStatus = .failed
                healthMessage = "Mac responded with status \((response as? HTTPURLResponse)?.statusCode ?? -1)."
                return
            }
            let decoded = try JSONDecoder().decode(HealthResponse.self, from: data)
            if decoded.capturePipelineReady {
                healthStatus = .ok
                healthMessage = "Mac reachable · capture pipeline ready"
            } else {
                healthStatus = .degraded
                healthMessage = "Mac reachable but capture pipeline error: \(decoded.capturePipelineError ?? "unknown")"
            }
        } catch {
            healthStatus = .failed
            healthMessage = "Cannot reach Mac: \(error.localizedDescription)"
        }
    }

    private struct HealthResponse: Decodable {
        let status: String
        let capturePipelineReady: Bool
        let capturePipelineError: String?

        enum CodingKeys: String, CodingKey {
            case status
            case capturePipelineReady = "capture_pipeline_ready"
            case capturePipelineError = "capture_pipeline_error"
        }
    }
}

#Preview {
    ContentView()
}
