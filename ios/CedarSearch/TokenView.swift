import SwiftUI

struct TokenView: View {
    let onSave: (String) -> Void
    @State private var token = ""

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    SecureField("Bearer token", text: $token)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                } footer: {
                    Text("The BEARER_TOKEN from cedarengine's .env. It stays in this phone's keychain.")
                }
                Button("Save") { onSave(token.trimmingCharacters(in: .whitespacesAndNewlines)) }
                    .disabled(token.trimmingCharacters(in: .whitespaces).isEmpty)
            }
            .navigationTitle("Cedar")
        }
    }
}
