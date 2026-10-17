import SwiftUI

@main
struct DrayApp: App {
    @State private var store = Store()
    @Environment(\.scenePhase) private var phase

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(store)
        }
        .onChange(of: phase) { _, now in
            if now == .active { store.resume() }
        }
    }
}

struct RootView: View {
    @Environment(Store.self) private var store
    @State private var selection: SessionKey?
    @State private var showServers = false
    @State private var adding = false

    var body: some View {
        NavigationSplitView {
            SessionList(selection: $selection)
                .navigationTitle("Dray")
                .toolbar {
                    Button("Servers", systemImage: "server.rack") { showServers = true }
                }
                .overlay {
                    if store.servers.isEmpty {
                        ContentUnavailableView {
                            Label("No servers", systemImage: "server.rack")
                        } description: {
                            Text("Add a Mac with Remote access on, or a server running dray-serve.")
                        } actions: {
                            Button("Add server") { adding = true }
                                .buttonStyle(.borderedProminent)
                        }
                    }
                }
        } detail: {
            if let selection {
                TranscriptView(key: selection)
                    .id(selection)
            } else {
                ContentUnavailableView("Pick a session", systemImage: "bubble.left.and.text.bubble.right")
            }
        }
        .sheet(isPresented: $showServers) { ServersView() }
        .sheet(isPresented: $adding) { AddServerView() }
        .alert("Something went wrong", isPresented: Binding(
            get: { store.lastError != nil },
            set: { if !$0 { store.lastError = nil } }
        )) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(store.lastError ?? "")
        }
    }
}

struct SessionList: View {
    @Environment(Store.self) private var store
    @Binding var selection: SessionKey?

    var body: some View {
        List(selection: $selection) {
            ForEach(store.servers) { s in
                if case .failed(let reason) = store.serverState[s.id] {
                    Label {
                        VStack(alignment: .leading) {
                            Text(s.name).font(.subheadline.weight(.medium))
                            Text(reason).font(.caption).foregroundStyle(.secondary)
                        }
                    } icon: {
                        Image(systemName: "exclamationmark.triangle").foregroundStyle(.orange)
                    }
                }
            }
            ForEach(store.sessions, id: \.key) { row in
                SessionRow(key: row.key, item: row.item, showServer: store.servers.count > 1)
                    .tag(row.key)
            }
        }
        .refreshable { await store.refresh() }
    }
}

struct SessionRow: View {
    @Environment(Store.self) private var store
    let key: SessionKey
    let item: SessionItem
    let showServer: Bool

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            mark.frame(width: 12)
            VStack(alignment: .leading, spacing: 2) {
                Text(item.title.isEmpty ? "Untitled" : item.title)
                    .lineLimit(1)
                Text(subtitle)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
        }
    }

    /// Yellow waits on the reader, green is finished and unread — the desktop rail's two marks.
    @ViewBuilder private var mark: some View {
        if store.isAsking(key) {
            Circle().fill(.yellow).frame(width: 8, height: 8)
        } else if item.busy {
            ProgressView().controlSize(.mini)
        } else if item.status == "completed" {
            Circle().fill(.green).frame(width: 8, height: 8)
        } else {
            Color.clear.frame(width: 8, height: 8)
        }
    }

    private var subtitle: String {
        var parts = [item.project]
        if showServer { parts.append(store.name(of: key.server)) }
        if let date = parseDate(item.modified) {
            parts.append(date.formatted(.relative(presentation: .numeric, unitsStyle: .abbreviated)))
        }
        return parts.joined(separator: " · ")
    }
}

func parseDate(_ s: String) -> Date? {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let d = f.date(from: s) { return d }
    f.formatOptions = [.withInternetDateTime]
    return f.date(from: s)
}

struct ServersView: View {
    @Environment(Store.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var adding = false

    var body: some View {
        NavigationStack {
            List {
                ForEach(store.servers) { s in
                    VStack(alignment: .leading, spacing: 2) {
                        Text(s.name)
                        Text(s.url).font(.caption.monospaced()).foregroundStyle(.secondary).lineLimit(1)
                        Text(state(s.id)).font(.caption).foregroundStyle(.secondary)
                    }
                    .swipeActions {
                        Button("Remove", role: .destructive) { store.removeServer(s) }
                    }
                }
                Button("Add server", systemImage: "plus") { adding = true }
            }
            .navigationTitle("Servers")
            .toolbar { Button("Done") { dismiss() } }
            .sheet(isPresented: $adding) { AddServerView() }
        }
    }

    private func state(_ id: UUID) -> String {
        switch store.serverState[id] {
        case .connected: "Connected"
        case .connecting, nil: "Connecting…"
        case .failed(let reason): reason
        }
    }
}

struct AddServerView: View {
    @Environment(Store.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var address = ""
    @State private var token = ""
    @State private var name = ""

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Group {
                        TextField("Address", text: $address, prompt: Text("wss://…"))
                            .accessibilityLabel("Address")
                            .onChange(of: address) { _, text in
                                // A pasted connect line carries both halves.
                                if let line = parseConnectLine(text) {
                                    address = line.url
                                    token = line.token
                                }
                            }
                        // Not a SecureField: iOS would offer to save a pasted server token as a password.
                        TextField("Token", text: $token)
                    }
                    .font(.body.monospaced())
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                } footer: {
                    Text("On a Mac, turn on Remote access in Dray's Settings, Servers, This Mac, and copy the address and token. On a server, `dray server tunnel on` prints both on one line.")
                }
                Section {
                    TextField("Name", text: $name, prompt: Text(host ?? "Name"))
                        .accessibilityLabel("Name")
                }
            }
            .navigationTitle("Add server")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Add") {
                        guard let parsed else { return }
                        let trimmed = name.trimmingCharacters(in: .whitespaces)
                        store.addServer(name: trimmed.isEmpty ? (host ?? "Server") : trimmed, url: parsed.url, token: parsed.token)
                        dismiss()
                    }
                    .disabled(parsed == nil)
                }
            }
        }
    }

    private var parsed: (url: String, token: String)? {
        parseConnectLine("\(address) \(token.trimmingCharacters(in: .whitespacesAndNewlines))")
    }
    private var host: String? { parsed.flatMap { socketURL($0.url)?.host } }
}
