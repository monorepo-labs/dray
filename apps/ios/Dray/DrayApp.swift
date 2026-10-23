import SwiftUI
import ThinkingOrbs

@main
struct DrayApp: App {
    @State private var store = Store()
    @Environment(\.scenePhase) private var phase

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(store)
                .preferredColorScheme(.dark)
                // Neutral, so yellow stays the one colour that means "this is for you".
                .tint(Theme.text)
        }
        .onChange(of: phase) { _, now in
            if now == .active { store.resume() }
        }
    }
}

/// The one sheet the root can show. A single slot, so a pairing link can
/// replace whatever is up rather than stacking on it.
enum RootSheet: Identifiable {
    /// Settings, opened on one server's page where a banner's Fix asked for it.
    case settings(server: UUID?)
    case add(PairLink?, scan: Bool)
    case new

    var id: String {
        switch self {
        case .settings(let s): "settings\(s?.uuidString ?? "")"
        case .add(let link, let scan): "add\(link?.id ?? "")\(scan)"
        case .new: "new"
        }
    }
}

struct RootView: View {
    @Environment(Store.self) private var store
    @Environment(\.scenePhase) private var phase
    @State private var selection: SessionKey?
    @State private var sheet: RootSheet?

    var body: some View {
        NavigationSplitView {
            SessionList(selection: $selection, sheet: $sheet)
        } detail: {
            if let selection {
                TranscriptView(key: selection)
                    .id(selection)
            } else {
                EmptyState(title: "No session open", message: "Pick one from the list.") {
                    Orb(state: .idle, size: 40)
                }
                .page()
            }
        }
        .sheet(item: $sheet) { s in
            switch s {
            case .settings(let server): SettingsView(focus: server)
            // Filled in, not added: a link from anywhere should not add a server unasked.
            case .add(let link, let scan): AddServerView(link: link, scanFirst: scan)
            case .new: NewSessionView { selection = $0 }
            }
        }
        .onOpenURL { url in
            if let link = PairLink(url.absoluteString) { sheet = .add(link, scan: false) }
        }
        .overlay(alignment: .top) { ErrorToast() }
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
    @Binding var sheet: RootSheet?
    @State private var project: ProjectKey?

    var body: some View {
        let projects = store.servers.flatMap { s in
            (store.projects[s.id] ?? []).map { (key: ProjectKey(server: s.id, path: $0.path), name: $0.name) }
        }
        // A picked project that left the list narrows nothing.
        let filter = projects.contains { $0.key == project } ? project : nil
        let runs = store.runs(filter)
        let problems = store.servers.compactMap { s in store.health(s.id).map { (server: s, health: $0) } }
        List(selection: $selection) {
            if !store.online { OfflineBanner().plainRow() }
            ForEach(problems, id: \.server.id) { p in
                ServerBanner(name: p.server.name, health: p.health,
                             retry: { Task { await store.retry(p.server.id) } },
                             fix: { sheet = .settings(server: p.server.id) })
                    .plainRow()
            }
            if runs.isEmpty {
                empty.plainRow().frame(minHeight: 460)
            }
            // One block per run: the gap between them is the whole signal, never a heading.
            ForEach(Array(runs.enumerated()), id: \.element.stage) { i, run in
                if i > 0 { Color.clear.frame(height: Theme.Space.m).plainRow() }
                ForEach(run.rows) { row in
                    SessionRow(key: row.key, item: row.item, depth: row.depth, showServer: store.servers.count > 1)
                        .tag(row.key)
                        .listRowInsets(EdgeInsets(top: 0, leading: Theme.Space.l, bottom: 0, trailing: Theme.Space.l))
                        .listRowSeparator(.hidden)
                        .listRowBackground(
                            RoundedRectangle(cornerRadius: Theme.Radius.md, style: .continuous)
                                .fill(selection == row.key ? Theme.selected : .clear)
                                .padding(.horizontal, Theme.Space.s))
                }
            }
        }
        .listStyle(.plain)
        // The spacers between runs are 12pt, under the 44pt a list row otherwise takes.
        .environment(\.defaultMinListRowHeight, 1)
        .themedList()
        .animation(Theme.motion, value: runs.map { $0.rows.map(\.id) })
        .refreshable { await store.refresh() }
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                Button("Settings", systemImage: "gearshape") { sheet = .settings(server: nil) }
            }
            // The list's only title is what narrows it, and only once there is a choice.
            ToolbarItem(placement: .principal) {
                if projects.count > 1 {
                    ProjectMenu(projects: projects, picked: filter) { project = $0 }
                }
            }
            ToolbarItem(placement: .topBarTrailing) {
                Button("New session", systemImage: "square.and.pencil") { sheet = .new }
                    .disabled(store.servers.isEmpty)
            }
        }
    }

    /// What the list says with no rows: no server yet, one coming up, or nothing started.
    @ViewBuilder private var empty: some View {
        if store.servers.isEmpty {
            EmptyState(title: "Connect a server",
                       message: "Pair this phone with Dray on your Mac, or with a server running dray-serve, to see and steer its sessions.") {
                Orb(state: .idle, size: 56)
            } actions: {
                Button { sheet = .add(nil, scan: true) } label: {
                    Label("Scan QR code", systemImage: "qrcode.viewfinder").frame(maxWidth: .infinity)
                }
                .buttonStyle(PrimaryButtonStyle())
                Button { sheet = .add(nil, scan: false) } label: {
                    Text("Add server").frame(maxWidth: .infinity)
                }
                .buttonStyle(SecondaryButtonStyle())
            }
        } else if store.servers.allSatisfy({ if case .connecting(0)? = store.serverState[$0.id] { true } else { false } }) {
            EmptyState(title: "Connecting", message: store.servers.map(\.name).joined(separator: ", ")) {
                Orb(.reconnecting, size: 40)
            }
        } else if store.servers.contains(where: { store.serverState[$0.id] == .connected }) {
            EmptyState(title: "No sessions yet", message: "Start one here, or on your Mac, and it shows up in this list.") {
                Orb(state: .idle, size: 40)
            } actions: {
                Button { sheet = .new } label: { Text("New session").frame(maxWidth: .infinity) }
                    .buttonStyle(PrimaryButtonStyle())
            }
        } else {
            EmptyState(title: "Nothing to show yet", message: "Sessions show up here once a server connects.") {
                Orb(state: .idle, size: 40)
            }
        }
    }
}

