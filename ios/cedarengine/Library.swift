import Foundation
import Observation

/// Things shared by every screen: the whole directory, kept on the phone so a
/// search never waits on the network, plus photos and the glossary.
@Observable @MainActor
final class Library {
    let api: API
    private(set) var photos: [String: Photo] = [:]
    private(set) var glossary: Glossary = .empty
    private(set) var people: [Person] = []
    private(set) var recents: [Person] = []
    private(set) var syncing = false
    private(set) var syncedAt: Date?

    @ObservationIgnored private var index: [Entry] = []
    private var byId: [String: Person] = [:]
    @ObservationIgnored private var loaded = false

    nonisolated private static let directoryKey = "directory-v2.json"
    private static let recentsKey = "recents"
    private static let syncedKey = "syncedAt"
    private static let recentLimit = 12

    init(api: API) {
        self.api = api
        recents = (UserDefaults.standard.data(forKey: Self.recentsKey))
            .flatMap { try? JSONDecoder().decode([Person].self, from: $0) } ?? []
        syncedAt = UserDefaults.standard.object(forKey: Self.syncedKey) as? Date
    }

    var hasDirectory: Bool { !people.isEmpty }

    func load() async {
        guard !loaded else { return }
        loaded = true

        async let cachedPhotos = try? api.photos(.cache)
        async let cachedGlossary = try? api.glossary(.cache)
        async let cachedPeople = Self.readDirectory()
        if let photos = await cachedPhotos { self.photos = photos }
        if let glossary = await cachedGlossary { self.glossary = glossary }
        if let people = await cachedPeople { install(people) }

        await refresh()
    }

    /// Pulls everything again. About twenty requests and a few megabytes.
    func refresh() async {
        guard !syncing else { return }
        syncing = true
        defer { syncing = false }

        async let photos = try? api.photos()
        async let glossary = try? api.glossary()
        async let people = pullDirectory()
        if let photos = await photos { self.photos = photos }
        if let glossary = await glossary { self.glossary = glossary }
        if let people = await people, !people.isEmpty {
            install(people)
            syncedAt = .now
            UserDefaults.standard.set(syncedAt, forKey: Self.syncedKey)
            Task.detached(priority: .utility) { Self.writeDirectory(people) }
        }
    }

    /// The newest copy of somebody, so a page opened from an old cache or a
    /// stale recent still picks up what the last refresh learned.
    func current(_ person: Person) -> Person { byId[person.id] ?? person }

    /// Their photo: an asserted one first, then the directory's. Faculty carry a
    /// public URL; a student's lives behind the campus login, so it comes from
    /// the engine, which has it once the extension has fetched it.
    func photo(for person: Person) -> Photo? {
        if let known = photos[person.id] ?? person.directoryPhoto { return known }
        return api.photoURL(for: person).map { Photo(url: $0, rotate: 0) }
    }

    /// The server's rules, run locally: the first word starts a given name, the
    /// last a family name, any between either; or the whole query is a last name.
    func search(_ query: String, limit: Int = 100) -> [Person] {
        let folded = Entry.fold(query)
        let words = folded.split(whereSeparator: { $0.isWhitespace || $0 == "-" }).map(String.init)
        guard !words.isEmpty else { return [] }
        let whole = folded.split(whereSeparator: \.isWhitespace).joined(separator: " ")
        var out: [Person] = []
        for entry in index {
            let ordered = words.indices.allSatisfy { i in
                entry.names(for: i, of: words.count).contains { $0.hasPrefix(words[i]) }
            }
            guard ordered || entry.last.hasPrefix(whole) else { continue }
            out.append(entry.person)
            if out.count == limit { break }
        }
        return out
    }

    func visited(_ person: Person) {
        recents.removeAll { $0.id == person.id }
        recents.insert(person, at: 0)
        if recents.count > Self.recentLimit { recents.removeLast(recents.count - Self.recentLimit) }
        UserDefaults.standard.set(try? JSONEncoder().encode(recents), forKey: Self.recentsKey)
    }

    func clearRecents() {
        recents = []
        UserDefaults.standard.removeObject(forKey: Self.recentsKey)
    }

    /// Forgets everything this app has written, for signing out.
    static func wipe() {
        Disk.clear()
        UserDefaults.standard.removeObject(forKey: recentsKey)
        UserDefaults.standard.removeObject(forKey: syncedKey)
    }

    // MARK: Private

    private func install(_ people: [Person]) {
        self.people = people
        index = people.map(Entry.init)
        byId = Dictionary(people.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        recents = recents.map { byId[$0.id] ?? $0 }
    }

    private func pullDirectory() async -> [Person]? {
        var all: [Person] = []
        var seen = Set<String>()
        var offset = 0
        while true {
            guard let page = try? await api.page(offset: offset) else { return nil }
            for person in page where seen.insert(person.id).inserted { all.append(person) }
            if page.count < API.pageSize { return all }
            offset += API.pageSize
        }
    }

    nonisolated private static func readDirectory() async -> [Person]? {
        guard let data = Disk.read(directoryKey) else { return nil }
        return try? JSONDecoder().decode([Person].self, from: data)
    }

    nonisolated private static func writeDirectory(_ people: [Person]) {
        guard let data = try? JSONEncoder().encode(people) else { return }
        Disk.write(data, for: directoryKey)
    }

    private struct Entry {
        let person: Person
        let last: String
        let given: [String]
        let family: [String]
        let user: String

        init(_ person: Person) {
            self.person = person
            last = Self.fold(person.lastName ?? "")
            given = Self.words(person.firstName, person.nickname)
            family = Self.words(person.lastName)
            user = Self.fold(person.username ?? "")
        }

        /// Which name words the i-th of n query words may start, as on the server.
        func names(for i: Int, of n: Int) -> [String] {
            if n == 1 { return given + family + [user] }
            if i == 0 { return given }
            if i == n - 1 { return family }
            return given + family
        }

        static func words(_ names: String?...) -> [String] {
            names.flatMap { fold($0 ?? "").split(whereSeparator: { $0 == " " || $0 == "-" }).map(String.init) }
        }

        static func fold(_ s: String) -> String {
            s.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: nil)
        }
    }
}
