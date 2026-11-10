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
                // Text no screen styles still sits on the scale.
                .font(Theme.Font.body)
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

