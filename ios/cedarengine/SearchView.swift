import SwiftUI

struct SearchView: View {
    @State var library: Library
    let onSignOut: () -> Void

    @State private var query = ""
    @State private var remote: [Person] = []
    @State private var error: String?
    @State private var loading = false
    @State private var path: [Person] = []

    private var trimmed: String { query.trimmingCharacters(in: .whitespaces) }

    /// Local results are instant; the network is only asked before the
    /// directory has been pulled once.
    private var results: [Person] {
        library.hasDirectory ? library.search(trimmed) : remote
    }

    var body: some View {
        NavigationStack(path: $path) {
            List {
                if trimmed.isEmpty {
                    if !library.recents.isEmpty {
                        Section {
                            ForEach(library.recents) { person in
                                NavigationLink(value: person) { PersonRow(person: person, library: library) }
                            }
                        } header: {
                            HStack {
                                Text("Recent")
                                Spacer()
                                Button("Clear") { withAnimation { library.clearRecents() } }
                                    .font(.subheadline)
                                    .textCase(nil)
                            }
                        }
                    }
                } else {
                    ForEach(results) { person in
                        NavigationLink(value: person) { PersonRow(person: person, library: library) }
                    }
                }
            }
            .listStyle(.plain)
            .scrollDismissesKeyboard(.immediately)
            .overlay { placeholder }
            .safeAreaInset(edge: .bottom) { status }
            .refreshable { await library.refresh() }
            .navigationTitle("People")
            .navigationDestination(for: Person.self) { PersonView(person: $0, library: library) }
            .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always))
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .toolbar {
                Menu {
                    Button("Refresh", systemImage: "arrow.clockwise") {
                        Task { await library.refresh() }
                    }
                    .disabled(library.syncing)
                    Button("Sign Out", systemImage: "rectangle.portrait.and.arrow.right", role: .destructive) {
                        Library.wipe()
                        onSignOut()
                    }
                } label: {
                    Image(systemName: "ellipsis.circle")
                }
            }
            .task {
                #if DEBUG
                if let open = ProcessInfo.processInfo.environment["CEDAR_OPEN"],
                   let person = try? await library.api.search(open, limit: 1).first {
                    path = [person]
                }
                #endif
                await library.load()
            }
            .task(id: query) { await searchRemotely() }
        }
    }

    @ViewBuilder private var placeholder: some View {
        if let error, !library.hasDirectory {
            ContentUnavailableView("Can't Search", systemImage: "exclamationmark.triangle", description: Text(error))
        } else if trimmed.isEmpty {
            if library.recents.isEmpty {
                ContentUnavailableView("Search People", systemImage: "magnifyingglass")
            }
        } else if results.isEmpty && !loading {
            ContentUnavailableView.search(text: query)
        }
    }

    @ViewBuilder private var status: some View {
        if trimmed.isEmpty, library.syncing || library.syncedAt != nil {
            HStack(spacing: 6) {
                if library.syncing {
                    ProgressView().controlSize(.mini)
                    Text("Updating…")
                } else if let at = library.syncedAt {
                    Text("\(library.people.count.formatted()) people · Updated \(at.formatted(.relative(presentation: .named)))")
                }
            }
            .font(.footnote)
            .foregroundStyle(.secondary)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 8)
        }
    }

    private func searchRemotely() async {
        guard !library.hasDirectory else { return }
        guard !trimmed.isEmpty else {
            remote = []
            error = nil
            return
        }
        try? await Task.sleep(for: .milliseconds(200))
        guard !Task.isCancelled else { return }
        loading = true
        defer { loading = false }
        do {
            let found = try await library.api.search(trimmed)
            guard !Task.isCancelled else { return }
            remote = found
            error = nil
        } catch is CancellationError {
        } catch let urlError as URLError where urlError.code == .cancelled {
        } catch {
            self.error = error.localizedDescription
        }
    }
}

struct PersonRow: View {
    let person: Person
    let library: Library

    var body: some View {
        HStack(spacing: 12) {
            Avatar(person: person, photo: library.photo(for: person), size: 40)
            VStack(alignment: .leading, spacing: 1) {
                Text(person.displayName)
                if let line = subtitle {
                    Text(line)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
        }
    }

    private var subtitle: String? {
        let parts: [String?] = person.isStudent
            ? [library.glossary.className(person.studentClass), person.room]
            : [person.title, person.department]
        let line = parts.clean.joined(separator: " · ")
        return line.isEmpty ? nil : line
    }
}
