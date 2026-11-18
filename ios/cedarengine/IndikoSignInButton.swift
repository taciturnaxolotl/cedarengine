import AuthenticationServices
import SwiftUI

/// The indiko sign-in: plan, browser sheet, code exchange, then the session checks the engine accepts it.
struct IndikoSignInButton: View {
    let session: Session

    @Environment(\.webAuthenticationSession) private var webAuthenticationSession
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Button {
                Task { await signIn() }
            } label: {
                HStack {
                    Label("Sign in with indiko", systemImage: "person.badge.key")
                    if busy { ProgressView().controlSize(.small) }
                }
            }
            .disabled(busy)
            if let error {
                Text(error)
                    .font(.footnote)
                    .foregroundStyle(.red)
            }
        }
    }

    private func signIn() async {
        busy = true
        error = nil
        defer { busy = false }
        do {
            let plan = try await OAuth.plan(engine: API.base)
            let callback = try await webAuthenticationSession.authenticate(
                using: plan.authorizeURL,
                callback: .customScheme(OAuth.callbackScheme),
                additionalHeaderFields: [:]
            )
            try await session.signIn(Auth(.indiko(try await OAuth.finish(plan, callback: callback))))
        } catch ASWebAuthenticationSessionError.canceledLogin {
        } catch {
            self.error = error.localizedDescription
        }
    }
}
