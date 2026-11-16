import AVFoundation
import SwiftUI
import UIKit

/// Where Settings can go: a server's page, Dictation, Notifications, Appearance.
enum SettingsPage: Hashable {
    case server(UUID)
    case dictation
    case notifications
    case appearance
}

/// The one Settings screen: a card per server, then Add server, Dictation,
/// Notifications and about. Opened on one server's page when a banner's Fix asks.
struct SettingsView: View {
    @Environment(Store.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var path: [SettingsPage]
    @State private var adding = false
    @AppStorage(Dictations.serverKey) private var dictationPick = ""
    @AppStorage(NotificationSettings.allowKey) private var notify = true
    @AppStorage(AppearanceSettings.hideSessionsKey) private var hideSessions = false

    init(focus: UUID?) { _path = State(initialValue: focus.map { [.server($0)] } ?? []) }

    var body: some View {
        NavigationStack(path: $path) {
            ScrollView {
                VStack(spacing: 28) {
                    VStack(spacing: Theme.Space.s) {
                        ForEach(store.servers) { s in
                            NavigationLink(value: SettingsPage.server(s.id)) { ServerCard(server: s) }
                                .buttonStyle(RowButtonStyle())
                        }
                        Button { adding = true } label: { AddServerCard(first: store.servers.isEmpty) }
                            .buttonStyle(RowButtonStyle())
                    }

                    RowGroup {
                        NavigationLink(value: SettingsPage.dictation) {
                            SettingsRow("Dictation", icon: "mic",
                                        value: store.dictationServer(dictationPick).map { store.name(of: $0) } ?? "None")
                        }
                        RowDivider(inset: 48)
                        NavigationLink(value: SettingsPage.notifications) {
                            SettingsRow("Notifications", icon: "bell", value: notify ? "On" : "Off")
                        }
                        RowDivider(inset: 48)
                        NavigationLink(value: SettingsPage.appearance) {
                            SettingsRow("Appearance", icon: "circle.lefthalf.filled", value: hideSessions ? "Bots only" : nil)
                        }
                    }
                    .buttonStyle(RowButtonStyle())

                    RowGroup {
                        SettingsRow("Version", value: version, trailing: nil)
                        RowDivider()
                        Link(destination: URL(string: "https://drayhq.com")!) { SettingsRow("Website", trailing: "arrow.up.right") }
                        RowDivider()
                        Link(destination: URL(string: "https://drayhq.com/docs")!) { SettingsRow("Docs", trailing: "arrow.up.right") }
                    }
                    .buttonStyle(RowButtonStyle())
                }
                .padding(.horizontal, Theme.Space.l)
                .padding(.top, Theme.Space.m)
                .padding(.bottom, Theme.Space.xl)
            }
            .background(Theme.card.ignoresSafeArea())
            .foregroundStyle(Theme.text)
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { Button("Done") { dismiss() }.fontWeight(.semibold) }
            .navigationDestination(for: SettingsPage.self) { page in
                switch page {
                case .server(let id): ServerDetail(id: id)
                case .dictation: DictationSettings()
                case .notifications: NotificationSettings()
                case .appearance: AppearanceSettings()
                }
            }
            .sheet(isPresented: $adding) { AddServerView(link: nil) }
            .task { await Releases.shared.refresh() }
        }
    }

    private var version: String {
        let info = Bundle.main.infoDictionary
        return "\(info?["CFBundleShortVersionString"] as? String ?? "?") (\(info?["CFBundleVersion"] as? String ?? "?"))"
    }
}

// MARK: Pieces

/// A server: two stacked units, each with its light. The holes are cut, so
/// whatever the glyph sits on shows through.
struct ServerGlyph: Shape {
    func path(in r: CGRect) -> Path {
        let s = r.width / 24
        var p = Path()
        for top in [2.0, 12.5] {
            p.addRoundedRect(in: CGRect(x: r.minX + s, y: r.minY + top * s, width: 22 * s, height: 8.5 * s),
                             cornerSize: CGSize(width: 2.5 * s, height: 2.5 * s), style: .continuous)
            p.addEllipse(in: CGRect(x: r.minX + 4.5 * s, y: r.minY + (top + 2.75) * s, width: 3 * s, height: 3 * s))
        }
        return p
    }
}

/// A 40pt icon tile on a raised card.
private struct Tile<Content: View>: View {
    var size: CGFloat = 40
    @ViewBuilder let content: Content

