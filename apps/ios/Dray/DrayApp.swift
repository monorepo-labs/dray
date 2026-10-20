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
    @Environment(\.scenePhase) private var phase
    @State private var pairing: PairLink?
    @State private var opening: Task<Void, Never>?

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
        // Filled in, not added: a link from anywhere should not add a server unasked.
        .sheet(item: $pairing) { AddServerView(link: $0) }
        .onOpenURL { url in
            guard let link = PairLink(url.absoluteString) else { return }
            let covered = showServers || adding || pairing != nil
            showServers = false
            adding = false
            pairing = nil
            // A sheet asked for while another is still leaving is dropped. A newer
            // link cancels this one's wait, so the older can't land on top.
            opening?.cancel()
            opening = Task {
                if covered { try? await Task.sleep(for: .milliseconds(600)) }
                if !Task.isCancelled { pairing = link }
            }
        }
        .alert("Something went wrong", isPresented: Binding(
            get: { store.lastError != nil },
            set: { if !$0 { store.lastError = nil } }
        )) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(store.lastError ?? "")
        }
        // The desktop's 30s open-PR poll, and none while the app is away.
        .task(id: phase) {
            guard phase == .active else { return }
            while !Task.isCancelled {
                await store.pollMarks()
                try? await Task.sleep(for: .seconds(30))
            }
        }
    }
}

struct SessionList: View {
    @Environment(Store.self) private var store
    @Binding var selection: SessionKey?
    @State private var project: ProjectKey?

    var body: some View {
        let chips = store.servers.flatMap { s in (store.projects[s.id] ?? []).map { (key: ProjectKey(server: s.id, path: $0.path), name: $0.name) } }
        // A picked project that left the list narrows nothing.
        let filter = chips.contains { $0.key == project } ? project : nil
        List(selection: $selection) {
            // A row of the list rather than an inset over it, so the large title still collapses into the bar.
            if chips.count > 1 {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) {
                        Chip(title: "All", on: filter == nil) { project = nil }
                        ForEach(chips, id: \.key) { chip in
                            Chip(title: chip.name, on: filter == chip.key) { project = chip.key }
                        }
                    }
                    .padding(.horizontal)
                }
                .listRowInsets(EdgeInsets())
                .listRowBackground(Color.clear)
            }
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
            // One section per run: the gap between them is the whole signal, never a heading.
            ForEach(store.runs(filter), id: \.stage) { run in
                Section {
                    ForEach(run.rows) { row in
                        SessionRow(key: row.key, item: row.item, showServer: store.servers.count > 1)
                            .padding(.leading, CGFloat(row.depth) * 16)
                            .tag(row.key)
                    }
                }
            }
        }
        .listSectionSpacing(.compact)
        .refreshable { await store.refresh() }
    }
}

struct Chip: View {
    let title: String
    let on: Bool
    let action: () -> Void

    var body: some View {
        Button(title, action: action)
            .font(.subheadline)
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            .foregroundStyle(on ? Color(.systemBackground) : .primary)
            .background(on ? Color.primary : Color(.secondarySystemFill), in: Capsule())
            .buttonStyle(.plain)
            .accessibilityAddTraits(on ? .isSelected : [])
    }
}

struct SessionRow: View {
    @Environment(Store.self) private var store
    let key: SessionKey
    let item: SessionItem
    let showServer: Bool

    var body: some View {
        let pr = store.prMark(key, item)
        HStack(spacing: 10) {
            mark.frame(width: 8)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    if let pr { PrGlyph(mark: pr) }
                    Text(item.title.isEmpty ? "Untitled" : item.title)
                        .lineLimit(1)
                }
                Text(subtitle)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer(minLength: 0)
            slot(pr)
        }
    }

    /// Yellow waits on the reader, green is finished and unread — the desktop rail's two marks.
    @ViewBuilder private var mark: some View {
        if store.isAsking(key) {
            Circle().fill(.yellow).frame(width: 8, height: 8)
        } else if item.status == "completed" {
            Circle().fill(.green).frame(width: 8, height: 8)
        } else {
            Color.clear.frame(width: 8, height: 8)
        }
    }

    /// The timestamp's slot, and what outranks it there: running checks, then
    /// the orb — "last activity" is the least useful thing to say of a row
    /// with anything in flight.
    @ViewBuilder private func slot(_ pr: PrMark?) -> some View {
        if pr?.state == "OPEN" && pr?.checksState == "RUNNING" {
            ChecksSpinner()
        } else if item.busy {
            Orb()
        } else if let date = parseDate(item.modified) {
            Text(date.formatted(.relative(presentation: .numeric, unitsStyle: .abbreviated)))
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }

    private var subtitle: String {
        showServer ? "\(item.project) · \(store.name(of: key.server))" : item.project
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
    var link: PairLink?
    @State private var address = ""
    @State private var token = ""
    @State private var name = ""
    @State private var scanning = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Button("Scan QR code", systemImage: "qrcode.viewfinder") { scanning = true }
                }
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
                    Text("On a Mac, turn on Remote access in Dray's Settings, Servers, This Mac, then scan its QR code or copy the address and token. On a server, `dray server pair` shows the code.")
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
            .sheet(isPresented: $scanning) {
                PairScanner { fill($0); scanning = false }
            }
            .onAppear { link.map(fill) }
        }
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
