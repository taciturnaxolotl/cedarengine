import CryptoKit
import Foundation
import Synchronization

/// How this phone proves who it is: a pasted token, or an indiko sign-in that renews itself.
actor Auth {
    struct Grant: Codable, Sendable {
        var access: String
        var refresh: String?
        var expiresAt: Date
        let clientId: String
        let tokenEndpoint: URL
    }

    enum Credential: Sendable {
        /// The shared secret pasted before indiko existed; an admin can retire it any day.
        case legacy(String)
        /// A minted `ce_` token, for devices without an indiko account.
        case token(String)
        case indiko(Grant)

        static func pasted(_ token: String) -> Credential {
            token.hasPrefix("ce_") ? .token(token) : .legacy(token)
        }
    }

    enum Kind: Sendable { case legacy, token, indiko }

    private var credential: Credential
    /// One renewal at a time: indiko treats a reused refresh token as theft and revokes the sign-in.
    private var renewing: Task<String, any Error>?
    /// The token to put in photo URLs, which `AsyncImage` loads without asking.
    nonisolated let latest: Mutex<String>
    nonisolated let kind: Kind

    init(_ credential: Credential) {
        self.credential = credential
        switch credential {
        case .legacy(let token):
            latest = Mutex(token)
            kind = .legacy
        case .token(let token):
            latest = Mutex(token)
            kind = .token
        case .indiko(let grant):
            latest = Mutex(grant.access)
            kind = .indiko
        }
    }

    /// What the keychain holds, preferring an indiko sign-in over a pasted token.
    static func stored() -> Auth? {
        if let data = Keychain.read(.oauth), let grant = try? JSONDecoder().decode(Grant.self, from: data) {
            return Auth(.indiko(grant))
        }
        if let data = Keychain.read(.bearer), let token = String(data: data, encoding: .utf8), !token.isEmpty {
            return Auth(.pasted(token))
        }
        return nil
    }

    func persist() {
        switch credential {
        case .legacy(let token), .token(let token):
            Keychain.save(Data(token.utf8), as: .bearer)
        case .indiko(let grant):
            if let data = try? JSONEncoder().encode(grant) { Keychain.save(data, as: .oauth) }
            // An indiko sign-in replaces any pasted token for good.
            Keychain.delete(.bearer)
        }
    }

    /// The bearer to send, renewed a minute before it lapses or when `force` says the server refused it.
    func bearer(force: Bool = false) async throws -> String {
        switch credential {
        case .legacy(let token), .token(let token):
            return token
        case .indiko(let grant):
            if !force, grant.expiresAt.timeIntervalSinceNow > 60 { return grant.access }
            if let renewing { return try await renewing.value }
            let task = Task { try await renew(grant) }
            renewing = task
            defer { renewing = nil }
            return try await task.value
        }
    }

    private func renew(_ old: Grant) async throws -> String {
        guard let refresh = old.refresh else {
            throw APIError.signedOut("Your indiko sign-in ended. Sign in again to keep going.")
        }
        let fresh: OAuth.TokenResponse
        do {
            fresh = try await OAuth.token(at: old.tokenEndpoint, [
                "grant_type": "refresh_token",
                "refresh_token": refresh,
                "client_id": old.clientId,
            ])
        } catch SignInError.refused(let reason) {
            throw APIError.signedOut("Your indiko sign-in expired or was revoked (\(reason)). Sign in again.")
        }
        var grant = old
        grant.access = fresh.access_token
        grant.refresh = fresh.refresh_token ?? old.refresh
        grant.expiresAt = Date.now.addingTimeInterval(fresh.expires_in ?? 3600)
        credential = .indiko(grant)
        latest.withLock { $0 = grant.access }
        persist()
        return grant.access
    }
}

/// Signing in with indiko: discovery, PKCE, and the token endpoint.
enum OAuth {
    static let callbackScheme = "cedarengine"
    static let redirectURI = "cedarengine://oauth"

    struct TokenResponse: Decodable {
        let access_token: String
        let refresh_token: String?
        let expires_in: TimeInterval?
    }

    struct Plan: Sendable {
        let authorizeURL: URL
        let state: String
        let verifier: String
        let clientId: String
        let tokenEndpoint: URL
        let issuer: String
    }

    private static func random(_ count: Int) -> String {
        var bytes = [UInt8](repeating: 0, count: count)
        _ = SecRandomCopyBytes(kSecRandomDefault, count, &bytes)
        return Data(bytes).base64URL
    }

