import AVKit
import SwiftUI

// A video the agent named in its reply, played where it was named: what
// `dray browser record stop` and `dray video add` print, the desktop's
// `RECORDING_IN_TEXT`. Read off the server's `/file`, which answers the byte
// ranges AVPlayer will not play without.

private let recordingPattern = #/(?:^|[\s"'`(<>\[=:])(\/[^\s"'`()<>]*\/browser(?:-dev)?\/recordings\/[^\/\s"'`()<>]+\/[^\/\s"'`()<>]+\.mp4)/#
    .anchorsMatchLineEndings()

/// Every recording a message names, once each, in the order it names them.
func recordingPaths(in text: String) -> [String] {
    var seen = Set<String>()
    return text.matches(of: recordingPattern).compactMap { match in
        let path = String(match.output.1)
        return seen.insert(path).inserted ? path : nil
    }
}

/// The token rides the query, where the images send a header: AVPlayer has no
/// documented way to set one, and `/file` takes either.
@MainActor func recordingURL(_ path: String, on server: Connection) -> URL? {
    guard let socket = socketURL(server.url),
          var parts = URLComponents(url: socket, resolvingAgainstBaseURL: false) else { return nil }
    parts.scheme = parts.scheme == "wss" ? "https" : "http"
    parts.path = (parts.path.hasSuffix("/") ? String(parts.path.dropLast()) : parts.path) + "/file"
    parts.queryItems = [URLQueryItem(name: "token", value: server.token), URLQueryItem(name: "path", value: path)] + server.viaQuery
    return parts.url
}

/// One recording in the reading column. Nothing is fetched until it comes on
/// screen, and a path holding no video draws nothing, as on the desktop.
struct RecordingPlayer: View {
    @Environment(\.imageServer) private var server
    let path: String
    @State private var player: AVPlayer?
    @State private var aspect: CGFloat = 16 / 10
    @State private var failed = false

    var body: some View {
        if !failed {
            Group {
                if let player {
                    VideoPlayer(player: player)
                } else {
                    Rectangle().fill(.primary.opacity(0.06))
                }
            }
            .aspectRatio(aspect, contentMode: .fit)
            .frame(maxWidth: 480, alignment: .leading)
            .clipShape(.rect(cornerRadius: Theme.Radius.md, style: .continuous))
            .task(id: path) { await prepare() }
            .onDisappear { player?.pause() }
        }
    }

    private func prepare() async {
        guard player == nil, let server, let url = recordingURL(path, on: server) else { return }
        let asset = AVURLAsset(url: url)
        guard (try? await asset.load(.isPlayable)) == true,
              let track = try? await asset.loadTracks(withMediaType: .video).first,
              let size = try? await track.load(.naturalSize), size.height > 0 else {
            failed = !Task.isCancelled
            return
        }
        aspect = size.width / size.height
        player = AVPlayer(playerItem: AVPlayerItem(asset: asset))
    }
}
