import SwiftUI

/// The island itself, every state it can be in, each on its own seeded Store
/// and Composer with no server behind them: the pills, the cards, the session
/// view and the list. The switch moves every case between the notch and the
/// Dock; Replay builds them again, since a done pill's clock runs here too.
@main
struct StatusDemo: App {
    var body: some Scene {
        WindowGroup("Island states") {
            DemoPage().frame(minWidth: 700, minHeight: 760)
        }
    }
}

private struct DemoPage: View {
    @State private var placement = Placement.notch
    @State private var replays = 0
    /// One group of cases at a time; the last tab is the list's marks.
    @State private var tab = sections[0].0
    private static let taskList = "Task list"

    var body: some View {
        VStack(spacing: 0) {
            VStack(alignment: .leading, spacing: 12) {
                Picker("", selection: $tab) {
                    ForEach(sections.map(\.0) + [Self.taskList], id: \.self) { Text($0).tag($0) }
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                .fixedSize()
                HStack(spacing: 12) {
                    Picker("", selection: $placement) {
                        Text("Notch").tag(Placement.notch)
                        Text("Bottom").tag(Placement.bottom)
                    }
                    .pickerStyle(.segmented)
                    .labelsHidden()
                    .fixedSize()
                    Button("Replay") { replays += 1 }
                    Text("Done pills fade after \(Int(Composer.doneFor.components.seconds))s; hover holds them.")
                        .foregroundStyle(.secondary)
                }
            }
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
            .fixedSize(horizontal: false, vertical: true)
            Divider()
            ScrollView {
                // Wrapping, so a wide window shows several cases side by side.
                LazyVGrid(columns: [GridItem(.adaptive(minimum: Composer.width + 48), spacing: 28, alignment: .topLeading)],
                          alignment: .leading, spacing: 28) {
                    if tab == Self.taskList {
                        ListMock()
                    } else {
                        ForEach(sections.first { $0.0 == tab }?.1 ?? []) { c in
                            VStack(alignment: .leading, spacing: 8) {
                                Text(c.name).font(.headline)
                                Text(c.note ?? " ").foregroundStyle(.secondary).lineLimit(2, reservesSpace: true)
                                CaseStage(c, placement: placement)
                            }
                        }
                    }
                }
                .padding(28)
                .frame(maxWidth: .infinity, alignment: .leading)
                // Rebuilt whole, so every composer starts again on the pick.
                .id("\(tab)-\(placement.rawValue)-\(replays)")
            }
        }
        .background(Color(white: 0.16))
        .environment(\.colorScheme, .dark)
    }
}

// MARK: Cases

private struct Case: Identifiable {
    let id = UUID()
    let name: String
    var note: String? = nil
    var open = false
    var listShown = false
    var items: [SessionItem]
    var asks: [AgentEvent] = []
    var done: [String] = []
    var prs: [String: [String: PrMark]] = [:]
    /// The session the panel is pinned to, when open on no card.
    var pinned: String? = nil
}

private let sections: [(String, [Case])] = [
    ("Alerts", [
        Case(name: "One card waiting", items: [s1], asks: [bash(s1)]),
        Case(name: "Three cards waiting", items: [s1, s2, s3], asks: [bash(s1), question(s2), edit(s3)]),
        Case(name: "One session done", items: [s4], done: [s4.sessionId]),
        Case(name: "One session done, long title", items: [long], done: [long.sessionId]),
        Case(name: "Two sessions done at once", items: [s4, s5], done: [s4.sessionId, s5.sessionId]),
        Case(name: "Five sessions done at once", items: [s1, s2, s3, s4, s5], done: [s1, s2, s3, s4, s5].map(\.sessionId)),
        Case(name: "A card waiting and a session done", note: "The card outranks the news; the done pill shows once it is answered.",
             items: [s1, s4], asks: [bash(s1)], done: [s4.sessionId]),
    ]),
    ("Permissions", [
        Case(name: "Run a command", open: true, items: [s1], asks: [bash(s1)]),
        Case(name: "Edit a file", open: true, items: [s3], asks: [edit(s3)]),
        Case(name: "Long command, many options", note: "The options scroll past 420pt rather than pushing the card off screen.",
             open: true, items: [s1], asks: [longBash(s1)]),
    ]),
    ("Questions", [
        Case(name: "One question, one answer", open: true, items: [s2], asks: [question(s2)]),
        Case(name: "Pick several", open: true, items: [s2], asks: [multiSelect(s2)]),
        Case(name: "Three questions", note: "One at a time, 1 of 3; Return moves on.", open: true, items: [s2], asks: [threeQuestions(s2)]),
        Case(name: "No free text", note: "pi's select: an offered option or nothing.", open: true, items: [s2], asks: [noFreeText(s2)]),
    ]),
    ("Several waiting", [
        Case(name: "Two sessions, as tabs", open: true, items: [s1, s2], asks: [bash(s1), question(s2)]),
        Case(name: "Five sessions, as tabs", open: true, items: [s1, s2, s3, s4, long],
             asks: [bash(s1), question(s2), edit(s3), bash(s4), multiSelect(long)]),
    ]),
    ("Session view", [
        Case(name: "Idle", open: true, items: [s5], pinned: s5.sessionId),
        Case(name: "Working", open: true, items: [working], pinned: working.sessionId),
        Case(name: "Open PR", open: true, items: [withPr], prs: pr("OPEN", "CLEAR"), pinned: withPr.sessionId),
        Case(name: "Checks running", open: true, items: [withPr], prs: pr("OPEN", "RUNNING"), pinned: withPr.sessionId),
        Case(name: "Working on a PR", note: "Working outranks the PR glyph.", open: true, items: [workingPr], prs: pr("OPEN", "CLEAR"), pinned: workingPr.sessionId),
        Case(name: "Task list open", open: true, listShown: true, items: [s1, working, s4, s5, withPr], prs: pr("OPEN", "FAILING"), pinned: working.sessionId),
    ]),
]

// MARK: Seeds

private func session(_ id: String, _ title: String, status: String = "idle", branch: String? = nil) -> SessionItem {
    var o: [String: Any] = [
        "sessionId": id, "harness": "claude_code", "cwd": "/Users/me/dray", "projectPath": "/Users/me/dray",
        "title": title, "model": "opus", "effort": "high", "permissionMode": "auto", "status": status,
        "modified": stamp(),
    ]
    if let branch { o["branch"] = branch }
    return decode(o)
}

private let s1 = session("s1", "Fix the login redirect loop")
private let s2 = session("s2", "Pick the draft base")
private let s3 = session("s3", "Theme swatches in settings")
private let s4 = session("s4", "Orb lab", status: "completed")
private let s5 = session("s5", "Paste images into the composer")
private let long = session("s6", "Island status stuck on completed after reading it in the app", status: "completed")
private let working = session("s7", "Faster dictation: trim silence before transcribing", status: "in_progress")
private let withPr = session("s8", "Sidebar globe icon for Mac remote", branch: "worktree-globe")
private let workingPr = session("s9", "Integrate Devin CLI harness", status: "in_progress", branch: "worktree-globe")

private func pr(_ state: String, _ checks: String) -> [String: [String: PrMark]] {
    ["/Users/me/dray": ["worktree-globe": PrMark(number: 573, headRefName: "worktree-globe", isDraft: false, state: state, checksState: checks)]]
}

private func ask(_ s: SessionItem, _ payload: [String: Any]) -> AgentEvent {
    decode(["id": UUID().uuidString, "sessionId": s.sessionId, "payload": payload])
}

private func options(_ labels: [(String, String)]) -> [[String: Any]] {
    // The first allow is once, every other a standing rule, as the harnesses build them.
    labels.enumerated().map { i, o in
        ["id": "o\(i)", "label": o.0, "behavior": o.1, "kind": o.1 == "deny" ? "deny" : i == 0 ? "once" : "always_rule"]
    }
}

private func bash(_ s: SessionItem) -> AgentEvent {
    ask(s, ["type": "permission_requested", "requestId": "r-\(s.sessionId)", "toolName": "Bash", "title": "Run a command",
            "description": "Run the desktop tests", "input": ["command": "pnpm test --filter desktop"],
            "options": options([("Allow once", "allow"), ("Always allow pnpm test", "allow"), ("Deny", "deny")])])
}

private func edit(_ s: SessionItem) -> AgentEvent {
    ask(s, ["type": "permission_requested", "requestId": "e-\(s.sessionId)", "toolName": "Edit", "title": "Edit a file",
            "input": ["file_path": "/Users/me/dray/apps/desktop/src/components/ThemeSwatches.tsx"],
            "options": options([("Allow", "allow"), ("Allow edits this session", "allow"), ("Deny", "deny")])])
}

private func longBash(_ s: SessionItem) -> AgentEvent {
    ask(s, ["type": "permission_requested", "requestId": "l-\(s.sessionId)", "toolName": "Bash", "title": "Run a command",
            "description": "Rebuild the island, swap it for the running one and relaunch it against the release server",
            "input": ["command": "sh apps/island/build.sh /tmp/out && pkill -x 'Dray Island'; sleep 1; open -g '/tmp/out/Dray Island.app' && pgrep -lf 'Dray Island' | head -2 && echo relaunched"],
            "options": options([("Allow once", "allow"), ("Always allow sh", "allow"), ("Always allow pkill", "allow"),
                                ("Always allow open", "allow"), ("Allow everything in this session", "allow"),
                                ("Always allow in this project", "allow"), ("Deny", "deny"), ("Deny and stop", "deny")])])
}

private func q(_ text: String, multi: Bool = false, free: Bool = true, _ opts: [(String, String?)]) -> [String: Any] {
    ["question": text, "multiSelect": multi, "freeText": free,
     "options": opts.map { o -> [String: Any] in o.1.map { ["label": o.0, "description": $0] } ?? ["label": o.0] }]
}

private func question(_ s: SessionItem) -> AgentEvent {
    ask(s, ["type": "questions_asked", "requestId": "q-\(s.sessionId)", "questions": [
        q("Where should a draft made from a session start its worktree?", [
            ("From the session's branch", "The new task sees the session's work."),
            ("From origin/main", "Same as a draft made on the new-task page."),
        ]),
    ]])
}

private func multiSelect(_ s: SessionItem) -> AgentEvent {
    ask(s, ["type": "questions_asked", "requestId": "m-\(s.sessionId)", "questions": [
        q("Which chords should the island take?", multi: true, [
            ("⌘⇧A next agent", nil), ("⇧Tab next model", nil), ("⌘⇧E next effort", nil), ("⌘⇧P next project", nil), ("⌘⇧T worktree", nil),
        ]),
    ]])
}

private func threeQuestions(_ s: SessionItem) -> AgentEvent {
    ask(s, ["type": "questions_asked", "requestId": "t-\(s.sessionId)", "questions": [
        q("Replace Dray's banner or show beside it?", [("Replace", nil), ("Both", nil)]),
        q("What shape?", [("Pill, fades", "Hover holds it."), ("Pill until clicked", nil), ("Open the panel", nil)]),
        q("Show it when the session is on screen?", [("No", nil), ("Always", nil)]),
    ]])
}

private func noFreeText(_ s: SessionItem) -> AgentEvent {
    ask(s, ["type": "questions_asked", "requestId": "n-\(s.sessionId)", "questions": [
        q("Delete the worktree too?", free: false, [("Yes", nil), ("No", nil)]),
    ]])
}

private func decode<T: Decodable>(_ object: [String: Any]) -> T {
    try! JSONDecoder().decode(T.self, from: JSONSerialization.data(withJSONObject: object))
}

/// Now, so the list's three-day cut keeps every seeded session.
private func stamp() -> String {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return f.string(from: Date())
}

// MARK: Stage

/// One case on the real island, over a strip of menu bar with the notch or a
/// strip of Dock, at the panel's own size.
private struct CaseStage: View {
    let placement: Placement
    @State private var composer: Composer

