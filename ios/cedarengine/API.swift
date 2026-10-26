import Foundation

// MARK: - Directory

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
    let studentWorker: String?
    let photoUrl: String?
    let present: Int?
    let firstSeen: String?
    let lastSeen: String?

    /// What they are called: the nickname when the directory has one.
    var displayName: String {
        [goesBy ?? firstName, lastName].clean.joined(separator: " ")
    }

    /// Legal name, middle included, when it says something the display name does not.
    var fullName: String? {
        let full = [firstName, middleName, lastName].clean.joined(separator: " ")
        return full == displayName ? nil : full
    }

    var goesBy: String? {
        guard let nickname, !nickname.isEmpty, nickname != firstName else { return nil }
        return nickname
    }

    /// Faculty and staff carry a title or an office. The directory also hands
    /// them a "GS" class and type, which means nothing about them.
    var isEmployee: Bool { !(title ?? "").isEmpty || !(officeName ?? "").isEmpty }

    var isStudent: Bool { !isEmployee && (!(studentClass ?? "").isEmpty || !(dormName ?? "").isEmpty) }

    var isStudentWorker: Bool { ["true", "y", "yes"].contains((studentWorker ?? "").lowercased()) }

    /// The directory's own photo, when it is a full URL anyone can load. Student
    /// photos are relative links into the campus portal, which needs a login.
    var directoryPhoto: Photo? {
        guard let photoUrl, photoUrl.hasPrefix("http"), let url = URL(string: photoUrl) else { return nil }
        return Photo(url: url, rotate: 0)
    }

    /// The number exactly as the directory lists it; short extensions are
    /// left alone rather than guessed into a full number.
    var phone: (display: String, url: URL)? {
        guard let shown = officePhone?.trimmingCharacters(in: .whitespaces), !shown.isEmpty else { return nil }
        let digits = shown.filter { $0.isNumber || $0 == "+" }
        guard digits.count >= 7, let url = URL(string: "tel:\(digits)") else { return (shown, URL(string: "tel:")!) }
        return (shown, url)
    }

    var room: String? {
        let joined = [dormName, dormRoom].clean.joined(separator: " ")
        return joined.isEmpty ? nil : joined
    }

    var office: String? {
        let joined = [officeName, officeRoom].clean.joined(separator: " ")
        return joined.isEmpty ? nil : joined
    }

    var hometown: String? {
        let parts = [city, state, country].clean
        return parts.isEmpty ? nil : parts.joined(separator: ", ")
    }

    var initials: String {
        [(goesBy ?? firstName)?.first, lastName?.first].compactMap { $0 }.map(String.init).joined()
    }
}

/// Who someone lives with: the people in their room, and in a suite hall the
/// rest of their suite. `suite` is nil in a hall without suites.
struct Roommates: Decodable, Sendable {
    let room: String?
    let suite: String?
    let roommates: [Person]
    let suitemates: [Person]

    static let none = Roommates(room: nil, suite: nil, roommates: [], suitemates: [])
}

struct Glossary: Decodable, Sendable {
    let classes: [String: String]
    let types: [String: String]

    static let empty = Glossary(classes: [:], types: [:])

    func className(_ code: String?) -> String? {
        guard let code, !code.isEmpty else { return nil }
        return classes[code] ?? code
    }

    func typeName(_ code: String?) -> String? {
        guard let code, !code.isEmpty else { return nil }
        return types[code] ?? code
    }
}

// MARK: - Facts

struct Photo: Hashable, Sendable {
    let url: URL
    /// Degrees clockwise the image needs turning to stand upright.
    let rotate: Double
}

struct Fact: Decodable, Sendable {
    enum Value: Sendable {
        case text(String)
        case photo(Photo)
        case other
    }

    let key: String
    let slot: String?
    let value: Value
    let source: String?
    let at: String?
    let studentId: String?

    private enum CodingKeys: String, CodingKey { case key, slot, value, source, at, studentId }
    private struct RawPhoto: Decodable { let url: String; let rotate: Double? }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        key = try c.decode(String.self, forKey: .key)
        slot = try c.decodeIfPresent(String.self, forKey: .slot)
        source = try c.decodeIfPresent(String.self, forKey: .source)
        at = try c.decodeIfPresent(String.self, forKey: .at)
        studentId = try c.decodeIfPresent(String.self, forKey: .studentId)
        if let text = try? c.decode(String.self, forKey: .value) {
            value = .text(text)
        } else if let raw = try? c.decode(RawPhoto.self, forKey: .value), let url = URL(string: raw.url) {
            value = .photo(Photo(url: url, rotate: raw.rotate ?? 0))
        } else {
            value = .other
        }
    }

    var photo: Photo? {
        if case .photo(let photo) = value { return photo }
        return nil
    }

    var text: String? {
        if case .text(let text) = value { return text }
        return nil
    }
}

