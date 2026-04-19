import SwiftUI
import UIKit

/// Shown after a successful capture upload. Displays the handoff token, a
/// tap-to-copy row, and a button that constructs the query-param URL the
/// web editor auto-redeems (`apps/web/src/server.ts:751-753`).
struct ResultScreen: View {
    let result: UploadResult
    let webEditorURL: String
    let onDismiss: () -> Void

    var editorURL: URL? {
        guard var components = URLComponents(string: webEditorURL) else { return nil }
        var queryItems = components.queryItems ?? []
        queryItems.append(URLQueryItem(name: "handoff_token", value: result.handoffToken))
        components.queryItems = queryItems
        return components.url
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Scene") {
                    LabeledContent("Scene ID", value: result.sceneId)
                        .textSelection(.enabled)
                    LabeledContent("Expires", value: result.expiresAt)
                        .font(.caption)
                }
                Section("Handoff token") {
                    Text(result.handoffToken)
                        .font(.caption.monospaced())
                        .textSelection(.enabled)
                    Button {
                        UIPasteboard.general.string = result.handoffToken
                    } label: {
                        Label("Copy token", systemImage: "doc.on.doc")
                    }
                }
                Section("Open in browser") {
                    if let editorURL {
                        Link(destination: editorURL) {
                            Label("Open editor (\(editorURL.host ?? "browser"))",
                                  systemImage: "safari")
                        }
                        Text(editorURL.absoluteString)
                            .font(.caption2.monospaced())
                            .foregroundStyle(.secondary)
                            .textSelection(.enabled)
                    }
                    Text("Open this URL in your laptop browser. The editor auto-redeems from the query param.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            .navigationTitle("Uploaded")
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { onDismiss() }
                }
            }
        }
    }
}
