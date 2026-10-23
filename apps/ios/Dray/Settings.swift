import SwiftUI
import ThinkingOrbs
import UIKit

/// The one Settings screen: every saved server — add, pair, rename, remove,
/// fix — and about. Opened on one server's page when a banner's Fix asks.
struct SettingsView: View {
    @Environment(Store.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var path: [UUID]
    /// Add server's sheet, opening on the scanner where true.
    @State private var adding: Bool?

    init(focus: UUID?) { _path = State(initialValue: focus.map { [$0] } ?? []) }

    var body: some View {
        NavigationStack(path: $path) {
            List {
                Section {
                    ForEach(store.servers) { s in
                        NavigationLink(value: s.id) { ServerSummary(server: s) }
                    }
                    Button { adding = true } label: {
                        Label("Scan QR code", systemImage: "qrcode.viewfinder")
                    }
                    Button { adding = false } label: {
                        Label("Add server", systemImage: "plus")
                    }
                } header: {
                    GroupLabel("Servers")
                } footer: {
                    Text("On a Mac, turn on Remote access in Dray's settings and scan its code. On a server, run dray server pair.")
                        .font(Theme.Font.meta).foregroundStyle(Theme.tertiary)
                }
                .listRowBackground(Theme.card)

                Section {
                    LabeledContent("Version", value: version)
                    Link(destination: URL(string: "https://drayhq.com")!) {
                        LabeledContent("Website") { Image(systemName: "arrow.up.right").foregroundStyle(Theme.tertiary) }
                    }
                    Link(destination: URL(string: "https://drayhq.com/docs")!) {
                        LabeledContent("Docs") { Image(systemName: "arrow.up.right").foregroundStyle(Theme.tertiary) }
                    }
                } header: {
                    GroupLabel("About")
                }
                .listRowBackground(Theme.card)
            }
            .themedList()
            .foregroundStyle(Theme.text)
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { Button("Done") { dismiss() }.fontWeight(.semibold) }
            .navigationDestination(for: UUID.self) { ServerDetail(id: $0) }
            .sheet(isPresented: Binding(get: { adding != nil }, set: { if !$0 { adding = nil } })) {
                AddServerView(link: nil, scanFirst: adding == true)
            }
        }
    }

    private var version: String {
        let info = Bundle.main.infoDictionary
        return "\(info?["CFBundleShortVersionString"] as? String ?? "?") (\(info?["CFBundleVersion"] as? String ?? "?"))"
    }
}

/// A server's dot, colour by what it asks of the reader: green working, yellow
/// needs them, grey on its way.
struct StatusDot: View {
    @Environment(Store.self) private var store
    let server: UUID

    var body: some View {
        let tone: Color = switch store.serverState[server] {
        case .connected?: store.loadErrors[server] == nil ? Theme.add : Theme.accent
        case .failed(let p)? where !p.retries: Theme.accent
        default: Theme.tertiary
        }
        Circle().fill(tone).frame(width: 8, height: 8)
    }
}

private struct ServerSummary: View {
    @Environment(Store.self) private var store
    let server: Server

    var body: some View {
        HStack(spacing: Theme.Space.m) {
            StatusDot(server: server.id)
            VStack(alignment: .leading, spacing: 2) {
                Text(server.name).font(Theme.Font.row)
                HStack(spacing: Theme.Space.xs) {
                    Text(store.stateLabel(server.id))
                    if let host = socketURL(server.url)?.host() { Text("· \(host)").lineLimit(1) }
                }
                .font(Theme.Font.meta)
                .foregroundStyle(Theme.secondary)
            }
        }
        .padding(.vertical, 2)
    }
}

/// One server: its state and the cure, its name, its address, a new token,
/// and removing it.
struct ServerDetail: View {
    @Environment(Store.self) private var store
    @Environment(\.dismiss) private var dismiss
    let id: UUID
    @State private var name = ""
    @State private var token = ""
    @State private var removing = false
    @State private var copied = false

    private var server: Server? { store.servers.first { $0.id == id } }