// MARK: - Schedule

struct Schedule: Decodable, Sendable {
    struct Block: Decodable, Hashable, Sendable {
        let start: String
        let end: String
        let minutes: Int?
        let section: String
        let title: String?
        let kind: String?
        let building: String?
        let room: String?

        var place: String {
            [building, room].clean.joined(separator: " ")
        }

        /// "EGCP" out of "EGCP-1010-02", for colouring a subject consistently.
        var subject: String { String(section.split(separator: "-").first ?? Substring(section)) }

        var startMinute: Int { Self.minute(start) }
        var endMinute: Int { Self.minute(end) }

        private static func minute(_ hhmm: String) -> Int {
            let parts = hhmm.split(separator: ":").compactMap { Int($0) }
            return parts.count == 2 ? parts[0] * 60 + parts[1] : 0
        }
    }

    struct Day: Decodable, Identifiable, Sendable {
        let day: Int
        let label: String
        let blocks: [Block]
        var id: Int { day }
    }

    struct Section: Decodable, Identifiable, Sendable {
        let name: String
        let title: String?
        let faculty: String?
        let credits: Double?
        var id: String { name }
    }

    let term: String
    let credits: Double?
    let week: [Day]
    let sections: [Section]
    let online: [Section]
    let unmatched: [String]?
}

// MARK: - Major

struct MajorGuess: Decodable, Sendable {
    struct School: Decodable, Sendable {
        let name: String
        let agreement: Int
        let of: Int
        let unanimous: Bool
    }

    struct Guess: Decodable, Identifiable, Sendable {
        let title: String
        let score: Double
        let school: String?
        var id: String { title }
    }

    let courses: [String]
    let school: School?
    let guesses: [Guess]
}

// MARK: - History

struct History: Decodable, Sendable {
    struct DirectoryEvent: Decodable, Sendable {
        let seq: Int
        let at: String
        let kind: String
        let field: String?
        let was: Loose?
        let now: Loose?
    }

    struct BooklistEvent: Decodable, Sendable {
        let seq: Int
        let at: String
        let term: String
        let kind: String
        let added: [String]
        let removed: [String]
    }

    let directory: [DirectoryEvent]
    let booklists: [BooklistEvent]
}

/// A value whose JSON type the engine does not promise: text, a number, or null.
struct Loose: Decodable, Sendable {
    let text: String?

    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if let string = try? c.decode(String.self) { text = string }
        else if let number = try? c.decode(Double.self) {
            text = number.rounded() == number ? String(Int(number)) : String(number)
        } else if let flag = try? c.decode(Bool.self) { text = flag ? "yes" : "no" }
        else { text = nil }
    }
}

// MARK: - Client

enum APIError: LocalizedError {
    case unauthorized
    case notFound
    case status(Int)

    var errorDescription: String? {
        switch self {
        case .unauthorized: "The token was refused."
        case .notFound: "Nothing there."
        case .status(let code): "The server answered \(code)."
        }
    }
}

/// Where an answer comes from: the server, or the last answer the server gave.
enum Source: Sendable { case network, cache }

struct API: Sendable {
    static let base = URL(string: "https://cedarengine.dunkirk.sh")!
    static let pageSize = 500

    let token: String

    func search(_ query: String, limit: Int = 50) async throws -> [Person] {
        struct Response: Decodable { let people: [Person] }
        let response: Response = try await get("v1/people", ["q": query, "limit": String(limit)], store: false)
        return response.people
    }

    /// One slice of the whole directory, in the server's order (last name, then first).
    func page(offset: Int) async throws -> [Person] {
        struct Response: Decodable { let people: [Person] }
        let response: Response = try await get(
            "v1/people", ["limit": String(Self.pageSize), "offset": String(offset)], store: false
        )
        return response.people
    }

    /// The cheapest authenticated question: one row of the directory. Throws
    /// `unauthorized` for a bad token and whatever the network says otherwise.
    func verify() async throws {
        _ = try await search("", limit: 1)
    }

    func glossary(_ source: Source = .network) async throws -> Glossary {
        try await get("v1/glossary", source: source)
    }

    /// Every photograph anybody has asserted, keyed by person. One request at
    /// launch beats one per search row, and there are only a few hundred.
    func photos(_ source: Source = .network) async throws -> [String: Photo] {
        struct Response: Decodable { let people: [Fact] }
        let response: Response = try await get("v1/facts", ["key": "photo", "limit": "5000"], source: source)
        var book: [String: Photo] = [:]
        for fact in response.people {
            guard let id = fact.studentId, let photo = fact.photo, book[id] == nil else { continue }
            book[id] = photo
        }
        return book
    }

