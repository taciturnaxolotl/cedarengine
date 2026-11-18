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
        case token(String)
        case indiko(Grant)
    }

    private var credential: Credential
    /// The token to put in photo URLs, which `AsyncImage` loads without asking.
    nonisolated let latest: Mutex<String>

    init(_ credential: Credential) {
        self.credential = credential
        switch credential {
        case .token(let token): latest = Mutex(token)
        case .indiko(let grant): latest = Mutex(grant.access)
        }
    }

    /// What the keychain holds, preferring an indiko sign-in over a pasted token.
    static func stored() -> Auth? {
        if let data = Keychain.read(.oauth), let grant = try? JSONDecoder().decode(Grant.self, from: data) {
            return Auth(.indiko(grant))
        }
        if let data = Keychain.read(.bearer), let token = String(data: data, encoding: .utf8), !token.isEmpty {
            return Auth(.token(token))
        }
        return nil
    }

    func persist() {
        switch credential {
        case .token(let token):
            Keychain.save(Data(token.utf8), as: .bearer)
        case .indiko(let grant):
            if let data = try? JSONEncoder().encode(grant) { Keychain.save(data, as: .oauth) }
        }
    }

    /// The bearer to send, renewed a minute before it lapses or when `force` says the server refused it.
    func bearer(force: Bool = false) async throws -> String {
        guard case .indiko(var grant) = credential else {
            if case .token(let token) = credential { return token }
            throw APIError.unauthorized
        }
        if !force, grant.expiresAt.timeIntervalSinceNow > 60 { return grant.access }
        guard let refresh = grant.refresh else { throw APIError.unauthorized }

        let fresh = try await OAuth.token(at: grant.tokenEndpoint, [
            "grant_type": "refresh_token",
            "refresh_token": refresh,
            "client_id": grant.clientId,
        ])
        grant.access = fresh.access_token
        grant.refresh = fresh.refresh_token ?? grant.refresh
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
        let (prmData, _) = try await URLSession.shared.data(
            from: engine.appending(path: ".well-known/oauth-protected-resource")
        )
        let prm = try JSONDecoder().decode(Resource.self, from: prmData)
        guard let issuer = prm.authorization_servers.first, let issuerURL = URL(string: issuer),
              let clientId = prm.clients["ios"] else { throw APIError.status(0) }
        let (metaData, _) = try await URLSession.shared.data(
            from: issuerURL.appending(path: ".well-known/oauth-authorization-server")
        )
        let server = try JSONDecoder().decode(Server.self, from: metaData)

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

    static func token(at endpoint: URL, _ form: [String: String]) async throws -> TokenResponse {
        var request = URLRequest(url: endpoint)
        request.httpMethod = "POST"
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        var body = URLComponents()
        body.queryItems = form.map { URLQueryItem(name: $0.key, value: $0.value) }
        request.httpBody = Data((body.percentEncodedQuery ?? "").utf8)
        let (data, response) = try await URLSession.shared.data(for: request)
        guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw APIError.unauthorized }
        return try JSONDecoder().decode(TokenResponse.self, from: data)
    }
}

enum SignInError: LocalizedError {
    case refused(String)
    case mismatch

    var errorDescription: String? {
        switch self {
        case .refused(let reason): reason
        case .mismatch: "The sign-in did not match the request. Try again."
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
