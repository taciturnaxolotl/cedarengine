import SwiftUI

@main
struct CedarEngineApp: App {
    @State private var auth = Self.debugToken.map { Auth(.token($0)) } ?? Auth.stored()

    /// Lets the simulator be driven from the command line without signing in.
    private static var debugToken: String? {
        #if DEBUG
        ProcessInfo.processInfo.environment["CEDAR_TOKEN"]
        #else
        nil
        #endif
    }

    var body: some Scene {
        WindowGroup {
            if let auth {
                SearchView(library: Library(api: API(auth: auth))) {
                    Keychain.deleteAll()
                    self.auth = nil
                }
                .id(ObjectIdentifier(auth))
            } else {
                SignInView { auth = $0 }
            }
        }
    }
}