    var body: some View {
        content
            .frame(width: size, height: size)
            .background(Theme.tile, in: .rect(cornerRadius: Theme.Radius.tile, style: .continuous))
    }
}

/// Rows sharing one raised card, as a grouped list draws them.
struct RowGroup<Content: View>: View {
    var fill = Theme.raised
    var radius = Theme.Radius.lg
    @ViewBuilder let content: Content

    var body: some View {
        VStack(spacing: 0) { content }
            .background(fill, in: .rect(cornerRadius: radius, style: .continuous))
    }
}

struct RowDivider: View {
    var inset: CGFloat = Theme.Space.l

    var body: some View {
        Rectangle().fill(Theme.hairline).frame(height: 1).padding(.leading, inset)
    }
}

/// One 52pt row: an icon, a label, its value on the same line and size, and
/// where it goes.
struct SettingsRow: View {
    let label: String
    var icon: String?
    var value: String?
    var trailing: String?

    init(_ label: String, icon: String? = nil, value: String? = nil, trailing: String? = "chevron.right") {
        self.label = label
        self.icon = icon
        self.value = value
        self.trailing = trailing
    }

    var body: some View {
        HStack(spacing: Theme.Space.m) {
            if let icon {
                Image(systemName: icon).font(Theme.Font.body.font).foregroundStyle(Theme.secondary).frame(width: 20)
            }
            Text(label).foregroundStyle(Theme.text).frame(maxWidth: .infinity, alignment: .leading)
            if let value { Text(value).foregroundStyle(Theme.secondary).lineLimit(1) }
            if let trailing {
                Image(systemName: trailing).font(Theme.Font.footnoteStrong.font).foregroundStyle(Theme.tertiary).frame(width: 16)
            }
        }
        .font(Theme.Font.body)
        .padding(.leading, Theme.Space.l)
        .padding(.trailing, 14)
        .frame(minHeight: 52)
        .contentShape(.rect)
    }
}

/// A server's dot: green working, yellow needs the reader, dim on its way, grey when switched off.
struct StatusDot: View {
    @Environment(Store.self) private var store
    let server: UUID
    var size: CGFloat = 8

    var body: some View {
        Circle().fill(tone).frame(width: size, height: size)
    }

    private var tone: Color {
        if store.servers.first(where: { $0.id == server })?.on == false { return Theme.tertiary }
        return switch store.serverState[server] {
        case .connected?: store.loadErrors[server] == nil ? Theme.add : Theme.accent
        case .failed(let p)? where !p.retries: Theme.accent
        default: Theme.dim
        }
    }
}

private struct ServerCard: View {
    @Environment(Store.self) private var store
    let server: Server

