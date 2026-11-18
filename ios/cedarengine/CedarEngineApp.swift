import SwiftUI

@main
struct CedarEngineApp: App {
    @State private var session = Session(auth: Self.debugToken.map { Auth(.pasted($0)) } ?? Auth.stored())

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
            if let auth = session.auth {
                SearchView(library: Library(api: API(auth: auth, session: session)), session: session)
                    .id(ObjectIdentifier(auth))
            } else {
                SignInView(session: session)
            }
        }
    }
}