    init(_ c: Case, placement: Placement) {
        self.placement = placement
        let store = Store()
        let server = UUID()
        store.seed(server, items: c.items, asks: c.asks, prs: c.prs)
        let composer = Composer(store: store, server: server)
        composer.placement = placement
        composer.notchHeight = placement == .notch ? 32 : 0
        composer.shown = c.open
        composer.keyed = true
        if let id = c.pinned { composer.target = .session(SessionKey(server: server, id: id)) }
        composer.listShown = c.listShown
        composer.done = c.done.map { SessionKey(server: server, id: $0) }
        _composer = State(initialValue: composer)
    }

    var body: some View {
        ZStack(alignment: placement == .notch ? .top : .bottom) {
            if placement == .notch {
                ZStack {
                    Color(white: 0.28)
                    UnevenRoundedRectangle(bottomLeadingRadius: 10, bottomTrailingRadius: 10)
                        .fill(.black).frame(width: 190)
                }
                .frame(height: 32)
            } else {
                // The Dock's top edge, just under the 12pt the island keeps clear.
                UnevenRoundedRectangle(topLeadingRadius: 8, topTrailingRadius: 8).fill(Color(white: 0.32))
                    .frame(width: 420, height: 8)
            }
            // At the panel's own size, as the window lays it out, then cropped
            // to the edge it hangs from: a hidden card still takes its height.
            IslandView(composer: composer)
                .environment(composer.store)
                .frame(width: Composer.width + 48, height: 680)
            // The app draws these in a window of their own, laid over the panel's.
            PillsView(composer: composer)
                .environment(composer.store)
                .frame(width: Composer.width + 48, height: 680)
        }
        .frame(width: Composer.width + 48, height: composer.shown ? 680 : 150,
               alignment: placement == .notch ? .top : .bottom)
        .background(Color(white: 0.22), in: RoundedRectangle(cornerRadius: 12))
        .clipShape(RoundedRectangle(cornerRadius: 12))
        // Each case is news arriving; a page of them chiming at once would say nothing.
        .onAppear { composer.announce(sound: false) }
    }
}

// MARK: Task list marks

private enum MockTurn { case idle, working, asking, done }

private enum Pull {
    case none, open, checks, failing, draft, merged