    var body: some View {
        let connected = store.serverState[server.id] == .connected
        let update = connected && Releases.shared.newer(store.connection(server.id)?.welcome) != nil
        HStack(spacing: Theme.Space.m) {
            Tile { ServerGlyph().fill(connected ? Theme.text : Theme.secondary, style: FillStyle(eoFill: true)).frame(width: 20, height: 20) }
            VStack(alignment: .leading, spacing: 2) {
                Text(server.name).font(Theme.Font.body).foregroundStyle(Theme.text).lineLimit(1)
                HStack(spacing: 6) {
                    StatusDot(server: server.id, size: 7)
                    (Text("\(store.stateLabel(server.id)) · ").foregroundStyle(Theme.secondary)
                        + Text(update ? "Update available" : place)
                        .foregroundStyle(update ? Theme.accent : Theme.tertiary))
                        .font(Theme.Font.footnote)
                        .lineLimit(1)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            Chevron(open: false)
        }
        .padding(.vertical, Theme.Space.m)
        .padding(.horizontal, 14)
        .background(Theme.raised, in: .rect(cornerRadius: Theme.Radius.group, style: .continuous))
        .contentShape(.rect)
    }

    /// Its host, or the paired server a relayed one is reached through.
    private var place: String {
        if let via = server.via { return "via \(store.name(of: via.parent))" }
        return socketURL(server.url)?.host() ?? server.url
    }
}

private struct AddServerCard: View {
    /// No server yet: the card says what a server is.
    let first: Bool

    var body: some View {
        HStack(spacing: Theme.Space.m) {
            Tile { Image(systemName: "plus").font(Theme.Font.headline.font).foregroundStyle(Theme.text) }
            VStack(alignment: .leading, spacing: 2) {
                Text("Add server").font(Theme.Font.body).foregroundStyle(Theme.text)
                if first {
                    Text("Pair with a machine running Dray.").font(Theme.Font.footnote).foregroundStyle(Theme.secondary)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            Chevron(open: false)
        }
        .padding(.vertical, Theme.Space.m)
        .padding(.horizontal, 14)
        .background(Theme.raised, in: .rect(cornerRadius: Theme.Radius.group, style: .continuous))
        .contentShape(.rect)
    }
}

/// A labelled field, 52pt: the label in a 72pt lane, the value beside it at
/// the same size. A long value shows its middle elided until edited.
private struct FieldRow: View {
    let label: String
    @Binding var text: String
    let prompt: String
    @FocusState private var focused: Bool

    var body: some View {
        let elide = !focused && !text.isEmpty
        HStack(spacing: Theme.Space.m) {
            Text(label).foregroundStyle(Theme.secondary).frame(width: 72, alignment: .leading)
            ZStack(alignment: .leading) {
                // Not a SecureField: iOS would offer to save a pasted server token as a password.
                TextField(label, text: $text, prompt: Text(prompt).foregroundStyle(Theme.tertiary))
                    .focused($focused)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .opacity(elide ? 0 : 1)
                    .accessibilityLabel(label)
                if elide {
                    Text(text).lineLimit(1).truncationMode(.middle).allowsHitTesting(false).accessibilityHidden(true)
                }
            }
            .foregroundStyle(Theme.text)
        }
        .font(Theme.Font.body)
        .padding(.horizontal, Theme.Space.l)
        .frame(minHeight: 52)
        .contentShape(.rect)
        .onTapGesture { focused = true }
    }
}

// MARK: A server

/// One server: its state and the cure, its name, address and token, and removing it.
struct ServerDetail: View {
    @Environment(Store.self) private var store
    @Environment(\.dismiss) private var dismiss
    let id: UUID
    @State private var name = ""
    @State private var token = ""
    @State private var removing = false
    @State private var copied = false
    @State private var scanning = false
    @State private var updating = false
    /// Why the last Update failed, said in the card: the app's toast sits behind this sheet.
    @State private var updateError: String?

    private var server: Server? { store.servers.first { $0.id == id } }

    var body: some View {
        ScrollView {
            if let server {
                VStack(spacing: Theme.Space.xl) {
                    if let via = server.via {
                        VStack(alignment: .leading, spacing: Theme.Space.s) {
                            stateRow(server)
                            Text("Reached through \(store.name(of: via.parent)), which shares it. It goes when \(store.name(of: via.parent)) stops sharing.")
                                .font(Theme.Font.footnote).foregroundStyle(Theme.tertiary)
                                .fixedSize(horizontal: false, vertical: true)
                                .padding(.horizontal, Theme.Space.xs)
                        }
                        statusCard
                    } else {
                        VStack(alignment: .leading, spacing: Theme.Space.s) {
                            onRow(server)
                            Text(server.on ? "Off stops this phone connecting and hides its tasks. Nothing stops on the server."
                                           : "Its tasks are hidden until you turn it back on. They keep running on \(server.name).")
                                .font(Theme.Font.footnote).foregroundStyle(Theme.tertiary)
                                .fixedSize(horizontal: false, vertical: true)
                                .padding(.horizontal, Theme.Space.xs)
                        }
                        statusCard
                        VStack(alignment: .leading, spacing: Theme.Space.s) {
                            RowGroup(fill: Theme.card, radius: Theme.Radius.group) {
                                FieldRow(label: "Name", text: $name, prompt: server.name)
                                    .submitLabel(.done)
                                    .onSubmit(rename)
                                RowDivider()
                                address(server.url)
                                RowDivider()
                                FieldRow(label: "Token", text: $token, prompt: "Paste a new token")
                                    .onChange(of: token) { _, _ in
                                        guard let fresh = newToken else { return }
                                        store.updateToken(id, fresh)
                                        token = ""
                                        Haptic.success()
                                    }
                            }
                            Text("A whole connect line works too.")
                                .font(Theme.Font.footnote).foregroundStyle(Theme.tertiary)
                                .padding(.horizontal, Theme.Space.xs)
                        }
                        Button { removing = true } label: {
                            Text("Remove server").font(Theme.Font.body).foregroundStyle(Theme.destructive)
                                .padding(.horizontal, Theme.Space.l)
                                .frame(maxWidth: .infinity, minHeight: 52, alignment: .leading)
                                .background(Theme.card, in: .rect(cornerRadius: Theme.Radius.group, style: .continuous))
                        }
                        .buttonStyle(RowButtonStyle())
                    }
                }
                .padding(.horizontal, Theme.Space.l)
                .padding(.top, Theme.Space.m)
            }
        }
        .background(Theme.page.ignoresSafeArea())
        .scrollDismissesKeyboard(.interactively)
        .navigationTitle(server?.name ?? "Server")
        .navigationBarTitleDisplayMode(.inline)
        .onAppear { name = server?.name ?? "" }
        .onDisappear(perform: rename)
        .sheet(isPresented: $scanning) {
            PairScanner { link in
                store.updateToken(id, link.token)
                scanning = false
                Haptic.success()
            }
        }
        .confirmationDialog("Remove \(server?.name ?? "this server")?", isPresented: $removing, titleVisibility: .visible) {
            Button("Remove", role: .destructive) {
                if let server { store.removeServer(server) }
                dismiss()
            }
        } message: {
            Text("Its sessions keep running there. This phone stops showing them.")
        }
    }

    private var welcome: Welcome? { store.connection(id)?.welcome }
    private var connected: Bool { store.serverState[id] == .connected }

    /// The phone's switch for this server, carrying its live state beside it.
    private func onRow(_ server: Server) -> some View {
        Toggle(isOn: Binding(get: { server.on }, set: { Haptic.select(); store.setServerOn(id, $0) })) {
            state(server)
        }
        .toggleStyle(SwitchStyle())
        .font(Theme.Font.body)
        .padding(.leading, Theme.Space.l)
        .padding(.trailing, 14)
        .frame(height: 52)
        .background(Theme.card, in: .rect(cornerRadius: Theme.Radius.group, style: .continuous))
        .accessibilityIdentifier("server.on")
    }

    /// A relayed server's row: its state alone, since it follows the server it
    /// goes through and has no switch of its own.
    private func stateRow(_ server: Server) -> some View {
        state(server)
            .font(Theme.Font.body)
            .padding(.horizontal, Theme.Space.l)
            .frame(maxWidth: .infinity, minHeight: 52, alignment: .leading)
            .background(Theme.card, in: .rect(cornerRadius: Theme.Radius.group, style: .continuous))
    }

    private func state(_ server: Server) -> some View {
        HStack(spacing: Theme.Space.s) {
            StatusDot(server: id)
            Text(store.stateLabel(id)).foregroundStyle(Theme.text)
            if server.on, connected, let w = welcome {
                Text(w.macApp ? "Dray \(w.version ?? "")" : "dray \(w.release ?? w.version ?? "")")
                    .foregroundStyle(Theme.tertiary).lineLimit(1)
            }
        }
    }

    /// What is wrong and its cure, else an update and its button; nothing when neither.
    @ViewBuilder private var statusCard: some View {
        if let health = store.health(id) {
            card(title: health.title, needsYou: health.needsYou) {
                if let detail = health.detail { Text(detail) }
                if let until = health.until { Countdown(until: until) }
            } button: {
                switch health.action {
                case .fix? where store.serverState[id] == .failed(.auth):
                    Button("Scan QR code") { scanning = true }
                case .retry?:
                    Button("Retry") { Haptic.tap(); Task { await store.retry(id) } }
                default: EmptyView()
                }
            }
        } else if connected, let w = welcome, let newer = Releases.shared.newer(w) {
            card(title: "Update available", needsYou: true) {
                if w.macApp {
                    Text("\(newer) is out. Update Dray on that Mac.")
                } else {
                    Text(updating ? "Updating. It restarts once no turn is running." : "\(newer) is out. It restarts once no turn is running.")
                    if let updateError { Text(sentence(updateError)).foregroundStyle(Theme.destructive) }
                }
            } button: {
                if !w.macApp { Button("Update", action: update).disabled(updating) }
            }
        }
    }

    private func card<Detail: View, Action: View>(title: String, needsYou: Bool, @ViewBuilder detail: () -> Detail,
                                                  @ViewBuilder button: () -> Action) -> some View {
        VStack(alignment: .leading, spacing: Theme.Space.m) {
            VStack(alignment: .leading, spacing: 3) {
                Text(title).font(Theme.Font.subhead).foregroundStyle(needsYou ? Theme.accent : Theme.text)
                Group { detail() }
                    .font(Theme.Font.footnote)
                    .foregroundStyle(Theme.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            button().buttonStyle(CapsuleButtonStyle())
        }
        .padding(Theme.Space.l)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.card, in: .rect(cornerRadius: Theme.Radius.group, style: .continuous))
    }

    private func address(_ url: String) -> some View {
        Button {
            UIPasteboard.general.string = url
            Haptic.tap()
            copied = true
        } label: {
            HStack(spacing: Theme.Space.m) {
                Text("Address").foregroundStyle(Theme.secondary).frame(width: 72, alignment: .leading)
                Text(url).foregroundStyle(Theme.text).lineLimit(1).truncationMode(.middle)
                    .frame(maxWidth: .infinity, alignment: .leading)
                Image(systemName: copied ? "checkmark" : "doc.on.doc").foregroundStyle(Theme.tertiary).frame(width: 18)
            }
            .font(Theme.Font.body)
            .padding(.horizontal, Theme.Space.l)
            .frame(minHeight: 52)
            .contentShape(.rect)
        }
        .buttonStyle(RowButtonStyle())
        .accessibilityLabel("Copy address")
        .accessibilityValue(url)
    }

    /// `update_server` on the server's own channel; it answers once the new
    /// binary is in, and restarts onto it when idle.
    private func update() {
        updating = true
        updateError = nil
        let beta = welcome?.release?.contains("-") == true
        Task {
            do {
                let said: String = try await store.call(id, "update_server", ["channel": .string(beta ? "beta" : "stable")],
                                                        timeout: .seconds(320))
                if said == "current" { updating = false }
            } catch {
                updating = false
                updateError = error.localizedDescription
            }
        }
    }

    /// A bare token, or the token out of a pasted connect line.
    private var newToken: String? {
        let t = token.trimmingCharacters(in: .whitespacesAndNewlines)
        if t.count == 64, t.allSatisfy(\.isHexDigit) { return t }
        return parseConnectLine(t)?.token
    }

    private func rename() {
        let trimmed = name.trimmingCharacters(in: .whitespaces)
        if !trimmed.isEmpty, trimmed != server?.name { store.renameServer(id, to: trimmed) }
    }
}

/// The newest stable releases on GitHub, read as the desktop's `servers.rs`
/// reads them: `cli-v` tags for a `dray-serve`, `v` tags for Dray on a Mac.
@MainActor @Observable
final class Releases {
    static let shared = Releases()
    private(set) var cli: String?
    private(set) var app: String?
    @ObservationIgnored private var read: Date?

    /// At most hourly: unauthenticated, GitHub allows 60 reads an hour per address.
    func refresh() async {
        if let read, read.timeIntervalSinceNow > -3600 { return }
        struct Release: Decodable { let tag_name: String }
        let url = URL(string: "https://api.github.com/repos/monorepo-labs/dray/releases?per_page=100")!
        guard let (data, _) = try? await URLSession.shared.data(from: url),
              let list = try? JSONDecoder().decode([Release].self, from: data) else { return }
        read = .now
        func newest(_ prefix: String) -> String? {
            list.map(\.tag_name).filter { $0.hasPrefix(prefix) && !$0.contains("-", after: prefix) }
                .map { String($0.dropFirst(prefix.count)) }
                .max { $0.compare($1, options: .numeric) == .orderedAscending }
        }
        cli = newest("cli-v")
        app = newest("v")
    }

    /// The release a server is behind, or nil: a local or dev build is never offered one.
    func newer(_ w: Welcome?) -> String? {
        guard let w else { return nil }
        let (running, newest) = w.macApp ? (w.version, app) : (w.release, cli)
        guard let running, let newest, Self.behind(running, newest) else { return nil }
        return newest
    }

    /// Whether `running` is older than the stable `newest`. A beta sorts below its own release.
    nonisolated static func behind(_ running: String, _ newest: String) -> Bool {
        let base = running.split(separator: "-").first.map(String.init) ?? running
        switch newest.compare(base, options: .numeric) {
        case .orderedDescending: return true
        case .orderedSame: return base != running
        default: return false
        }
    }
}

private extension String {
    /// Whether `char` appears past a prefix: a prerelease's `-`, not `cli-v`'s.
    func contains(_ char: Character, after prefix: String) -> Bool { dropFirst(prefix.count).contains(char) }
}

// MARK: Adding one

/// Adds a server by its QR code, or by address and token typed or pasted.
struct AddServerView: View {
    @Environment(Store.self) private var store
    @Environment(\.dismiss) private var dismiss
    var link: PairLink?
    var scanFirst = false
    @State private var address = ""
    @State private var token = ""
    @State private var name = ""
    @State private var scanning = false
    /// Filled from a connect line or a link, which the footer says.
    @State private var filled = false

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: Theme.Space.xl) {
                    Button { scanning = true } label: {
                        HStack(spacing: 14) {
                            Tile(size: 44) {
                                Image(systemName: "qrcode.viewfinder").font(Theme.Font.title.font).foregroundStyle(Theme.text)
                            }
                            VStack(alignment: .leading, spacing: 2) {
                                Text("Scan QR code").font(Theme.Font.headline).foregroundStyle(Theme.text)
                                Text("From dray server pair or Remote access.")
                                    .font(Theme.Font.footnote).foregroundStyle(Theme.secondary)
                                    .multilineTextAlignment(.leading)
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)
                            Chevron(open: false)
                        }
                        .padding(14)
                        .background(Theme.raised, in: .rect(cornerRadius: Theme.Radius.group, style: .continuous))
                        .contentShape(.rect)
                    }
                    .buttonStyle(RowButtonStyle())
                    .accessibilityLabel("Scan QR code")

                    VStack(alignment: .leading, spacing: Theme.Space.s) {
                        GroupLabel("Or paste it")
                        RowGroup(radius: Theme.Radius.group) {
                            FieldRow(label: "Address", text: $address, prompt: "wss:// or ws://host:port")
                                .onChange(of: address) { _, text in
                                    // A pasted connect line carries both halves.
                                    if let line = parseConnectLine(text), line.url != text {
                                        address = line.url
                                        token = line.token
                                        filled = true
                                    }
                                }
                            RowDivider(inset: 0)
                            FieldRow(label: "Token", text: $token, prompt: "64 characters")
                            RowDivider(inset: 0)
                            FieldRow(label: "Name", text: $name, prompt: "Optional")
                        }
                        Text(filled ? "Filled from the pasted connect line." : "A whole connect line fills both at once.")
                            .font(Theme.Font.footnote).foregroundStyle(Theme.tertiary)
                            .padding(.horizontal, Theme.Space.xs)
                    }
                }
                .padding(.horizontal, 20)
                .padding(.top, 14)
            }
            .background(Theme.card.ignoresSafeArea())
            .scrollDismissesKeyboard(.interactively)
            .navigationTitle("Add server")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Add") {
                        guard let parsed else { return }
                        let trimmed = name.trimmingCharacters(in: .whitespaces)
                        store.addServer(name: trimmed.isEmpty ? (host ?? "Server") : trimmed, url: parsed.url, token: parsed.token)
                        Haptic.success()
                        dismiss()
                    }
                    .fontWeight(.semibold)
                    .disabled(parsed == nil)
                }
            }
            .sheet(isPresented: $scanning) {
                PairScanner { fill($0); scanning = false }
            }
            .onAppear {
                link.map(fill)
                if scanFirst { scanning = true }
            }
        }
    }

    private func fill(_ link: PairLink) {
        address = link.url
        token = link.token
        name = link.name ?? ""
        filled = true
    }

    private var parsed: (url: String, token: String)? {
        parseConnectLine("\(address) \(token.trimmingCharacters(in: .whitespacesAndNewlines))")
    }
    private var host: String? { parsed.flatMap { socketURL($0.url)?.host } }
}

