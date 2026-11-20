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
    @Environment(\.horizontalSizeClass) private var width
    @Environment(\.verticalSizeClass) private var height
    let path: String
    @State private var player: AVPlayer?
    @State private var aspect: CGFloat = 16 / 10
    @State private var failed = false
    @State private var fullScreen = false

    var body: some View {
        if failed {
            // The message no longer shows the path, so a video that cannot play says which it was.
            Text(path).font(Theme.Font.footnote).foregroundStyle(Theme.secondary)
        } else {
            Group {
                if let player {
                    PlayerController(player: player, fullScreen: $fullScreen)
                        .overlay(alignment: .topLeading) {
                            // A wide video on an upright phone is too short for AVKit's full layout,
                            // and its compact one leaves full screen out until the phone is turned.
                            if aspect > 1, width == .compact, height == .regular { expand }
                        }
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

    /// AVKit's own full screen button, where its full layout draws it.
    private var expand: some View {
        Button { fullScreen = true } label: {
            Image(systemName: "arrow.up.left.and.arrow.down.right")
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(.white)
                .frame(width: 40, height: 34)
                .background(.ultraThinMaterial, in: Capsule())
                .environment(\.colorScheme, .dark)
        }
        .buttonStyle(.plain)
        .padding(8)
        .accessibilityLabel("Enter full screen")
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
        let player = AVPlayer(playerItem: AVPlayerItem(asset: asset))
        // A simulator recording opens on an empty edit (~0.095s), and paused at 0 it paints
        // nothing, so the poster is held at the first real frame, as desktop's #1243 does.
        if let first = try? await track.load(.segments).first(where: { !$0.isEmpty })?.timeMapping.target.start,
           first > .zero {
            await player.seek(to: first, toleranceBefore: .zero, toleranceAfter: .zero)
        }
        self.player = player
    }
}

/// UIKit's player rather than SwiftUI's `VideoPlayer`, which has no full screen button.
/// `fullScreen` presents AVKit's own full screen player on the same `AVPlayer`, closed by its X.
private struct PlayerController: UIViewControllerRepresentable {
    let player: AVPlayer
    @Binding var fullScreen: Bool

    func makeUIViewController(context: Context) -> AVPlayerViewController {
        let controller = AVPlayerViewController()
        controller.player = player
        return controller
    }

    func updateUIViewController(_ controller: AVPlayerViewController, context: Context) {
        controller.player = player
        guard fullScreen else { return }
        DispatchQueue.main.async { fullScreen = false }
        guard controller.presentedViewController == nil else { return }
        let full = AVPlayerViewController()
        full.player = player
        full.modalPresentationStyle = .fullScreen
        controller.present(full, animated: true)
    }
}