    var mark: PrMark? {
        switch self {
        case .none: nil
        case .open: PrMark(number: 573, headRefName: "b", isDraft: false, state: "OPEN", checksState: "CLEAR")
        case .checks: PrMark(number: 573, headRefName: "b", isDraft: false, state: "OPEN", checksState: "RUNNING")
        case .failing: PrMark(number: 573, headRefName: "b", isDraft: false, state: "OPEN", checksState: "FAILING")
        case .draft: PrMark(number: 573, headRefName: "b", isDraft: true, state: "OPEN", checksState: "CLEAR")
        case .merged: PrMark(number: 573, headRefName: "b", isDraft: false, state: "MERGED", checksState: "CLEAR")
        }
    }
}

private func marks(_ turn: MockTurn, _ pull: Pull) -> Marks {
    Marks(asking: turn == .asking, unread: turn == .done, busy: turn == .working || turn == .asking, pr: pull.mark)
}

/// One row per state, so the marks can be read against each other.
private struct ListMock: View {
    private let rows: [(String, String, Marks)] = [
        ("Fix the login redirect", "dray", marks(.asking, .none)),
        ("Island status in the task list", "dray", marks(.working, .checks)),
        ("Paste images into the composer", "dray", marks(.done, .open)),
        ("Theme swatches in settings", "dray", marks(.idle, .failing)),
        ("Orb lab", "dray", marks(.working, .none)),
        ("Docs for remote access", "web", marks(.idle, .draft)),
        ("Changelog for 0.12", "web", marks(.done, .merged)),
        ("Spike: CEF memory", "dray", marks(.idle, .none)),
    ]

    var body: some View {
        VStack(spacing: 2) {
            ForEach(Array(rows.enumerated()), id: \.offset) { i, row in
                SessionRow(title: row.0, project: row.1, marks: row.2, selected: i == 1)
            }
        }
        .padding(6)
        .frame(width: 520)
        .background(.black, in: RoundedRectangle(cornerRadius: 16))
    }
}
