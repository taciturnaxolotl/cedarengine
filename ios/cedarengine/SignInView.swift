import AuthenticationServices
import SwiftUI

/// Sign in with indiko, or paste a minted token for a device that has no account.
struct SignInView: View {
    let onSignIn: (Auth) -> Void

    @Environment(\.webAuthenticationSession) private var webAuthenticationSession
    @State private var token = ""
    @State private var busy = false
    @State private var error: String?

    private var trimmed: String { token.trimmingCharacters(in: .whitespacesAndNewlines) }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Button {
                        Task { await signInWithIndiko() }
                    } label: {
                        HStack {
                            Text("Sign in with indiko")
                            if busy {
                                Spacer()
                                ProgressView()
                            }
                        }
                    }
                    .disabled(busy)
                } footer: {
                    if let error {
                        Text(error).foregroundStyle(.red)
                    } else {
                        Text("Your role decides what you can see.")
                    }
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
                    Text("Saved to the keychain.")
                }
            }
            .navigationTitle("cedarengine")
        }
    }

    private func signInWithIndiko() async {
        busy = true
        defer { busy = false }
        do {
            let plan = try await OAuth.plan(engine: API.base)
            let callback = try await webAuthenticationSession.authenticate(
                using: plan.authorizeURL,
                callback: .customScheme(OAuth.callbackScheme),
                additionalHeaderFields: [:]
            )
            let auth = Auth(.indiko(try await OAuth.finish(plan, callback: callback)))
            try await API(auth: auth).verify()
            await auth.persist()
            onSignIn(auth)
        } catch ASWebAuthenticationSessionError.canceledLogin {
            return
        } catch APIError.unauthorized, APIError.forbidden {
            error = "Signed in, but your indiko account has no role on cedarengine."
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func useToken() async {
        guard !trimmed.isEmpty, !busy else { return }
        busy = true
        defer { busy = false }
        let auth = Auth(.token(trimmed))
        do {
            try await API(auth: auth).verify()
            await auth.persist()
            onSignIn(auth)
        } catch APIError.unauthorized {
            error = "Invalid token."
        } catch {
            self.error = error.localizedDescription
        }
    }
}
