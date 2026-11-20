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

/// Loaded images, held in memory alone: nothing a chat shows is written to the device,
/// so a relaunch reads them from the server again.
@MainActor
enum ImageLoader {
    private static let cache = NSCache<NSString, PlatformImage>()
    /// One fetch per picture, however many rows ask for it at once.
    private static var loading: [NSString: Task<PlatformImage?, Never>] = [:]
    /// Ephemeral, so no response lands in URLCache's store on disk. Builds before this one
    /// read through `URLSession.shared`, whose cache may still hold pictures: cleared here.
    private static let session: URLSession = {
        URLCache.shared.removeAllCachedResponses()
        return URLSession(configuration: .ephemeral)
    }()

    static func cached(_ ref: ImageRef, _ server: Connection?) -> PlatformImage? {
        key(ref, server).flatMap { cache.object(forKey: $0) }
    }

    static func load(_ ref: ImageRef, from server: Connection?) async -> PlatformImage? {
        guard let key = key(ref, server) else { return nil }
        if let hit = cache.object(forKey: key) { return hit }
        if let running = loading[key] { return await running.value }
        let task = Task { () -> PlatformImage? in
            var data: Data?
            if let request = request(ref, server),
               let (body, response) = try? await session.data(for: request),
               (response as? HTTPURLResponse)?.statusCode ?? 200 == 200, PlatformImage(data: body) != nil {
                data = body
            }
            if data == nil { data = await readFile(ref, server) }
            guard let data, let image = PlatformImage(data: data) else { return nil }
            cache.setObject(image, forKey: key)
            return image
        }
        loading[key] = task
        defer { loading[key] = nil }
        return await task.value
    }

    /// `/file` serves attachments and recordings alone, so any other path an agent
    /// names comes back through `read_file` as a `data:` URL: the desktop's `ProofImage`.
    private static func readFile(_ ref: ImageRef, _ server: Connection?) async -> Data? {
        struct Body: Decodable { let dataUrl: String? }
        guard let server, let raw = ref.path ?? ref.url else { return nil }
        let path = raw.hasPrefix("file://") ? String(raw.dropFirst(7)) : raw
        guard path.hasPrefix("/"),
              let body = try? await server.call("read_file", ["path": .string(path)], as: Body.self),
              let base64 = body.dataUrl?.split(separator: ",", maxSplits: 1).last,
              let data = Data(base64Encoded: String(base64)) else { return nil }
        return data
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
        // Encoded by hand: `queryItems` leaves a `+` in a path, which the server reads as a space.
        let via = server.via?.addingPercentEncoding(withAllowedCharacters: .alphanumerics).map { "&via=\($0)" } ?? ""
        parts.percentEncodedQuery = "path=\(path)\(via)"
        guard let url = parts.url else { return nil }
        // The header, not the query: the token rides no URL.
        var request = URLRequest(url: url)
        request.setValue("Bearer \(server.token)", forHTTPHeaderField: "Authorization")
        return request
    }
}

/// A prompt's thumbnails in a row, scrolling sideways only where they outgrow the column,
/// so a short row keeps the bubble's trailing alignment.
struct ThumbnailRow<Content: View>: View {
    let spacing: CGFloat
    @ViewBuilder let content: Content

    var body: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: spacing) { content }
            ScrollView(.horizontal) { HStack(spacing: spacing) { content } }
                .scrollIndicators(.never)
        }
    }
}

/// One image, loaded on appear. A faint box stands in while it loads, and a
/// glyph where it could not be read. Callers size and clip it.
struct RemoteImage: View {
    @Environment(\.imageServer) private var server
    @Environment(Store.self) private var store
    let ref: ImageRef
    /// Fill the frame and crop, for a thumbnail; otherwise fit it whole.
    var fill = false
    /// Drawn instead of the glyph where the picture cannot be read: the path it stood for.
    var fallback: String?
    /// Kept with its ref, so a view handed another picture never shows the last one meanwhile.
    @State private var loaded: (ref: ImageRef, image: PlatformImage)?
    @State private var failed = false

    var body: some View {
        let up = server.map { store.serverState[$0.serverId] == .connected } ?? false
        Group {
            if let image = ImageLoader.cached(ref, server) ?? (loaded?.ref == ref ? loaded?.image : nil) {
                Image(platform: image)
                    .resizable()
                    .aspectRatio(contentMode: fill ? .fill : .fit)
            } else if failed, let fallback {
                Text(fallback).foregroundStyle(.secondary)
            } else {
                Rectangle().fill(.primary.opacity(0.06))
                    .overlay {
                        if failed { Image(systemName: "photo").foregroundStyle(.secondary) }
                    }
            }
        }
        .onAppear(perform: fetch)
        .onChange(of: ref) { fetch() }
        // A server out of reach for longer than the tries is tried again once it is back (#1347).
        .onChange(of: up) { if up { fetch() } }
    }

    /// Not `.task`: a reopened chat's rows are told they disappeared the instant they
    /// appear, while staying on screen, and that cancelled every load for good (#1357).
    /// A few spaced tries ride out a blip; the loader shares one fetch between them.
    private func fetch() {
        guard ImageLoader.cached(ref, server) == nil, loaded?.ref != ref else { return }
        let ref = ref
        failed = false
        Task {
            for wait in [0, 2, 5, 15] {
                try? await Task.sleep(for: .seconds(wait))
                if let image = await ImageLoader.load(ref, from: server) {
                    loaded = (ref, image)
                    return
                }
                failed = true
            }
        }
    }
}