    func facts(for id: String, _ source: Source = .network) async throws -> [Fact] {
        struct Response: Decodable { let facts: [Fact] }
        let response: Response = try await get("v1/people/\(id)/facts", source: source)
        return response.facts
    }

    /// Nil when the engine holds no booklist for them, which is most staff and
    /// anyone the campus store never sold a book to.
    func schedule(for id: String, _ source: Source = .network) async throws -> Schedule? {
        try await optional("v1/people/\(id)/schedule", source)
    }

    func person(_ id: String, _ source: Source = .network) async throws -> Person {
        try await get("v1/people/\(id)", source: source)
    }

    /// Who the directory lists living with somebody: the people in their room,
    /// and in a suite hall the rest of their suite. Both empty for staff and
    /// anyone without a room number.
    func roommates(for id: String, _ source: Source = .network) async throws -> Roommates {
        try await get("v1/people/\(id)/roommates", source: source)
    }

    /// Nil for anyone no section lists as an instructor.
    func teaching(for id: String, _ source: Source = .network) async throws -> Schedule? {
        try await optional("v1/people/\(id)/teaching", source)
    }

    func major(for id: String, _ source: Source = .network) async throws -> MajorGuess? {
        try await optional("v1/people/\(id)/major", source)
    }

    func history(for id: String, _ source: Source = .network) async throws -> History {
        try await get("v1/people/\(id)/history", source: source)
    }

    private func optional<T: Decodable>(_ path: String, _ source: Source) async throws -> T? {
        do {
            return try await get(path, source: source)
        } catch APIError.notFound {
            if source == .network { Disk.write(Data("null".utf8), for: Disk.key(path, [:])) }
            return nil
        }
    }

    private func get<T: Decodable>(
        _ path: String, _ query: [String: String] = [:], source: Source = .network, store: Bool = true
    ) async throws -> T {
        let key = Disk.key(path, query)
        if source == .cache {
            guard let data = Disk.read(key) else { throw APIError.notFound }
            if data == Data("null".utf8) { throw APIError.notFound }
            return try JSONDecoder().decode(T.self, from: data)
        }

        var components = URLComponents(url: Self.base.appending(path: path), resolvingAgainstBaseURL: false)!
        if !query.isEmpty {
            components.queryItems = query.sorted { $0.key < $1.key }.map { URLQueryItem(name: $0.key, value: $0.value) }
        }
        var request = URLRequest(url: components.url!)
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        let (data, response) = try await URLSession.shared.data(for: request)
        let code = (response as? HTTPURLResponse)?.statusCode ?? 0
        if code == 401 || code == 403 { throw APIError.unauthorized }
        if code == 404 { throw APIError.notFound }
        guard (200..<300).contains(code) else { throw APIError.status(code) }
        let value = try JSONDecoder().decode(T.self, from: data)
        if store { Disk.write(data, for: key) }
        return value
    }
}

/// Responses kept on the phone so a screen has something to show before the
/// network answers. Encrypted at rest while the phone is locked.
enum Disk {
    private static let folder: URL = {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        let url = base.appending(path: "cache", directoryHint: .isDirectory)
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }()

    static func key(_ path: String, _ query: [String: String]) -> String {
        let q = query.sorted { $0.key < $1.key }.map { "\($0.key)=\($0.value)" }.joined(separator: "&")
        let raw = q.isEmpty ? path : "\(path)?\(q)"
        return raw.map { $0.isLetter || $0.isNumber || $0 == "." || $0 == "-" ? String($0) : "_" }.joined() + ".json"
    }

    static func read(_ key: String) -> Data? {
        try? Data(contentsOf: folder.appending(path: key))
    }

    static func write(_ data: Data, for key: String) {
        try? data.write(to: folder.appending(path: key), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }

    static func clear() {
        try? FileManager.default.removeItem(at: folder)
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    }
}

extension Array where Element == String? {
    /// The non-empty strings, in order.
    var clean: [String] { compactMap { $0 }.filter { !$0.isEmpty } }
}

enum When {
    static func parse(_ string: String?) -> Date? {
        guard let string else { return nil }
        if let date = try? Date(string, strategy: .iso8601.year().month().day().time(includingFractionalSeconds: true)) { return date }
        if let date = try? Date(string, strategy: .iso8601) { return date }
        if string.count == 10 { return try? Date(string, strategy: .iso8601.year().month().day()) }
        return nil
    }

    static func day(_ string: String?) -> String? {
        parse(string)?.formatted(date: .abbreviated, time: .omitted)
    }
}

extension Result where Failure == Error {
    init(_ body: () async throws -> Success) async {
        do { self = .success(try await body()) } catch { self = .failure(error) }
    }
}
