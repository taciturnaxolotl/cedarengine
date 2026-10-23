import SwiftUI

struct PersonView: View {
    let person: Person
    let library: Library

    @State private var schedule: Schedule?
    @State private var teaching: Schedule?
    @State private var teachingDay = 1
    @State private var major: MajorGuess?
    @State private var history: History?
    @State private var facts: [Fact] = []
    @State private var loaded = false
    @State private var day = 1
    @State private var viewing: Viewing?
    @Namespace private var zoom

    /// Which photo is open, and what it should zoom out of.
    private struct Viewing: Identifiable {
        let index: Int
        let source: Int
        var id: Int { source }
    }

    private var glossary: Glossary { library.glossary }

    private var photos: [Photo] {
        let asserted = facts.compactMap(\.photo)
        if let known = library.photo(for: person), !asserted.contains(known) { return [known] + asserted }
        return asserted
    }

    var body: some View {
        List {
            header
            info
            if let teaching {
                ScheduleSection(title: "Teaching", schedule: teaching, day: $teachingDay)
                courses(teaching)
            }
            if !person.isEmployee {
                if let schedule {
                    ScheduleSection(title: "Schedule", schedule: schedule, day: $day)
                    if !schedule.online.isEmpty { online(schedule.online) }
                }
                if let major, major.school != nil || !major.guesses.isEmpty { majorSection(major) }
            }
            other
            if photos.count > 1 { photoSection }
            if let history { HistorySection(history: history) }
            record
        }
        .listStyle(.insetGrouped)
        .navigationBarTitleDisplayMode(.inline)
        .overlay(alignment: .bottom) {
            if !loaded { ProgressView().padding(.bottom, 24) }
        }
        .task { await load() }
        .fullScreenCover(item: $viewing) { viewing in
            PhotoViewer(photos: photos, index: viewing.index)
                .navigationTransition(.zoom(sourceID: viewing.source, in: zoom))
        }
    }

    // MARK: Header

    private var header: some View {
        Section {
            VStack(spacing: 10) {
                Button {
                    if !photos.isEmpty { viewing = Viewing(index: 0, source: -1) }
                } label: {
                    Avatar(person: person, photo: photos.first, size: 110)
                }
                .buttonStyle(.plain)
                .matchedTransitionSource(id: -1, in: zoom)
                Text(person.displayName)
                    .font(.title.weight(.semibold))
                    .multilineTextAlignment(.center)
                if let subtitle {
                    Text(subtitle)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                }
            }
            .frame(maxWidth: .infinity)
            .listRowBackground(Color.clear)
            .listRowInsets(EdgeInsets(top: 0, leading: 0, bottom: 4, trailing: 0))
        }
    }

    private var subtitle: String? {
        let parts: [String?] = person.isStudent
            ? [glossary.className(person.studentClass), person.room]
            : [person.title, person.department]
        let line = parts.clean.joined(separator: " · ")
        return line.isEmpty ? nil : line
    }

    // MARK: Info

    private var info: some View {
        Section {
            Field("Full Name", person.fullName)
            Field("Room", person.room)
            if person.isStudent {
                Field("Class", glossary.className(person.studentClass))
                Field("Program", glossary.typeName(person.studentType))
            }
            Field("Hometown", person.hometown)
            Field("Title", person.title)
            Field("Department", person.department)
            Field("Office", person.office)
            if let phone = person.phone {
                if phone.url.absoluteString == "tel:" {
                    Field("Extension", phone.display)
                } else {
                    LabeledContent("Phone") { Link(phone.display, destination: phone.url) }
                }
            }
            if person.isStudentWorker { Field("Student Worker", "Yes") }
            Field("Username", person.username)
            if person.present == 0 {
                LabeledContent("Status") { Text("Not Listed").foregroundStyle(.orange) }
            }
        }
    }

    // MARK: Courses

