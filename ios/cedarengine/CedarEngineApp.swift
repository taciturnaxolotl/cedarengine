import SwiftUI

@main
struct CedarEngineApp: App {
    @State private var token = Self.debugToken ?? Keychain.read()

    /// Lets the simulator be driven from the command line without typing a token.
    private static var debugToken: String? {
        #if DEBUG
        ProcessInfo.processInfo.environment["CEDAR_TOKEN"]
        #else
        nil
        #endif
    }

    var body: some Scene {
        WindowGroup {
            if let token, !token.isEmpty {
                SearchView(library: Library(api: API(token: token))) {
                    Keychain.delete()
                    self.token = nil
                }
                .id(token)
            } else {
                TokenView { entered in
                    Keychain.save(entered)
                    token = entered
                }
            }
        }
    }
}
