import SwiftUI

struct SearchView: View {
    let api: API
    let onSignOut: () -> Void

    @State private var query = ""
    @State private var people: [Person] = []
    @State private var error: String?
    @State private var loading = false

    var body: some View {
        NavigationStack {
            List(people) { person in
                NavigationLink(value: person) {
                    PersonRow(person: person)
                }
            }
            .listStyle(.plain)
            .overlay { placeholder }
            .navigationTitle("People")
            .navigationDestination(for: Person.self) { PersonView(person: $0) }
            .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: "Name")
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .toolbar {
                Menu {
                    Button("Forget token", role: .destructive, action: onSignOut)
                } label: {
                    Image(systemName: "ellipsis.circle")
                }
            }
            .task(id: query) { await run() }
        }
    }

    @ViewBuilder private var placeholder: some View {
        if let error {
            ContentUnavailableView("Couldn't search", systemImage: "exclamationmark.triangle", description: Text(error))
        } else if query.trimmingCharacters(in: .whitespaces).isEmpty {
            ContentUnavailableView("Search the directory", systemImage: "person.2", description: Text("First name, last name, or both."))
        } else if people.isEmpty && !loading {
            ContentUnavailableView.search(text: query)
        }
    }

    private func run() async {
        let trimmed = query.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty else {
            people = []
            error = nil
            return
        }
        try? await Task.sleep(for: .milliseconds(250))
        guard !Task.isCancelled else { return }
        loading = true
        defer { loading = false }
        do {
            let found = try await api.search(trimmed)
            guard !Task.isCancelled else { return }
            people = found
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

    var body: some View {
        HStack(spacing: 12) {
            Avatar(person: person, size: 44)
            VStack(alignment: .leading, spacing: 2) {
                Text(person.displayName).font(.body)
                if !person.subtitle.isEmpty {
                    Text(person.subtitle).font(.subheadline).foregroundStyle(.secondary)
                }
            }
        }
    }
}

struct Avatar: View {
    let person: Person
    let size: CGFloat

    var body: some View {
        AsyncImage(url: person.photoUrl.flatMap(URL.init(string:))) { image in
            image.resizable().scaledToFill()
        } placeholder: {
            Text(initials)
                .font(.system(size: size * 0.4, weight: .medium))
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(.quaternary)
        }
        .frame(width: size, height: size)
        .clipShape(Circle())
    }

    private var initials: String {
        let first = (person.nickname ?? person.firstName)?.first.map(String.init) ?? ""
        let last = person.lastName?.first.map(String.init) ?? ""
        return first + last
    }
}
