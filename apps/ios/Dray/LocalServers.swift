import SwiftUI
import ThinkingOrbs
import UIKit

/// One dev server the desktop's Browser tab lists; `local_servers.rs`'s `LocalServer`.
struct LocalServer: Decodable, Hashable {
    let port: Int
    let process: String
    /// Started under the session's agent, as against by hand in its checkout.
    let mine: Bool
    /// Its public link, where somebody shared it.
    let share: String?
}

/// The session view's way in: a toolbar button opening the server list.
struct LocalServersButton: ViewModifier {
    let key: SessionKey
    @State private var open = false

    func body(content: Content) -> some View {
        content
            .toolbar { Button("Local servers", systemImage: "globe") { open = true } }
            .sheet(isPresented: $open) { LocalServersView(key: key) }
    }
}

/// A session's dev servers on its machine, each shareable by public link.
/// Nothing on the wire announces a server or a share, so the list is re-read
/// every 5s while on screen, the desktop's own rhythm.
struct LocalServersView: View {
    @Environment(Store.self) private var store
    @Environment(\.dismiss) private var dismiss
    let key: SessionKey

    @State private var servers: [LocalServer]?
    @State private var readError: String?
    @State private var sharing: (port: Int, since: Date)?
    /// The first share on a machine registers its tunnel, a wait of minutes.
    @State private var settingUp = false
    @State private var failures: [Int: String] = [:]
    @State private var copied: URL?

    var body: some View {
        NavigationStack {
            content
                .navigationTitle("Local servers")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar { Button("Done") { dismiss() } }
        }
        .presentationDetents([.medium, .large])
        .task {
            while !Task.isCancelled {
                await read()
                try? await Task.sleep(for: .seconds(5))
            }
        }
    }

    @ViewBuilder private var content: some View {
        if let servers, !servers.isEmpty {
            ScrollView {
                VStack(alignment: .leading, spacing: Theme.Space.s) {
                    GroupLabel("Running on \(store.name(of: key.server))")
                    ForEach(servers, id: \.port) { row($0).card() }
                    Text("A public link is one anyone can open, until you stop it.")
                        .font(Theme.Font.meta).foregroundStyle(Theme.tertiary)
                        .padding(.horizontal, Theme.Space.xs)
                }
                .padding(Theme.Space.l)
            }
            .page()
        } else if servers != nil {
            EmptyState(title: "No servers running",
                       message: "Dev servers this session starts, or ones started in its checkout, show here.") {
                Image(systemName: "globe").font(.largeTitle).foregroundStyle(Theme.tertiary)
            }
            .page()
        } else if let readError {
            EmptyState(title: "Couldn't list servers", message: readError) {
                Image(systemName: "exclamationmark.triangle").font(.largeTitle).foregroundStyle(Theme.tertiary)
            } actions: {
                Button { Task { await read() } } label: { Text("Try again").frame(maxWidth: .infinity) }
                    .buttonStyle(SecondaryButtonStyle())
            }
            .page()
        } else {
            Orb(.loading, size: 32, label: "Loading").frame(maxWidth: .infinity, maxHeight: .infinity).page()
        }
    }

    private func row(_ s: LocalServer) -> some View {
        VStack(alignment: .leading, spacing: Theme.Space.m) {
            HStack(alignment: .firstTextBaseline, spacing: Theme.Space.s) {
                Text(verbatim: "localhost:\(s.port)").font(Theme.Font.mono.weight(.medium)).foregroundStyle(Theme.text)
                Text(s.process).font(Theme.Font.meta).foregroundStyle(Theme.secondary).lineLimit(1)
                Spacer()
                if s.mine { Text("This session").font(Theme.Font.micro).foregroundStyle(Theme.tertiary) }
            }
            if let link = s.share.flatMap(URL.init(string:)) {
                shared(link, port: s.port)
            } else if let sharing, sharing.port == s.port {
                waiting(since: sharing.since)
            } else {
                Button { share(s.port) } label: {
                    Label("Get public link", systemImage: "link").frame(maxWidth: .infinity)
                }
                .buttonStyle(SecondaryButtonStyle())
                .disabled(sharing != nil)
            }
            if let failure = failures[s.port] {
                Text(failure).font(Theme.Font.callout).foregroundStyle(Theme.destructive).textSelection(.enabled)
            }
        }
    }