extension View {
    /// A list row that is not a session: no inset, no separator, no fill.
    func plainRow() -> some View {
        listRowInsets(EdgeInsets(top: 0, leading: Theme.Space.l, bottom: 0, trailing: Theme.Space.l))
            .listRowSeparator(.hidden)
            .listRowBackground(Color.clear)
            .selectionDisabled()
    }
}

/// The list's title: which project it is narrowed to, and the menu that narrows it.
struct ProjectMenu: View {
    let projects: [(key: ProjectKey, name: String)]
    let picked: ProjectKey?
    let pick: (ProjectKey?) -> Void

    var body: some View {
        Menu {
            Picker("Project", selection: Binding(get: { picked }, set: { Haptic.select(); pick($0) })) {
                Text("All projects").tag(ProjectKey?.none)
                ForEach(projects, id: \.key) { Text($0.name).tag(Optional($0.key)) }
            }
        } label: {
            HStack(spacing: Theme.Space.xs) {
                Text(projects.first { $0.key == picked }?.name ?? "All projects")
                    .font(.headline)
                    .foregroundStyle(Theme.text)
                Image(systemName: "chevron.down")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(Theme.tertiary)
            }
        }
        .accessibilityLabel("Project filter")
    }
}

struct SessionRow: View {
    @Environment(Store.self) private var store
    let key: SessionKey
    let item: SessionItem
    let depth: Int
    let showServer: Bool

    var body: some View {
        let pr = store.prMark(key, item)
        let unread = item.status == "completed"
        HStack(spacing: Theme.Space.m) {
            rail
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    if let pr { PrGlyph(mark: pr) }
                    Text(item.title.isEmpty ? "Untitled" : item.title)
                        .font(unread ? .body.weight(.semibold) : Theme.Font.row)
                        .foregroundStyle(Theme.text)
                        .lineLimit(1)
                }
                Text(subtitle)
                    .font(Theme.Font.meta)
                    .foregroundStyle(Theme.secondary)
                    .lineLimit(1)
            }
            Spacer(minLength: Theme.Space.s)
            slot(pr)
        }
        .padding(.vertical, 11)
        .padding(.leading, CGFloat(depth) * 18)
    }

    /// The desktop rail's two marks: yellow waits on the reader, green is
    /// finished and unread. Holds its width bare, so titles line up.
    private var rail: some View {
        let tone: Color? = store.isAsking(key) ? Theme.accent : item.status == "completed" ? Theme.add : nil
        return Capsule()
            .fill(tone ?? .clear)
            .frame(width: 3, height: 22)
    }

    /// The timestamp's slot, and what outranks it there: running checks, then
    /// the orb — "last activity" is the least useful thing to say of a row
    /// with anything in flight.
    @ViewBuilder private func slot(_ pr: PrMark?) -> some View {
        if pr?.state == "OPEN" && pr?.checksState == "RUNNING" {
            ChecksSpinner()
        } else if item.busy {
            Orb(.working, label: "Working")
        } else if let date = parseDate(item.modified) {
            Text(date.formatted(.relative(presentation: .numeric, unitsStyle: .abbreviated)))
                .font(Theme.Font.meta.monospacedDigit())
                .foregroundStyle(Theme.tertiary)
        }
    }

    private var subtitle: String {
        showServer ? "\(item.project) · \(store.name(of: key.server))" : item.project
    }
}
