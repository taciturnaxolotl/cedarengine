import Foundation
import Observation

/// Who is signed in, and the one place a sign-in begins or ends.
@Observable @MainActor
final class Session {
    private(set) var auth: Auth?
    /// Why the last sign-in ended on its own; nil after tapping Sign Out.
    private(set) var endedReason: String?

    init(auth: Auth?) {
        self.auth = auth
    }

    /// Checks the engine accepts `candidate` before keeping it, so a refused sign-in never lands.
    func signIn(_ candidate: Auth) async throws {
        try await API(auth: candidate).verify()
        await candidate.persist()
        endedReason = nil
        auth = candidate
    }

    /// Forgets the credential and everything fetched under it.
    func end(_ reason: String? = nil) {
        Keychain.deleteAll()
        Library.wipe()
        endedReason = reason
        auth = nil
    }

    /// Ends the session only if `refused` is still the one in use; a stale request must not sign out its successor.
    func end(_ reason: String, for refused: Auth) {
        guard refused === auth else { return }
        end(reason)
    }
}