// MARK: Dictation

/// Which server turns the phone's voice into text, the record tones, and the
/// microphone's permission.
struct DictationSettings: View {
    @Environment(Store.self) private var store
    @AppStorage(Dictations.serverKey) private var pick = ""
    @AppStorage(Dictations.soundsKey) private var sounds = true
    @Environment(\.scenePhase) private var phase
    @State private var mic = AVAudioApplication.shared.recordPermission

    var body: some View {
        ScrollView {
            VStack(spacing: 28) {
                if !store.servers.isEmpty {
                    VStack(alignment: .leading, spacing: Theme.Space.s) {
                        GroupLabel("Transcribe on").padding(.horizontal, Theme.Space.m)
                        RowGroup {
                            ForEach(Array(store.servers.enumerated()), id: \.element.id) { i, s in
                                if i > 0 { RowDivider(inset: 48) }
                                serverRow(s)
                            }
                        }
                        GroupLabel("Your voice is turned into text on this server.").padding(.horizontal, Theme.Space.m)
                    }
                }
                RowGroup {
                    Toggle("Start and stop sounds", isOn: $sounds)
                        .toggleStyle(SwitchStyle())
                        .font(Theme.Font.body)
                        .padding(.leading, Theme.Space.l).padding(.trailing, 14)
                        .frame(minHeight: 52)
                    RowDivider()
                    Button { UIApplication.shared.open(URL(string: UIApplication.openSettingsURLString)!) } label: {
                        SettingsRow("Microphone", value: micLabel, trailing: "arrow.up.right")
                    }
                    .buttonStyle(RowButtonStyle())
                }
            }
            .padding(.horizontal, Theme.Space.l)
            .padding(.top, Theme.Space.m)
        }
        .background(Theme.card.ignoresSafeArea())
        .foregroundStyle(Theme.text)
        .navigationTitle("Dictation")
        .navigationBarTitleDisplayMode(.inline)
        // Back from the system's Settings, where it may have changed.
        .onChange(of: phase) { _, now in if now == .active { mic = AVAudioApplication.shared.recordPermission } }
    }

