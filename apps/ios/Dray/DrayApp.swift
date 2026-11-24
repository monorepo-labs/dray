import SwiftUI
import ThinkingOrbs

@main
struct DrayApp: App {
    @UIApplicationDelegateAdaptor private var delegate: AppDelegate
    @State private var store: Store
    @State private var task: NewTask

    init() {
        let store = Store()
        _store = State(initialValue: store)
        _task = State(initialValue: NewTask(store: store))
        // Before launch ends, so a tapped or answered alert that launched the app reaches it.
        Push.shared.start(store)
    }
    @Environment(\.scenePhase) private var phase

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(store)
                .environment(task)
                .preferredColorScheme(.dark)
                // Text no screen styles still sits on the scale.
                .font(Theme.Font.body)
                // Neutral, so yellow stays the one colour that means "this is for you".
                .tint(Theme.text)
                // Before the docks decide between the orb and keyboard mode.
                .task { await AppleSpeech.shared.refresh() }
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

    var id: String {
        switch self {
        case .settings(let s): "settings\(s?.uuidString ?? "")"
        case .add(let link, let scan): "add\(link?.id ?? "")\(scan)"
        }
    }
}

struct RootView: View {
    @Environment(Store.self) private var store
    @Environment(\.scenePhase) private var phase
    /// Read outside the split view: a column inside one reports compact even beside the detail.
    @Environment(\.horizontalSizeClass) private var width
    @Environment(NewTask.self) private var task
    @State private var selection: SessionKey?
    @State private var columns = NavigationSplitViewVisibility.automatic
    /// The main pane as wide as the window: a sidebar up now is laid over it rather than beside it.
    @State private var paneWidth: CGFloat = 0
    @State private var windowWidth: CGFloat = 0
    @State private var sheet: RootSheet?
    @State private var autoOpen = true
    /// Tasks opened over a bot's chat, so Back walks back to the bot.
    @State private var opened: [SessionKey] = []

    var body: some View {
        NavigationSplitView(columnVisibility: $columns) {
            SessionList(selection: $selection, sheet: $sheet, autoOpen: $autoOpen, sidebar: width == .regular) {
                // A phone's dock is under its list, already on screen.
                guard width == .regular else { return }
                selection = nil
                // As a row tap does: a sidebar over the page gets out of its way, one beside it stays.
                if paneWidth >= windowWidth - 1 { columns = .detailOnly }
            }
        } detail: {
            Group {
                if let selection {
                    NavigationStack(path: $opened) {
                        TranscriptView(key: selection)
                            .id(selection)
                            .navigationDestination(for: SessionKey.self) { TranscriptView(key: $0).id($0) }
                    }
                    .environment(\.openTask) { opened.append($0) }
                    .environment(\.openSession) { self.selection = $0 }
                } else if width == .regular && !store.live.isEmpty {
                    // The new task page: the phone's dock under its list, with the main pane to itself.
                    Color.clear
                        .overlay(alignment: .bottom) {
                            VoiceDock(task: task, started: { selection = $0 }, engaged: { autoOpen = false })
                                .opacity(store.live.contains { store.serverState[$0.id] == .connected } ? 1 : 0.3)
                        }
                        .page()
                        .navigationTitle(task.bot?.bot.name ?? "New task")
                        .navigationBarTitleDisplayMode(.inline)
                        // A row picked mid-recording takes the dock and its Done away: stopped and kept,
                        // as leaving `BotStartView` does, its words here next visit.
                        .onDisappear {
                            if Dictations.shared.state(.newSession) == .recording {
                                Task { await Dictations.shared.stop(store, draft: .newSession) }
                            }
                        }
                } else {
                    EmptyState(title: "No session open", message: "Pick one from the list.") {
                        Orb(state: .idle, size: 40)
                    }
                    .page()
                }
            }
            .onGeometryChange(for: CGFloat.self, of: { $0.size.width }) { paneWidth = $0 }
        }
        .onGeometryChange(for: CGFloat.self, of: { $0.size.width }) { windowWidth = $0 }
        .sheet(item: $sheet) { s in
            switch s {
            case .settings(let server): SettingsView(focus: server)
            // Filled in, not added: a link from anywhere should not add a server unasked.
            case .add(let link, let scan): AddServerView(link: link, scanFirst: scan)
            }
        }
        .onChange(of: selection) { opened = [] }
        .onChange(of: opened.last ?? selection, initial: true) { _, now in Push.shared.viewing = now }
        .onChange(of: Push.shared.opening, initial: true) { _, key in
            guard let key else { return }
            Push.shared.opening = nil
            sheet = nil
            // Set even when `selection` already is `key`, where its own change never fires.
            opened = []
            selection = key
        }
        .onOpenURL { url in
            #if DEBUG
            if url.host == "debug-push", let file = URLComponents(url: url, resolvingAgainstBaseURL: false)?
                .queryItems?.first(where: { $0.name == "file" })?.value {
                Task { await Push.shared.showDressed(file) }
                return
            }
            #endif
            if let link = PairLink(url.absoluteString) { sheet = .add(link, scan: false) }
        }
        .overlay(alignment: .top) { ErrorToast() }
        // Keyboard mode's field: dragging the list or a chat down takes the keyboard with it.
        .scrollDismissesKeyboard(.interactively)
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

