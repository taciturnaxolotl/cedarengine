import SwiftUI

/// A photo drawn upright, whatever rotation it was stored with.
struct PhotoImage: View {
    let photo: Photo
    var fill = false

    private var sideways: Bool { Int(photo.rotate).isMultiple(of: 180) == false }

    var body: some View {
        AsyncImage(url: photo.url) { phase in
            if let image = phase.image {
                GeometryReader { geo in
                    let size = sideways ? CGSize(width: geo.size.height, height: geo.size.width) : geo.size
                    image
                        .resizable()
                        .aspectRatio(contentMode: fill ? .fill : .fit)
                        .frame(width: size.width, height: size.height)
                        .clipped()
                        .rotationEffect(.degrees(photo.rotate))
                        .frame(width: geo.size.width, height: geo.size.height)
                }
            } else if phase.error != nil {
                Image(systemName: "photo")
                    .font(.title2)
                    .foregroundStyle(.tertiary)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
    }
}

/// Square tiles, three across, like the Photos library.
struct PhotoGrid: View {
    let photos: [Photo]
    let namespace: Namespace.ID
    let open: (Int) -> Void

    private let columns = Array(repeating: GridItem(.flexible(), spacing: 3), count: 3)

    var body: some View {
        LazyVGrid(columns: columns, spacing: 3) {
            ForEach(Array(photos.enumerated()), id: \.offset) { index, photo in
                Button { open(index) } label: {
                    Color(.secondarySystemFill)
                        .aspectRatio(1, contentMode: .fit)
                        .overlay { PhotoImage(photo: photo, fill: true) }
                        .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .matchedTransitionSource(id: index, in: namespace)
            }
        }
    }
}

/// Full screen, swipe between photos, pinch or double-tap to zoom.
struct PhotoViewer: View {
    let photos: [Photo]
    @State var index: Int
    @Environment(\.dismiss) private var dismiss
    @State private var chrome = true

    var body: some View {
        NavigationStack {
            TabView(selection: $index) {
                ForEach(Array(photos.enumerated()), id: \.offset) { i, photo in
                    ZoomablePhoto(photo: photo) { chrome.toggle() }
                        .tag(i)
                }
            }
            .tabViewStyle(.page(indexDisplayMode: photos.count > 1 && chrome ? .always : .never))
            .background(.black)
            .ignoresSafeArea()
            .navigationTitle(photos.count > 1 ? "\(index + 1) of \(photos.count)" : "")
            .navigationBarTitleDisplayMode(.inline)
            .toolbarBackgroundVisibility(.hidden, for: .navigationBar)
            .toolbarVisibility(chrome ? .visible : .hidden, for: .navigationBar)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button(role: .close) { dismiss() }
                }
            }
        }
        .statusBarHidden(!chrome)
        .animation(.easeInOut(duration: 0.2), value: chrome)
        .preferredColorScheme(.dark)
    }
}

private struct ZoomablePhoto: View {
    let photo: Photo
    let onTap: () -> Void

    @State private var scale: CGFloat = 1
    @State private var settled: CGFloat = 1
    @State private var offset: CGSize = .zero
    @State private var settledOffset: CGSize = .zero

    var body: some View {
        PhotoImage(photo: photo)
            .scaleEffect(scale)
            .offset(offset)
            .gesture(
                MagnifyGesture()
                    .onChanged { scale = max(1, settled * $0.magnification) }
                    .onEnded { _ in
                        settled = scale
                        if scale <= 1.01 { reset() }
                    }
            )
            .simultaneousGesture(
                DragGesture()
                    .onChanged { value in
                        guard settled > 1 else { return }
                        offset = CGSize(
                            width: settledOffset.width + value.translation.width,
                            height: settledOffset.height + value.translation.height
                        )
                    }
                    .onEnded { _ in settledOffset = offset },
                isEnabled: settled > 1
            )
            .onTapGesture(count: 2) {
                withAnimation(.spring(duration: 0.3)) {
                    if settled > 1 { reset() } else { scale = 2.5; settled = 2.5 }
                }
            }
            .onTapGesture(count: 1, perform: onTap)
    }

    private func reset() {
        scale = 1
        settled = 1
        offset = .zero
        settledOffset = .zero
    }
}