    private func serverRow(_ s: Server) -> some View {
        let able = store.canDictate(s.id)
        let chosen = store.dictationServer(pick) == s.id
        return Button { pick = s.id.uuidString } label: {
            HStack(spacing: Theme.Space.m) {
                ServerGlyph().fill(Theme.secondary, style: FillStyle(eoFill: true))
                    .frame(width: 20, height: 20).opacity(able ? 1 : 0.45)
                Text(s.name).foregroundStyle(able ? Theme.text : Theme.tertiary).lineLimit(1)
                    .frame(maxWidth: .infinity, alignment: .leading)
                if !able {
                    Text("Unavailable").foregroundStyle(Theme.tertiary)
                } else if chosen {
                    Image(systemName: "checkmark").font(Theme.Font.headline.font).foregroundStyle(Theme.text)
                }
            }
            .font(Theme.Font.body)
            .padding(.leading, Theme.Space.l).padding(.trailing, 14)
            .frame(minHeight: 52)
            .contentShape(.rect)
        }
        .buttonStyle(RowButtonStyle())
        .disabled(!able)
        .accessibilityAddTraits(chosen ? .isSelected : [])
    }

    private var micLabel: String {
        switch mic {
        case .granted: "Allowed"
        case .denied: "Not allowed"
        default: "Not asked yet"
        }
    }
}

