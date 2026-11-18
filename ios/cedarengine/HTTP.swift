import Foundation

/// Every way a request can fail, already in words a person can read.
enum APIError: LocalizedError {
    /// The engine or indiko will not accept this sign-in any more; signing in again is the only fix.
    case signedOut(String)
    /// Signed in fine, but this role may not see it.
    case forbidden(String)
    case notFound
    /// The request never got an answer.
    case network(URLError)
    /// A server answered with a failure.
    case failed(String)

    /// Worth a retry: the sign-in, the role and the record are all fine.
    var isTransient: Bool {
        switch self {
        case .network, .failed: true
        case .signedOut, .forbidden, .notFound: false
        }
    }

    var errorDescription: String? {
        switch self {
        case .signedOut(let reason), .forbidden(let reason), .failed(let reason): reason
        case .notFound: "Nothing there."
        case .network(let error):
            switch error.code {
            case .notConnectedToInternet, .networkConnectionLost, .dataNotAllowed: "You're offline."
            case .timedOut: "The server took too long to answer."
            case .cannotFindHost, .cannotConnectToHost: "Can't reach the server right now."
            default: error.localizedDescription
            }
        }
    }

    /// What a non-2xx answer from the engine means, in the engine's own words where it gave some.
    init(status code: Int, body: Data, credential: Auth.Kind) {
        struct Body: Decodable { let error: String }
        let reason = (try? JSONDecoder().decode(Body.self, from: body)).map { Self.sentence($0.error) }
        switch code {
        case 401: self = .signedOut(Self.refusal(of: credential, reason))
        case 403: self = .forbidden(reason ?? "Your role cannot see this.")
        case 404: self = .notFound
        case 500...: self = .failed("cedarengine is having trouble (\(code)). Try again in a moment.")
        default: self = .failed(reason ?? "cedarengine answered \(code).")
        }
    }

    private static func refusal(of credential: Auth.Kind, _ reason: String?) -> String {
        switch credential {
        case .legacy:
            "cedarengine now signs in with indiko, and the old shared token no longer works. Sign in with indiko to keep going."
        case .token:
            "\(reason ?? "That token was refused.") Sign in with indiko or paste a new token."
        case .indiko:
            reason ?? "Your sign-in was refused. Sign in again."
        }
    }

    /// The engine writes reasons in lowercase without a stop, for logs; a screen wants a sentence.
    private static func sentence(_ text: String) -> String {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let first = trimmed.first else { return text }
        let body = first.uppercased() + trimmed.dropFirst()
        return ".!?".contains(body.last!) ? body : body + "."
    }
}

extension Error {
    var isTransient: Bool { (self as? APIError)?.isTransient ?? false }
}

enum HTTP {
    /// One request; a dead network becomes `APIError.network`, and cancellation passes through untouched.
    static func send(_ request: URLRequest) async throws -> (Data, Int) {
        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            return (data, (response as? HTTPURLResponse)?.statusCode ?? 0)
        } catch let error as URLError where error.code != .cancelled {
            throw APIError.network(error)
        }
    }
}
