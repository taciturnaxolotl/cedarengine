import SwiftUI

struct PersonView: View {
    let person: Person

    var body: some View {
        List {
            Section {
                VStack(spacing: 12) {
                    Avatar(person: person, size: 120)
                    Text(person.displayName).font(.title2.bold())
                    if let username = person.username {
                        Text(username).font(.subheadline).foregroundStyle(.secondary)
                    }
                }
                .frame(maxWidth: .infinity)
                .listRowBackground(Color.clear)
            }

            Section {
                row("Dorm", [person.dormName, person.dormRoom])
                row("Class", [person.studentClass, person.studentType])
                row("Title", [person.title])
                row("Department", [person.department])
                row("Office", [person.officeName, person.officeRoom])
                if let phone = person.officePhone, !phone.isEmpty,
                   let url = URL(string: "tel:\(phone.filter { $0.isNumber || $0 == "+" })") {
                    LabeledContent("Phone") { Link(phone, destination: url) }
                }
                row("Hometown", [person.hometown])
                if person.present == 0 {
                    LabeledContent("Status", value: "No longer listed")
                }
                LabeledContent("ID", value: person.id)
                    .textSelection(.enabled)
            }
        }
        .navigationBarTitleDisplayMode(.inline)
    }

    @ViewBuilder
    private func row(_ label: String, _ parts: [String?]) -> some View {
        let value = parts.compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " ")
        if !value.isEmpty {
            LabeledContent(label, value: value)
        }
    }
}