    /// Ask the engine where to sign in and as which client, then build the authorization URL.
    static func plan(engine: URL) async throws -> Plan {
        struct Resource: Decodable {
            let resource: String
            let authorization_servers: [String]
            let clients: [String: String]
        }
        struct Server: Decodable {
            let authorization_endpoint: URL
            let token_endpoint: URL
        }
        let (prmData, _) = try await HTTP.send(URLRequest(url: engine.appending(path: ".well-known/oauth-protected-resource")))
        guard let prm = try? JSONDecoder().decode(Resource.self, from: prmData),
              let issuer = prm.authorization_servers.first, let issuerURL = URL(string: issuer),
              let clientId = prm.clients["ios"] else { throw SignInError.unavailable }
        let (metaData, _) = try await HTTP.send(
            URLRequest(url: issuerURL.appending(path: ".well-known/oauth-authorization-server"))
        )
        guard let server = try? JSONDecoder().decode(Server.self, from: metaData) else { throw SignInError.unavailable }

        let verifier = random(32)
        let state = random(16)
        let challenge = Data(SHA256.hash(data: Data(verifier.utf8))).base64URL
        var components = URLComponents(url: server.authorization_endpoint, resolvingAgainstBaseURL: false)!
        components.queryItems = [
            "response_type": "code",
            "client_id": clientId,
            "redirect_uri": redirectURI,
            "scope": "profile offline_access",
            "state": state,
            "code_challenge": challenge,
            "code_challenge_method": "S256",
            "resource": prm.resource,
        ].map { URLQueryItem(name: $0.key, value: $0.value) }
        return Plan(
            authorizeURL: components.url!, state: state, verifier: verifier,
            clientId: clientId, tokenEndpoint: server.token_endpoint, issuer: issuer
        )
    }

    /// Turn the callback URL into a grant, checking it answers the request we made.
    static func finish(_ plan: Plan, callback: URL) async throws -> Auth.Grant {
        let items = URLComponents(url: callback, resolvingAgainstBaseURL: false)?.queryItems ?? []
        let value = { (name: String) in items.first { $0.name == name }?.value }
        if let error = value("error") { throw SignInError.refused(value("error_description") ?? error) }
        guard value("state") == plan.state, let code = value("code") else { throw SignInError.mismatch }
        if let iss = value("iss"), iss != plan.issuer { throw SignInError.mismatch }

        let response = try await token(at: plan.tokenEndpoint, [
            "grant_type": "authorization_code",
            "code": code,
            "client_id": plan.clientId,
            "redirect_uri": redirectURI,
            "code_verifier": plan.verifier,
        ])
        return Auth.Grant(
            access: response.access_token,
            refresh: response.refresh_token,
            expiresAt: Date.now.addingTimeInterval(response.expires_in ?? 3600),
            clientId: plan.clientId,
            tokenEndpoint: plan.tokenEndpoint
        )
    }

    /// `refused` when indiko says no outright; a busy or broken indiko is a transient `failed`.
    static func token(at endpoint: URL, _ form: [String: String]) async throws -> TokenResponse {
        var request = URLRequest(url: endpoint)
        request.httpMethod = "POST"
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        var body = URLComponents()
        body.queryItems = form.map { URLQueryItem(name: $0.key, value: $0.value) }
        request.httpBody = Data((body.percentEncodedQuery ?? "").utf8)
        let (data, code) = try await HTTP.send(request)
        switch code {
        case 200:
            guard let response = try? JSONDecoder().decode(TokenResponse.self, from: data) else {
                throw APIError.failed("indiko sent an answer this app can't read.")
            }
            return response
        case 400, 401:
            struct Failure: Decodable { let error: String?; let error_description: String? }
            let failure = try? JSONDecoder().decode(Failure.self, from: data)
            throw SignInError.refused(failure?.error_description ?? failure?.error ?? "indiko refused the sign-in")
        default:
            throw APIError.failed("indiko is having trouble (\(code)). Try again in a moment.")
        }
    }
}

enum SignInError: LocalizedError {
    case refused(String)
    case mismatch
    case unavailable

    var errorDescription: String? {
        switch self {
        case .refused(let reason): reason
        case .mismatch: "The sign-in did not match the request. Try again."
        case .unavailable: "This cedarengine doesn't offer indiko sign-in yet. Use a token for now."
        }
    }
}

extension Data {
    var base64URL: String {
        base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}
