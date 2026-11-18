import SwiftUI

/// Sign in with indiko, or paste a minted token for a device that has no account.
struct SignInView: View {
    let session: Session

    @State private var token = ""
    @State private var busy = false
    @State private var error: String?

    private var trimmed: String { token.trimmingCharacters(in: .whitespacesAndNewlines) }

    var body: some View {
        NavigationStack {
            Form {
                if let reason = session.endedReason {
                    Section {
                        Label(reason, systemImage: "person.crop.circle.badge.exclamationmark")
                            .foregroundStyle(.orange)
                    } header: {
                        Text("Signed out")
                    }
                }

                Section {
                    IndikoSignInButton(session: session)
                } footer: {
                    Text("Your role on cedarengine decides what you can see. No role yet? Ask for an invite.")
                }

                Section {
                    SecureField("Token", text: $token)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .onSubmit { Task { await useToken() } }
                        .onChange(of: token) { error = nil }
                    Button("Use Token") { Task { await useToken() } }
                        .disabled(trimmed.isEmpty || busy)
                } header: {
                    Text("Or a token")
                } footer: {
                    if let error {
                        Text(error).foregroundStyle(.red)
                    } else {
                        Text("For devices without an indiko account. Saved to the keychain.")
                    }
                }
            }
            .navigationTitle("cedarengine")
        }
    }

    private func useToken() async {
        guard !trimmed.isEmpty, !busy else { return }
        busy = true
        error = nil
        defer { busy = false }
        do {
            try await session.signIn(Auth(.pasted(trimmed)))
        } catch {
            self.error = error.localizedDescription
        }
    }
}