    /// Every section they teach, so the ones with no meeting time still show.
    private func courses(_ teaching: Schedule) -> some View {
        Section("Courses") {
            ForEach(teaching.sections + teaching.online) { section in
                VStack(alignment: .leading, spacing: 2) {
                    Text(section.title ?? section.name)
                    Text(section.name + (teaching.online.contains { $0.id == section.id } ? " · Online" : ""))
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
            }
        }
    }

    // MARK: Online

    private func online(_ sections: [Schedule.Section]) -> some View {
        Section("Online") {
            ForEach(sections) { section in
                VStack(alignment: .leading, spacing: 2) {
                    Text(section.title ?? section.name)
                    Text([section.name, section.faculty].clean.joined(separator: " · "))
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
            }
        }
    }

    // MARK: Major

    private func majorSection(_ major: MajorGuess) -> some View {
        Section {
            if let school = major.school {
                HStack(alignment: .firstTextBaseline) {
                    Text(school.name)
                    Spacer(minLength: 12)
                    Text("\(school.agreement)/\(school.of)")
                        .monospacedDigit()
                        .foregroundStyle(school.unanimous ? .green : .secondary)
                }
            }
            ForEach(major.guesses) { guess in
                LabeledContent(guess.title) {
                    Text(guess.score, format: .percent.precision(.fractionLength(0)))
                        .monospacedDigit()
                }
            }
        } header: {
            Text("Major")
        } footer: {
            Text("Guessed from booklists.")
        }
    }

    // MARK: Facts

    private var textFacts: [Fact] {
        facts.filter { $0.text != nil && !$0.key.hasSuffix(".id") }
    }

    @ViewBuilder private var other: some View {
        if !textFacts.isEmpty {
            Section("Other") {
                ForEach(Array(textFacts.enumerated()), id: \.offset) { _, fact in
                    Field(label(for: fact.key), fact.text)
                }
            }
        }
    }

    private func label(for key: String) -> String {
        switch key {
        case "groupme.name": "GroupMe"
        case "groupme.id.note": "GroupMe Note"
        default: key.replacingOccurrences(of: ".", with: " ").capitalized
        }
    }

    private var photoSection: some View {
        Section {
            PhotoGrid(photos: photos, namespace: zoom) { viewing = Viewing(index: $0, source: $0) }
                .listRowInsets(EdgeInsets(top: 3, leading: 3, bottom: 3, trailing: 3))
        } header: {
            HStack {
                Text("Photos")
                Spacer()
                Text("\(photos.count)")
            }
        }
    }

    // MARK: Record

    private var record: some View {
        Section {
            LabeledContent("ID", value: person.id)
                .textSelection(.enabled)
            Field("First Seen", When.day(person.firstSeen))
            Field("Last Seen", When.day(person.lastSeen))
        }
    }

    // MARK: Loading

    private func load() async {
        guard !loaded else { return }
        library.visited(person)
        await fill(from: .cache)
        await fill(from: .network)
        loaded = true
    }

    /// The cached answers first so the page is full at once, then the server's.
    /// A failed fetch keeps whatever the cache had.
    private func fill(from source: Source) async {
        let api = library.api
        let id = person.id
        let employee = person.isEmployee
        async let schedule = Result { employee ? nil : try await api.schedule(for: id, source) }
        async let teaching = Result { try await api.teaching(for: id, source) }
        async let major = Result { try await api.major(for: id, source) }
        async let history = Result { try await api.history(for: id, source) }
        async let facts = Result { try await api.facts(for: id, source) }

        if case .success(let found) = await schedule {
            if let found, self.schedule == nil { day = ScheduleSection.startingDay(in: found) }
            self.schedule = found
        }
        if case .success(let found) = await teaching {
            if let found, self.teaching == nil { teachingDay = ScheduleSection.startingDay(in: found) }
            self.teaching = found
        }
        if case .success(let found) = await major { self.major = found }
        if case .success(let found) = await history { self.history = found }
        if case .success(let found) = await facts { self.facts = found }
    }
}

/// A row that disappears when there is no value.
struct Field: View {
    let label: String
    let value: String?

    init(_ label: String, _ value: String?) {
        self.label = label
        self.value = value
    }

    var body: some View {
        if let value, !value.isEmpty {
            LabeledContent(label, value: value)
        }
    }
}

// MARK: - Schedule

struct ScheduleSection: View {
    let title: String
    let schedule: Schedule
    @Binding var day: Int

    private var selected: Schedule.Day? { schedule.week.first { $0.day == day } }

    var body: some View {
        Section {
            if let selected, !selected.blocks.isEmpty {
                ForEach(Array(selected.blocks.sorted { $0.startMinute < $1.startMinute }.enumerated()), id: \.offset) { _, block in
                    BlockRow(block: block)
                }
            } else {
                Text("No Classes").foregroundStyle(.secondary)
            }
        } header: {
            VStack(spacing: 10) {
                HStack {
                    Text(title)
                    Spacer()
                    Text(credits)
                }
                Picker("Day", selection: $day) {
                    ForEach(schedule.week) { d in
                        Text(d.label.prefix(3)).tag(d.day)
                    }
                }
                .pickerStyle(.segmented)
                .textCase(nil)
                .padding(.horizontal, -20)
                .padding(.bottom, 4)
            }
        }
    }

    private var credits: String {
        guard let credits = schedule.credits, credits > 0 else { return schedule.term }
        let shown = credits.rounded() == credits ? String(Int(credits)) : String(credits)
        return "\(schedule.term) · \(shown) Credits"
    }

    /// Today, or the next day with classes.
    static func startingDay(in schedule: Schedule) -> Int {
        let today = Calendar.current.component(.weekday, from: .now) - 1
        let ordered = schedule.week.sorted { ($0.day - today + 7) % 7 < ($1.day - today + 7) % 7 }
        return ordered.first { !$0.blocks.isEmpty }?.day ?? schedule.week.first?.day ?? 1
    }
}

struct BlockRow: View {
    let block: Schedule.Block

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            RoundedRectangle(cornerRadius: 2)
                .fill(Subject.color(block.subject))
                .frame(width: 4)
            VStack(alignment: .leading, spacing: 2) {
                Text(block.title ?? block.section)
                    .font(.body.weight(.medium))
                Text(details)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 8)
            VStack(alignment: .trailing, spacing: 2) {
                Text(clock(block.start))
                Text(clock(block.end)).foregroundStyle(.secondary)
            }
            .font(.subheadline.monospacedDigit())
        }
        .padding(.vertical, 2)
    }

