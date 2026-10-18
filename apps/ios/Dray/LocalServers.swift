import SwiftUI
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
            List {
                Section {
                    ForEach(servers, id: \.port) { row($0) }
                } header: {
                    Text("Running on \(store.name(of: key.server))")
                } footer: {
                    Text("A public link is one anyone can open, until you stop it.")
                }
            }
        } else if servers != nil {
            ContentUnavailableView("No servers running", systemImage: "globe",
                description: Text("Dev servers this session starts, or ones started in its checkout, show here."))
        } else if let readError {
            ContentUnavailableView("Couldn't list servers", systemImage: "exclamationmark.triangle",
                description: Text(readError))
        } else {
            Orb()
        }
    }

    private func row(_ s: LocalServer) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline) {
                Text(verbatim: "localhost:\(s.port)").font(.body.monospaced())
                Text(s.process).foregroundStyle(.secondary).lineLimit(1)
                Spacer()
                if s.mine { Text("this session").font(.caption).foregroundStyle(.secondary) }
            }
            if let link = s.share.flatMap(URL.init(string:)) {
                shared(link, port: s.port)
            } else if let sharing, sharing.port == s.port {
                waiting(since: sharing.since)
            } else {
                Button("Get public link", systemImage: "square.and.arrow.up") { share(s.port) }
                    .disabled(sharing != nil)
            }
            if let failure = failures[s.port] {
                Text(failure).font(.callout).foregroundStyle(.red).textSelection(.enabled)
            }
        }
        // Several buttons in one row: borderless, or a tap anywhere fires them all.
        .buttonStyle(.borderless)
    }

    /// The share's wait, and past half a minute what it is waiting on, so a
    /// stalled relay reads as one rather than as a spinner.
    private func waiting(since: Date) -> some View {
        TimelineView(.periodic(from: since, by: 5)) { context in
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 8) {
                    Orb()
                    Text(settingUp ? "Setting up tunnel…" : "Creating link…").foregroundStyle(.secondary)
                }
                if context.date.timeIntervalSince(since) >= 30 {
                    Text(settingUp
                        ? "A first link registers the tunnel, which can take a few minutes. It shows here once it's up, or why it failed."
                        : "Still waiting on the relay. The link shows here once it's up, or why it failed.")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
        }
    }

    private func shared(_ link: URL, port: Int) -> some View {
        HStack(spacing: 16) {
            Link(destination: link) {
                Label(link.host() ?? link.absoluteString, systemImage: "link")
                    .lineLimit(1).truncationMode(.middle)
            }
            Spacer()
            Button(copied == link ? "Copied" : "Copy link", systemImage: copied == link ? "checkmark" : "doc.on.doc") {
                UIPasteboard.general.url = link
                copied = link
                Task {
                    try? await Task.sleep(for: .seconds(2))
                    if copied == link { copied = nil }
                }
            }
            .labelStyle(.iconOnly)
            ShareLink(item: link) { Label("Share link", systemImage: "square.and.arrow.up") }
                .labelStyle(.iconOnly)
            Button("Stop sharing", systemImage: "xmark", role: .destructive) { stop(port) }
                .labelStyle(.iconOnly)
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
