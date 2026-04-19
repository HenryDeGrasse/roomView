import SwiftUI

struct ContentView: View {
    @AppStorage("apiBaseURL") private var apiBaseURL: String = "http://192.168.1.20:3000"
    @AppStorage("webEditorURL") private var webEditorURL: String = "http://192.168.1.20:4288"
    @State private var captureScreenActive = false

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
}

#Preview {
    ContentView()
}