    private var details: String {
        let kind = block.kind.flatMap { $0 == "Lecture" ? nil : $0 }
        let lines: [String?] = [block.section, kind, block.place]
        return lines.clean.joined(separator: "\n")
    }

    private func clock(_ hhmm: String) -> String {
        let parts = hhmm.split(separator: ":").compactMap { Int($0) }
        guard parts.count == 2,
              let date = Calendar.current.date(bySettingHour: parts[0], minute: parts[1], second: 0, of: .now)
        else { return hhmm }
        return date.formatted(date: .omitted, time: .shortened)
    }
}

// MARK: - History

struct HistorySection: View {
    let history: History

    private struct Entry {
        let at: String
        let title: String
        let detail: String?
    }

    private var entries: [Entry] {
        let directory = history.directory.map { event -> Entry in
            switch event.kind {
            case "appeared": return Entry(at: event.at, title: "Added", detail: nil)
            case "vanished": return Entry(at: event.at, title: "Removed", detail: nil)
            case "returned": return Entry(at: event.at, title: "Re-added", detail: nil)
            default:
                let field = (event.field ?? "Field").replacingOccurrences(of: "_", with: " ").capitalized
                let was = event.was?.text ?? "None"
                let now = event.now?.text ?? "None"
                return Entry(at: event.at, title: field, detail: "\(was) → \(now)")
            }
        }
        let booklists = history.booklists.map { event -> Entry in
            if event.kind == "first" {
                return Entry(at: event.at, title: "\(event.term) Books", detail: event.added.joined(separator: ", "))
            }
            let parts = [
                event.added.isEmpty ? nil : "Added " + event.added.joined(separator: ", "),
                event.removed.isEmpty ? nil : "Dropped " + event.removed.joined(separator: ", "),
            ].clean
            return Entry(at: event.at, title: "\(event.term) Books", detail: parts.joined(separator: "\n"))
        }
        return (directory + booklists).sorted { (When.parse($0.at) ?? .distantPast) > (When.parse($1.at) ?? .distantPast) }
    }

    var body: some View {
        let entries = entries
        if !entries.isEmpty {
            Section("History") {
                ForEach(Array(entries.enumerated()), id: \.offset) { _, entry in
                    VStack(alignment: .leading, spacing: 2) {
                        HStack(alignment: .firstTextBaseline) {
                            Text(entry.title)
                            Spacer()
                            Text(When.day(entry.at) ?? "")
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                        }
                        if let detail = entry.detail, !detail.isEmpty {
                            Text(detail)
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                        }
                    }
                }
            }
        }
    }
}
