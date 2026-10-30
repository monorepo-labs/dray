import SwiftUI

// Pictures in a transcript, shared with the island by path: a prompt's
// attachments, a tool's result, a markdown image. Archived ones are read off
// the server's `/file`, the desktop's `fileSrc`.

#if os(macOS)
typealias PlatformImage = NSImage
extension Image { init(platform image: PlatformImage) { self.init(nsImage: image) } }
#else
typealias PlatformImage = UIImage
extension Image { init(platform image: PlatformImage) { self.init(uiImage: image) } }
#endif

extension EnvironmentValues {
    /// The server a transcript's archived images are read from, set where it is drawn.
    @Entry var imageServer: Connection?
}

/// Loaded images held for the life of the process, so a scroll or a re-render never refetches.
@MainActor
enum ImageLoader {
    private static let cache = NSCache<NSString, PlatformImage>()

    static func cached(_ ref: ImageRef, _ server: Connection?) -> PlatformImage? {
        key(ref, server).flatMap { cache.object(forKey: $0) }
    }

    static func load(_ ref: ImageRef, from server: Connection?) async -> PlatformImage? {
        guard let key = key(ref, server) else { return nil }
        if let hit = cache.object(forKey: key) { return hit }
        guard let request = request(ref, server),
              let (data, response) = try? await URLSession.shared.data(for: request),
              (response as? HTTPURLResponse)?.statusCode ?? 200 == 200,
              let image = PlatformImage(data: data) else { return nil }
        cache.setObject(image, forKey: key)
        return image
    }

    /// A path is per server; a URL is the same picture from anywhere.
    private static func key(_ ref: ImageRef, _ server: Connection?) -> NSString? {
        if let path = ref.path { return "\(server?.serverId.uuidString ?? "")|\(path)" as NSString }
        return ref.url as NSString?
    }

    /// An http(s) or `data:` URL is read as it is; anything else is a path the server serves.
    private static func request(_ ref: ImageRef, _ server: Connection?) -> URLRequest? {
        if ref.path == nil, let s = ref.url, let url = URL(string: s), ["http", "https", "data"].contains(url.scheme) {
            return URLRequest(url: url)
        }
        guard let raw = ref.path ?? ref.url, let server, let socket = socketURL(server.url),
              var parts = URLComponents(url: socket, resolvingAgainstBaseURL: false),
              let path = (raw.hasPrefix("file://") ? String(raw.dropFirst(7)) : raw)
                .addingPercentEncoding(withAllowedCharacters: .alphanumerics) else { return nil }
        parts.scheme = parts.scheme == "wss" ? "https" : "http"
        parts.path = (parts.path.hasSuffix("/") ? String(parts.path.dropLast()) : parts.path) + "/file"
        parts.percentEncodedQuery = "path=\(path)"
        guard let url = parts.url else { return nil }
        // The header, not the query: the token rides no URL.
        var request = URLRequest(url: url)
        request.setValue("Bearer \(server.token)", forHTTPHeaderField: "Authorization")
        return request
    }
}

/// One image, loaded on appear. A faint box stands in while it loads, and a
/// glyph where it could not be read. Callers size and clip it.
struct RemoteImage: View {
    @Environment(\.imageServer) private var server
    let ref: ImageRef
    /// Fill the frame and crop, for a thumbnail; otherwise fit it whole.
    var fill = false
    @State private var loaded: PlatformImage?
    @State private var failed = false

    var body: some View {
        Group {
            if let image = loaded ?? ImageLoader.cached(ref, server) {
                Image(platform: image)
                    .resizable()
                    .aspectRatio(contentMode: fill ? .fill : .fit)
            } else {
                Rectangle().fill(.primary.opacity(0.06))
                    .overlay {
                        if failed { Image(systemName: "photo").foregroundStyle(.secondary) }
                    }
            }
        }
        .task(id: ref) {
            guard ImageLoader.cached(ref, server) == nil else { return }
            loaded = await ImageLoader.load(ref, from: server)
            failed = loaded == nil
        }
    }
}
