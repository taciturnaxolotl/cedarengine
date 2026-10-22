import SwiftUI

struct TokenView: View {
    let onSave: (String) -> Void

    @State private var token = ""
    @State private var checking = false
    @State private var error: String?

    private var trimmed: String { token.trimmingCharacters(in: .whitespacesAndNewlines) }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    SecureField("Token", text: $token)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .onSubmit { Task { await check() } }
                        .onChange(of: token) { error = nil }
                } footer: {
                    if let error {
                        Text(error).foregroundStyle(.red)
                    } else {
                        Text("Saved to the keychain.")
                    }
                }
                Button {
                    Task { await check() }
                } label: {
                    HStack {
                        Text("Sign In")
                        if checking {
                            Spacer()
                            ProgressView()
                        }
                    }
                }
                .disabled(trimmed.isEmpty || checking)
            }
            .navigationTitle("cedarengine")
        }
    }

    private func check() async {
        guard !trimmed.isEmpty, !checking else { return }
        checking = true
        defer { checking = false }
        do {
            try await API(token: trimmed).verify()
            onSave(trimmed)
        } catch APIError.unauthorized {
            error = "Invalid token."
        } catch {
            self.error = error.localizedDescription
        }
    }
}
