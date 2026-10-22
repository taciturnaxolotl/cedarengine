import SwiftUI

@main
struct CedarSearchApp: App {
    @State private var token = Keychain.read()

    var body: some Scene {
        WindowGroup {
            if let token, !token.isEmpty {
                SearchView(api: API(token: token)) {
                    Keychain.delete()
                    self.token = nil
                }
            } else {
                TokenView { entered in
                    Keychain.save(entered)
                    token = entered
                }
            }
        }
    }
}