    var body: some View {
        List {
            if let server {
              Group {
                Section {
                    HStack(spacing: Theme.Space.m) {
                        StatusDot(server: id)
                        Text(store.stateLabel(id)).font(Theme.Font.row)
                        Spacer()
                        if store.serverState[id] != .connected {
                            Button("Retry") { Haptic.tap(); Task { await store.retry(id) } }
                                .fontWeight(.semibold)
                                .buttonStyle(.borderless)
                        }
                    }
                    if let health = store.health(id) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(health.title)
                            if let detail = health.detail { Text(detail).foregroundStyle(Theme.secondary) }
                            if let until = health.until { Countdown(until: until).foregroundStyle(Theme.secondary) }
                        }
                        .font(Theme.Font.meta)
                    }
                } header: { GroupLabel("Status") }

                Section {
                    TextField("Name", text: $name)
                        .accessibilityLabel("Name")
                        .submitLabel(.done)
                        .onSubmit(rename)
                } header: { GroupLabel("Name") }

                Section {
                    Button {
                        UIPasteboard.general.string = server.url
                        Haptic.tap()
                        copied = true
                    } label: {
                        HStack {
                            Text(server.url).font(Theme.Font.mono).foregroundStyle(Theme.text).lineLimit(1).truncationMode(.middle)
                            Spacer()
                            Image(systemName: copied ? "checkmark" : "doc.on.doc").foregroundStyle(Theme.tertiary)
                        }
                    }
                } header: { GroupLabel("Address") }

                Section {
                    TextField("Paste a new token", text: $token)
                        .font(Theme.Font.mono)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    Button("Use this token") {
                        store.updateToken(id, newToken!)
                        token = ""
                        Haptic.success()
                    }
                    .disabled(newToken == nil)
                } header: {
                    GroupLabel("Token")
                } footer: {
                    Text("The token is the long code after the address in a connect line. Pasting the whole line works too.")
                        .font(Theme.Font.meta).foregroundStyle(Theme.tertiary)
                }

                Section {
                    Button("Remove server", role: .destructive) { removing = true }
                        .foregroundStyle(Theme.destructive)
                }
              }
              .listRowBackground(Theme.card)
            }
        }
        .themedList()
        .navigationTitle(server?.name ?? "Server")
        .navigationBarTitleDisplayMode(.inline)
        .onAppear { name = server?.name ?? "" }
        .onDisappear(perform: rename)
        .confirmationDialog("Remove \(server?.name ?? "this server")?", isPresented: $removing, titleVisibility: .visible) {
            Button("Remove", role: .destructive) {
                if let server { store.removeServer(server) }
                dismiss()
            }
        } message: {
            Text("Its sessions keep running there. This phone stops showing them until it's paired again.")
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

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: Theme.Space.xl) {
                    Button { scanning = true } label: {
                        HStack(spacing: Theme.Space.m) {
                            Image(systemName: "qrcode.viewfinder")
                                .font(.title2)
                                .foregroundStyle(Theme.accent)
                                .frame(width: 40, height: 40)
                                .background(Theme.raised, in: .rect(cornerRadius: Theme.Radius.md, style: .continuous))
                            VStack(alignment: .leading, spacing: 2) {
                                Text("Scan QR code").font(Theme.Font.headline).foregroundStyle(Theme.text)
                                Text("From Remote access in Dray's settings, or dray server pair.")
                                    .font(Theme.Font.meta).foregroundStyle(Theme.secondary)
                                    .multilineTextAlignment(.leading)
                            }
                            Spacer(minLength: 0)
                            Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(Theme.tertiary)
                        }
                        .card()
                    }
                    .buttonStyle(RowButtonStyle())
                    .accessibilityLabel("Scan QR code")
                    .accessibilityHint("From Remote access in Dray's settings, or dray server pair.")

                    VStack(alignment: .leading, spacing: Theme.Space.s) {
                        GroupLabel("Or enter it")
                        VStack(spacing: 0) {
                            field("Address", text: $address, prompt: "wss://…", mono: true)
                                .onChange(of: address) { _, text in
                                    // A pasted connect line carries both halves.
                                    if let line = parseConnectLine(text) {
                                        address = line.url
                                        token = line.token
                                    }
                                }
                            Divider().overlay(Theme.hairline)
                            // Not a SecureField: iOS would offer to save a pasted server token as a password.
                            field("Token", text: $token, prompt: "64 characters", mono: true)
                            Divider().overlay(Theme.hairline)
                            field("Name", text: $name, prompt: host ?? "Studio Mac", mono: false)
                        }
                        .background(Theme.card, in: .rect(cornerRadius: Theme.Radius.lg, style: .continuous))
                        .overlay(RoundedRectangle(cornerRadius: Theme.Radius.lg, style: .continuous).strokeBorder(Theme.hairline))
                        Text("Pasting a whole connect line fills the address and the token at once.")
                            .font(Theme.Font.meta).foregroundStyle(Theme.tertiary)
                            .padding(.horizontal, Theme.Space.xs)
                    }
                }
                .padding(Theme.Space.l)
            }
            .page()
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

    private func field(_ label: String, text: Binding<String>, prompt: String, mono: Bool) -> some View {
        HStack(spacing: Theme.Space.m) {
            Text(label)
                .font(Theme.Font.callout)
                .foregroundStyle(Theme.secondary)
                .frame(width: 64, alignment: .leading)
            TextField(label, text: text, prompt: Text(prompt).foregroundStyle(Theme.tertiary))
                .font(mono ? Theme.Font.mono : Theme.Font.body)
                .foregroundStyle(Theme.text)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .accessibilityLabel(label)
        }
        .padding(.horizontal, Theme.Space.l)
        .frame(minHeight: 50)
    }

    private func fill(_ link: PairLink) {
        address = link.url
        token = link.token
        name = link.name ?? ""
    }

    private var parsed: (url: String, token: String)? {
        parseConnectLine("\(address) \(token.trimmingCharacters(in: .whitespacesAndNewlines))")
    }
    private var host: String? { parsed.flatMap { socketURL($0.url)?.host } }
}
