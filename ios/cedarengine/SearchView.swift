import SwiftUI

struct SearchView: View {
    @State var library: Library
    let onSignOut: () -> Void

    @State private var query = ""
    @State private var remote: [Person] = []
    @State private var error: String?
    @State private var loading = false
    @State private var path: [Person] = []
    @State private var filter = PersonFilter()

    private var trimmed: String { query.trimmingCharacters(in: .whitespaces) }

    /// Local results are instant; the network is only asked before the
    /// directory has been pulled once.
    private var results: [Person] {
        library.hasDirectory ? library.search(trimmed, filter: filter) : remote.filter(filter.matches)
    }

    private var browsing: Bool { trimmed.isEmpty && filter.isActive }

    var body: some View {
        NavigationStack(path: $path) {
            List {
                if browsing || (!trimmed.isEmpty && filter.isActive) {
                    Section {
                        ForEach(results) { person in
                            NavigationLink(value: person) { PersonRow(person: person, library: library) }
                        }
                    } header: {
                        HStack {
                            Text(filterSummary)
                                .lineLimit(1)
                            Spacer()
                            Button("Clear") { withAnimation { filter = PersonFilter() } }
                                .font(.subheadline)
                                .textCase(nil)
                        }
                    }
                } else if trimmed.isEmpty {
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
                if trimmed.isEmpty, !filter.isActive, library.syncing || library.syncedAt != nil {
                    status
                        .listRowBackground(Color.clear)
                        .listRowSeparator(.hidden)
                }
            }
            .listStyle(.plain)
            .scrollDismissesKeyboard(.immediately)
            .overlay { placeholder }
            .refreshable { await library.refresh() }
            .navigationTitle("People")
            .navigationDestination(for: Person.self) { PersonView(person: $0, library: library) }
            .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always))
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .onChange(of: filter.kind) { _, kind in
                if kind == .employees {
                    filter.studentClass = nil
                    filter.dorm = nil
                    filter.workersOnly = false
                }
                if kind == .students || kind == .dualEnrollment { filter.department = nil }
            }
            .toolbar {
                filterMenu
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

    private var filterMenu: some View {
        Menu {
            Picker("Show", selection: $filter.kind) {
                Label("Everyone", systemImage: "person.2").tag(PersonFilter.Kind.everyone)
                Label("Students", systemImage: "graduationcap").tag(PersonFilter.Kind.students)
                Label("Dual Enrollment", systemImage: "backpack").tag(PersonFilter.Kind.dualEnrollment)
                Label("Faculty & Staff", systemImage: "briefcase").tag(PersonFilter.Kind.employees)
            }
            if filter.kind != .employees {
                facet("Class", systemImage: "person.3.sequence", selection: $filter.studentClass, options: library.classes) {
                    library.glossary.className($0) ?? $0
                }
                facet("Dorm", systemImage: "bed.double", selection: $filter.dorm, options: library.dorms) { $0 }
                Toggle("Student Workers", systemImage: "wrench.and.screwdriver", isOn: $filter.workersOnly)
            }
            if filter.kind == .everyone || filter.kind == .employees {
                facet("Department", systemImage: "building.2", selection: $filter.department, options: library.departments) { $0 }
            }
            if filter.isActive {
                Divider()
                Button("Clear Filters", systemImage: "xmark.circle", role: .destructive) {
                    withAnimation { filter = PersonFilter() }
                }
            }
        } label: {
            Image(systemName: filter.isActive
                  ? "line.3.horizontal.decrease.circle.fill"
                  : "line.3.horizontal.decrease.circle")
        }
        .menuActionDismissBehavior(.disabled)
    }

    /// A submenu picking one value, or any, showing the current choice beneath its title.
    private func facet(
        _ title: String,
        systemImage: String,
        selection: Binding<String?>,
        options: [String],
        label: @escaping (String) -> String
    ) -> some View {
        Picker(selection: selection) {
            Text("Any").tag(String?.none)
            ForEach(options, id: \.self) { Text(label($0)).tag(Optional($0)) }
        } label: {
            Label(title, systemImage: systemImage)
            Text(selection.wrappedValue.map(label) ?? "Any")
        }
        .pickerStyle(.menu)
        .disabled(options.isEmpty)
    }

    /// "Students · Junior · Printy · 42 people"
    private var filterSummary: String {
        var parts: [String] = []
        switch filter.kind {
        case .everyone: break
        case .students: parts.append("Students")
        case .dualEnrollment: parts.append("Dual Enrollment")
        case .employees: parts.append("Faculty & Staff")
        }
        if let code = filter.studentClass { parts.append(library.glossary.className(code) ?? code) }
        if let dorm = filter.dorm { parts.append(dorm) }
        if filter.workersOnly { parts.append("Workers") }
        if let department = filter.department { parts.append(department) }
        let count = results.count
        parts.append(count == 1 ? "1 person" : "\(count.formatted()) people")
        return parts.joined(separator: " · ")
    }

    @ViewBuilder private var placeholder: some View {
        if let error, !library.hasDirectory {
            ContentUnavailableView("Can't Search", systemImage: "exclamationmark.triangle", description: Text(error))
        } else if browsing {
            if results.isEmpty {
                ContentUnavailableView(
                    "No Matches",
                    systemImage: "line.3.horizontal.decrease.circle",
                    description: Text("Nobody fits these filters.")
                )
            }
        } else if trimmed.isEmpty {
            if library.recents.isEmpty {
                ContentUnavailableView("Search People", systemImage: "magnifyingglass")
            }
        } else if results.isEmpty && !loading {
            ContentUnavailableView.search(text: query)
        }
    }

    /// The headcount, below the last row: seen only once you have scrolled the
    /// whole list, not pinned over it.
    @ViewBuilder private var status: some View {
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