    /// The share's wait, and past half a minute what it is waiting on, so a
    /// stalled relay reads as one rather than as a spinner.
    private func waiting(since: Date) -> some View {
        TimelineView(.periodic(from: since, by: 5)) { context in
            VStack(alignment: .leading, spacing: Theme.Space.xs) {
                HStack(spacing: Theme.Space.s) {
                    Orb(.working)
                    Text(settingUp ? "Setting up tunnel…" : "Creating link…")
                        .font(Theme.Font.callout).foregroundStyle(Theme.secondary).shimmer()
                }
                if context.date.timeIntervalSince(since) >= 30 {
                    Text(settingUp
                        ? "A first link registers the tunnel, which can take a few minutes. It shows here once it's up, or why it failed."
                        : "Still waiting on the relay. The link shows here once it's up, or why it failed.")
                        .font(Theme.Font.meta).foregroundStyle(Theme.secondary)
                }
            }
        }
    }

    private func shared(_ link: URL, port: Int) -> some View {
        HStack(spacing: Theme.Space.xs) {
            Link(destination: link) {
                Label(link.host() ?? link.absoluteString, systemImage: "link")
                    .font(Theme.Font.callout)
                    .foregroundStyle(Theme.link)
                    .lineLimit(1).truncationMode(.middle)
            }
            Spacer(minLength: Theme.Space.s)
            Button {
                UIPasteboard.general.url = link
                Haptic.tap()
                copied = link
                Task {
                    try? await Task.sleep(for: .seconds(2))
                    if copied == link { copied = nil }
                }
            } label: {
                Image(systemName: copied == link ? "checkmark" : "doc.on.doc")
            }
            .buttonStyle(IconButtonStyle())
            .accessibilityLabel(copied == link ? "Copied" : "Copy link")
            ShareLink(item: link) { Image(systemName: "square.and.arrow.up") }
                .buttonStyle(IconButtonStyle())
                .accessibilityLabel("Share link")
            Button { stop(port) } label: { Image(systemName: "xmark") }
                .buttonStyle(IconButtonStyle())
                .accessibilityLabel("Stop sharing")
        }
    }


    private func read() async {
        do {
            let list: [LocalServer] = try await call("list_local_servers", ["sessionId": .string(key.id)])
            servers = list
            readError = nil
            // A share whose answer was lost with the socket can still land.
            for s in list where s.share != nil { failures[s.port] = nil }
        } catch {
            // A failed poll keeps the last list; only an empty sheet says why.
            readError = sentence(error)
        }
    }

    private func share(_ port: Int) {
        failures[port] = nil
        sharing = (port, Date())
        settingUp = false
        Task {
            if let ready: Bool = try? await call("share_ready") { settingUp = !ready }
        }
        Task {
            do {
                // Past the server's own bounds (5 min provisioning, 90s attach),
                // so its sentence arrives rather than this side's timeout.
                let _: String = try await call("share_port", ["sessionId": .string(key.id), "port": JSON(port)],
                    timeout: .seconds(420))
            } catch {
                failures[port] = sentence(error)
            }
            sharing = nil
            await read()
        }
    }

    private func stop(_ port: Int) {
        Task {
            do {
                let _: JSON = try await call("stop_share", ["sessionId": .string(key.id), "port": JSON(port)])
            } catch {
                failures[port] = sentence(error)
            }
            await read()
        }
    }

    private func call<T: Decodable>(_ cmd: String, _ args: [String: JSON] = [:], timeout: Duration = .seconds(60)) async throws -> T {
        guard let c = store.connection(key.server) else { throw DrayError("Not connected") }
        return try await c.call(cmd, args, timeout: timeout)
    }
}

/// The server's errors open lowercase, written to follow a colon.
private func sentence(_ error: Error) -> String {
    let s = error.localizedDescription
    return s.prefix(1).uppercased() + s.dropFirst()
}