// MARK: Notifications

/// What the phone should tell the reader about. Only the picks exist so far:
/// nothing sends a notification yet, and the screen says so.
struct NotificationSettings: View {
    static let allowKey = "notify.allow"
    @AppStorage(allowKey) private var allow = true
    @AppStorage("notify.needsMe") private var needsMe = true
    @AppStorage("notify.done") private var done = true
    @AppStorage("notify.prReady") private var prReady = false
    @AppStorage("notify.autoStop") private var autoStop = true

    var body: some View {
        ScrollView {
            VStack(spacing: 28) {
                RowGroup { toggle("Allow notifications", $allow) }
                VStack(alignment: .leading, spacing: Theme.Space.s) {
                    GroupLabel("Tell me when").padding(.horizontal, Theme.Space.m)
                    RowGroup {
                        toggle("A task needs me", $needsMe)
                        RowDivider()
                        toggle("A task is done", $done)
                        RowDivider()
                        toggle("A PR is ready to merge", $prReady)
                        RowDivider()
                        toggle("A server is about to auto-stop", $autoStop)
                    }
                    .disabled(!allow)
                    .opacity(allow ? 1 : 0.45)
                    GroupLabel("Never while you're looking at that task.").padding(.horizontal, Theme.Space.m)
                }
                // ponytail: picks only; delivery lands with push from the server.
                GroupLabel("Dray doesn't send these yet. Your picks are kept for when it does.")
                    .padding(.horizontal, Theme.Space.m)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(.horizontal, Theme.Space.l)
            .padding(.top, Theme.Space.m)
        }
        .background(Theme.card.ignoresSafeArea())
        .foregroundStyle(Theme.text)
        .navigationTitle("Notifications")
        .navigationBarTitleDisplayMode(.inline)
    }

    private func toggle(_ label: String, _ on: Binding<Bool>) -> some View {
        Toggle(label, isOn: on)
            .toggleStyle(SwitchStyle())
            .font(Theme.Font.body)
            .padding(.leading, Theme.Space.l).padding(.trailing, 14)
            .frame(minHeight: 52)
    }
}

// MARK: Appearance

/// How the home list looks. Hiding sessions leaves it to bots alone.
struct AppearanceSettings: View {
    static let hideSessionsKey = "list.hideSessions"
    @AppStorage(hideSessionsKey) private var hideSessions = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Theme.Space.s) {
                RowGroup {
                    Toggle("Hide sessions", isOn: $hideSessions)
                        .toggleStyle(SwitchStyle())
                        .font(Theme.Font.body)
                        .padding(.leading, Theme.Space.l).padding(.trailing, 14)
                        .frame(minHeight: 52)
                }
                GroupLabel("Home shows your bots only: no sessions, project filter, orb, drafts or settled.")
                    .padding(.horizontal, Theme.Space.m)
            }
            .padding(.horizontal, Theme.Space.l)
            .padding(.top, Theme.Space.m)
        }
        .background(Theme.card.ignoresSafeArea())
        .foregroundStyle(Theme.text)
        .navigationTitle("Appearance")
        .navigationBarTitleDisplayMode(.inline)
    }
}
