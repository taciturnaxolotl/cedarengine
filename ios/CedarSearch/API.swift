import Foundation

struct Person: Codable, Identifiable, Hashable, Sendable {
    let id: String
    let username: String?
    let firstName: String?
    let lastName: String?
    let middleName: String?
    let nickname: String?
    let city: String?
    let state: String?
    let country: String?
    let department: String?
    let title: String?
    let officeName: String?
    let officeRoom: String?
    let officePhone: String?
    let dormName: String?
    let dormRoom: String?
    let studentType: String?
    let studentClass: String?
    let photoUrl: String?
    let present: Int

    var displayName: String {
        let first = nickname.flatMap { $0.isEmpty ? nil : $0 } ?? firstName ?? ""
        return [first, lastName ?? ""].filter { !$0.isEmpty }.joined(separator: " ")
    }

    var subtitle: String {
        if let dormName, !dormName.isEmpty {
            return [dormName, dormRoom, studentClass].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
        }
        return [title, department].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
    }

    var hometown: String? {
        let parts = [city, state, country].compactMap { $0 }.filter { !$0.isEmpty }
        return parts.isEmpty ? nil : parts.joined(separator: ", ")
    }
}

enum APIError: LocalizedError {
    case unauthorized
    case status(Int)

    var errorDescription: String? {
        switch self {
        case .unauthorized: "The token was refused."
        case .status(let code): "The server answered \(code)."
        }
    }
}

struct API: Sendable {
    static let base = URL(string: "https://cedarengine.dunkirk.sh")!

    let token: String

    func search(_ query: String, limit: Int = 50) async throws -> [Person] {
        var components = URLComponents(url: Self.base.appending(path: "v1/people"), resolvingAgainstBaseURL: false)!
        components.queryItems = [
            URLQueryItem(name: "q", value: query),
            URLQueryItem(name: "limit", value: String(limit)),
        ]
        struct Response: Decodable { let people: [Person] }
        let response: Response = try await get(components.url!)
        return response.people
    }

    private func get<T: Decodable>(_ url: URL) async throws -> T {
        var request = URLRequest(url: url)
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        let (data, response) = try await URLSession.shared.data(for: request)
        let code = (response as? HTTPURLResponse)?.statusCode ?? 0
        if code == 401 || code == 403 { throw APIError.unauthorized }
        guard (200..<300).contains(code) else { throw APIError.status(code) }
        return try JSONDecoder().decode(T.self, from: data)
    }
}
