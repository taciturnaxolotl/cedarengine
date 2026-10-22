import SwiftUI

enum Subject {
    private static let palette: [Color] = [.blue, .green, .orange, .purple, .pink, .teal, .indigo, .mint]

    /// The same subject gets the same colour everywhere.
    static func color(_ code: String) -> Color {
        let hash = code.unicodeScalars.reduce(5381) { ($0 << 5) &+ $0 &+ Int($1.value) }
        return palette[abs(hash) % palette.count]
    }
}

/// Round, with grey initials underneath, like Contacts.
struct Avatar: View {
    let person: Person
    let photo: Photo?
    let size: CGFloat

    var body: some View {
        ZStack {
            LinearGradient(
                colors: [Color(white: 0.62), Color(white: 0.48)],
                startPoint: .top, endPoint: .bottom
            )
            Text(person.initials)
                .font(.system(size: size * 0.4, weight: .medium, design: .rounded))
                .foregroundStyle(.white)
            if let photo {
                AsyncImage(url: photo.url) { phase in
                    phase.image?
                        .resizable()
                        .scaledToFill()
                        .rotationEffect(.degrees(photo.rotate))
                }
            }
        }
        .frame(width: size, height: size)
        .clipShape(Circle())
    }
}
