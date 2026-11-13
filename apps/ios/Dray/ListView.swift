import SwiftUI
import ThinkingOrbs

/// Which sessions the list shows: the live ones, saved drafts, or settled ones.
enum ListMode { case live, drafts, settled }

/// A task saved for later, as `drafts.json` holds it. Only what a row draws.
struct DraftItem: Decodable, Identifiable {
    let id: String
    let prompt: String
    let projectPath: String?
    let created: String?
    let harness: String?
    let model: String?
    let effort: String?
    let permissionMode: String?
    let fast: Bool?
    let useWorktree: Bool?

    var title: String { prompt.split(whereSeparator: \.isNewline).first.map(String.init) ?? prompt }
    var project: String? { projectPath.map { ($0 as NSString).lastPathComponent } }
}

struct SessionList: View {
    @Environment(Store.self) private var store
    @Environment(NewTask.self) private var task
    @Binding var selection: SessionKey?
    @Binding var sheet: RootSheet?
    @State private var project: String?
    @State private var mode = ListMode.live
    @State private var drafts: [(server: UUID, draft: DraftItem)] = []
    @State private var shown = Self.pageSize

    private static let pageSize = 40

    /// The runs cut to their first `limit` rows, a nest never split across the cut.
    private func page(_ runs: [(stage: Stage, rows: [ListRow])], _ limit: Int) -> [(stage: Stage, rows: [ListRow])] {
        var left = limit
        var out: [(stage: Stage, rows: [ListRow])] = []
        for run in runs where left > 0 {
            var end = min(left, run.rows.count)
            while end < run.rows.count && run.rows[end].depth > 0 { end += 1 }
            out.append((run.stage, Array(run.rows[..<end])))
            left -= end
        }
        return out
    }

    var body: some View {
        // One entry per name: the same repo on two machines is one project here.
        var seen = Set<String>()
        let names = store.live.flatMap { store.projects[$0.id] ?? [] }.map(\.name).filter { seen.insert($0).inserted }
        // A picked project that left the list narrows nothing.
        let filter = names.contains { $0 == project } ? project : nil
        let all = mode == .drafts ? [] : store.runs(project: filter, settled: mode == .settled)
        // Paged: only the first `shown` rows are drawn, more as the last one comes on screen.
        let runs = page(all, shown)
        let more = runs.reduce(0) { $0 + $1.rows.count } < all.reduce(0) { $0 + $1.rows.count }
        // Bots lead the live list, as on the desktop: a bot belongs to no project, so no filter narrows them.
        let botRows = mode == .live ? store.allBots.map { b in
            (id: "\(b.server)/\(b.bot.id)", server: b.server, bot: b.bot, chat: store.botChat(b.server, b.bot).last)
        } : []
        let blank = mode == .live && runs.isEmpty && botRows.isEmpty
        VStack(spacing: 0) {
            if names.count > 1 {
                ProjectStrip(names: names, picked: filter) { project = $0 }
            }
            List(selection: $selection) {
                // Quiet about reconnects, never about a read that failed or a server waiting on the reader.
                ForEach(store.live.filter { s in store.health(s.id).map { store.serverState[s.id] == .connected || $0.needsYou } ?? false }) { s in
                    if let health = store.health(s.id) {
                        HealthBanner(health: health,
                                     retry: { Task { await store.retry(s.id) } },
                                     fix: { sheet = .settings(server: s.id) })
                            .bannerRow()
                    }
                }
                ForEach(botRows, id: \.id) { b in
                    if let chat = b.chat {
                        BotListRow(server: b.server, bot: b.bot, chat: chat)
                            .tag(chat)
                            .sessionRow(selected: selection == chat)
                    } else {
                        // No chat yet: the dock aims at its folder, and the first message starts one.
                        Button { task.aim(at: b.bot, on: b.server) } label: {
                            BotListRow(server: b.server, bot: b.bot, chat: nil)
                        }
                        .buttonStyle(RowButtonStyle())
                        .sessionRow(selected: task.bot?.bot.id == b.bot.id)
                    }
                }
                if !botRows.isEmpty && !runs.isEmpty { Color.clear.frame(height: Theme.Space.l).plainRow() }
                if mode == .drafts {
                    draftRows(filter)
                } else if runs.isEmpty && mode == .settled {
                    Text("Nothing settled.").font(Theme.Font.subhead).foregroundStyle(Theme.tertiary)
                        .padding(.leading, 14).frame(height: 44, alignment: .leading)
                        .plainRow()
                }
                // One block per run: the gap between them is the whole signal, never a heading.
                ForEach(Array(runs.enumerated()), id: \.element.stage) { i, run in
                    if i > 0 { Color.clear.frame(height: Theme.Space.l).plainRow() }
                    ForEach(Array(run.rows.enumerated()), id: \.element.id) { j, row in
                        // Set aside fades as the desktop sidebar's does, back to full once it is the open one.
                        SessionRow(key: row.key, item: row.item, lines: elbows(run.rows, j))
                            .opacity(run.stage == .aside && selection != row.key ? 0.3 : 1)
                            .tag(row.key)
                            .sessionRow(selected: selection == row.key)
                        if mode == .live, let ask = store.asks[row.key]?.first {
                            AskCard(key: row.key, event: ask)
                                .padding(EdgeInsets(top: 2, leading: 14, bottom: Theme.Space.m, trailing: Theme.Space.m))
                                .listRowInsets(EdgeInsets(top: 0, leading: 6, bottom: 0, trailing: 8))
                                .listRowSeparator(.hidden)
                                .listRowBackground(Color.clear)
                                .selectionDisabled()
                        }
                    }
                }
                if more {
                    // Comes on screen as the reader nears the end, and draws the next page.
                    Color.clear.frame(height: 1).plainRow()
                        .onAppear { shown += Self.pageSize }
                }
            }
            .listStyle(.plain)
            .contentMargins(.top, Theme.Space.m, for: .scrollContent)
            // The resting dock's height, so the last row scrolls clear of the orb.
            .contentMargins(.bottom, store.live.isEmpty ? 0 : 160, for: .scrollContent)
            // The breaks between runs are 16pt, under the 44pt a list row otherwise takes.
            .environment(\.defaultMinListRowHeight, 1)
            .themedList()
            .animation(Theme.motion, value: runs.map { $0.rows.map(\.id) })
            .refreshable {
                await store.refresh()
                // Both, whatever the view: a failed read hides a button, and this is the way to retry it.
                await loadDrafts()
                await store.loadSettled()
            }
            .overlay { if blank { empty(filter) } }
        }
        .overlay(alignment: .bottom) {
            if !store.live.isEmpty {
                // Dim while nothing is connected: the screen above says why.
                VoiceDock(task: task) { selection = $0 }.opacity(blank && !anyConnected ? 0.3 : 1)
            }
        }
        // A new view or filter starts on its first page.
        .onChange(of: "\(mode)\(filter ?? "")") { shown = Self.pageSize }
        .page()
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { header }
        // Again once a server comes up: a view opened before it connected read nothing from it.
        // Drafts and settled are read whatever the view: their buttons show only when there are some,
        // and an empty live list counts what was settled today.
        .task(id: "\(mode) \(store.live.filter { store.serverState[$0.id] == .connected }.count) \(store.draftsRevision)") {
            await loadDrafts()
            await store.loadSettled()
        }
    }

    /// Settings on the left; the drafts and settled views sharing one glass pill
    /// on the right. While one is shown, the other dims, so the lit one reads as on.
    @ToolbarContentBuilder private var header: some ToolbarContent {
        ToolbarItem(placement: .topBarLeading) {
            Button { sheet = .settings(server: nil) } label: { Image(systemName: "gearshape") }
                .accessibilityLabel("Settings")
        }
        // Each only where it has something to show, or is the view up now so there is a way back.
        ToolbarItemGroup(placement: .topBarTrailing) {
            if mode == .drafts || (anyConnected && !drafts.isEmpty) {
                viewToggle(.drafts, label: "Drafts") { Image(systemName: "circle.dashed") }
            }
            if mode == .settled || (anyConnected && store.items.values.contains { $0.archived == true && $0.hidden != true }) {
                viewToggle(.settled, label: "Settled") { CheckCheck().frame(width: 20, height: 20) }
            }
        }
    }

    private func viewToggle(_ target: ListMode, label: String, @ViewBuilder icon: () -> some View) -> some View {
        Button {
            Haptic.select()
            mode = mode == target ? .live : target
        } label: {
            icon().foregroundStyle(mode == .live || mode == target ? Theme.text : Theme.tertiary)
        }
        .accessibilityLabel(label)
        .accessibilityAddTraits(mode == target ? .isSelected : [])
    }

    @ViewBuilder private func draftRows(_ filter: String?) -> some View {
        let shown = drafts.filter { filter == nil || $0.draft.project == filter }
        if shown.isEmpty {
            Text("No drafts.").font(Theme.Font.subhead).foregroundStyle(Theme.tertiary)
                .padding(.leading, 14).frame(height: 44).plainRow()
        }
        ForEach(shown, id: \.draft.id) { entry in
            Button {
                task.open(entry.draft, on: entry.server)
                mode = .live
            } label: {
                RowLine(title: entry.draft.title, time: entry.draft.created.flatMap(parseDate))
            }
            .buttonStyle(RowButtonStyle())
            .sessionRow(selected: false)
        }
    }

    /// Every connected server's drafts, newest first. A server whose read fails keeps what it last
    /// said, so a dropped reply never reads as no drafts.
    private func loadDrafts() async {
        var all: [(server: UUID, draft: DraftItem)] = []
        for s in store.live where store.serverState[s.id] == .connected {
            if let list: [DraftItem] = try? await store.call(s.id, "list_drafts") {
                all += list.map { (s.id, $0) }
            } else {
                all += drafts.filter { $0.server == s.id }
            }
        }
        // A newer read replaced this task, and its reply may land before this one.
        if Task.isCancelled { return }
        drafts = all.sorted { ($0.draft.created ?? "") > ($1.draft.created ?? "") }
    }

    /// What the list says with no rows: no server yet, one coming up, or nothing started.
    private var anyConnected: Bool { store.live.contains { store.serverState[$0.id] == .connected } }

    /// The whole screen when the live list has nothing: pair, connecting, can't reach,
    /// or nothing to do yet — the last pointing at the orb, or at today's settled work.
    @ViewBuilder private func empty(_ filter: String?) -> some View {
        if store.live.isEmpty && !store.servers.isEmpty {
            // Not in the frames: every server switched off on this phone.
            EmptyScreen(art: EmptyArt(kind: .connect), title: "Every server is off",
                        message: "Turn one back on in Settings to see its tasks.") {
                Button("Open Settings") { sheet = .settings(server: nil) }
                    .buttonStyle(EmptyCapsuleStyle(kind: .dark))
                    .padding(.top, Theme.Space.xs)
            }
            .padding(.horizontal, Theme.Space.xxl)
            .padding(.bottom, 80)
        } else if store.live.isEmpty {
            EmptyScreen(art: EmptyArt(kind: .connect), title: "Connect a server", message: "Pair with a machine running Dray.") {
                VStack(spacing: 10) {
                    Button { sheet = .add(nil, scan: true) } label: {
                        HStack(spacing: Theme.Space.s) { QRCodeIcon(); Text("Scan QR code") }
                    }
                    .buttonStyle(EmptyCapsuleStyle(kind: .light))
                    Button("Enter an address") { sheet = .add(nil, scan: false) }
                        .buttonStyle(EmptyCapsuleStyle(kind: .dark))
                }
                .padding(.top, Theme.Space.xs)
            }
            .padding(.horizontal, Theme.Space.xxl)
            .padding(.bottom, 80)
        } else if !anyConnected || !store.live.contains(where: { store.listed.contains($0.id) }) {
            // Connected but not read yet is still connecting: "No tasks yet" there was a flash of a lie.
            Group {
                if store.live.allSatisfy({ if case .connecting(0)? = store.serverState[$0.id] { true } else { false } }) {
                    EmptyScreen(art: EmptyArt(kind: .connecting), title: "Connecting",
                                message: store.live.map(\.name).joined(separator: ", "))
                } else if !store.online {
                    EmptyScreen(art: EmptyArt(kind: .unreachable), title: "You're offline",
                                message: "Tasks keep running on their servers.")
                } else if let p = store.live.lazy.compactMap({ s in self.store.health(s.id).map { (s, $0) } })
                            .first(where: { !$0.1.working }) {
                    unreachable(p.0, p.1)
                } else {
                    EmptyScreen(art: EmptyArt(kind: .connecting), title: "Connecting",
                                message: store.live.map(\.name).joined(separator: ", "))
                }
            }
            .padding(.horizontal, 40)
            .padding(.bottom, 184)
        } else {
            let today = store.runs(project: filter, settled: true).flatMap(\.rows)
                .compactMap { r in parseDate(r.item.modified).map { (row: r, at: $0) } }
                .filter { Calendar.current.isDateInToday($0.at) }
            Group {
                if let last = today.max(by: { $0.at < $1.at }) {
                    EmptyScreen(art: SettledStack(title: last.row.item.title, time: shortAge(last.at)),
                                title: "All clear", message: today.count == 1 ? "1 settled today." : "\(today.count) settled today.")
                } else if let filter {
                    EmptyScreen(art: EmptyArt(kind: .project), title: "Nothing in \(filter)",
                                message: "Tap the orb to start one.", pointsAtOrb: true)
                } else {
                    EmptyScreen(art: EmptyArt(kind: .tasks), title: "No tasks yet",
                                message: "Tap the orb to start one.", pointsAtOrb: true)
                }
            }
            .padding(.horizontal, 40)
            .padding(.bottom, 140)
        }
    }

    /// One server's trouble as the screen: frame 03's countdown for a server it can't reach,
    /// else that trouble's own words and action.
    private func unreachable(_ server: Server, _ health: Health) -> some View {
        TimelineView(.periodic(from: .now, by: 1)) { context in
            EmptyScreen(art: EmptyArt(kind: .unreachable), title: health.title, message: message(health, at: context.date)) {
                if let action = health.action {
                    Button(action == .fix ? "Fix" : "Retry now") {
                        Haptic.tap()
                        if action == .fix { sheet = .settings(server: server.id) } else { Task { await store.retry(server.id) } }
                    }
                    .buttonStyle(EmptyCapsuleStyle(kind: .retry))
                }
            }
        }
    }

    private func message(_ health: Health, at now: Date) -> String {
        guard let until = health.until else { return health.detail ?? "Check that it's awake and online." }
        let left = Int(until.timeIntervalSince(now).rounded(.up))
        return (left > 0 ? "Trying again in \(left)s." : "Trying again…") + " Check that it's awake and online."
    }
}

/// For row `i` of a run, whether the connector at each of its depths runs on
/// below it: at its own depth that is a sibling still to come, so the elbow
/// keeps its stem; above it, an ancestor's sibling, so a line passes through.
// ponytail: scans forward per row, O(n²) in a run; runs are tens of rows.
func elbows(_ rows: [ListRow], _ i: Int) -> [Bool] {
    let depth = rows[i].depth
    return (0..<depth).map { level in
        for row in rows[(i + 1)...] {
            if row.depth <= level { return false }
            if row.depth == level + 1 { return true }
        }
        return false
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

    /// A list banner: the session rows' insets, set in from them as the frames have it.
    func bannerRow() -> some View {
        padding(EdgeInsets(top: 0, leading: 14, bottom: 14, trailing: Theme.Space.xs))
            .listRowInsets(EdgeInsets(top: 0, leading: 6, bottom: 0, trailing: 8))
            .listRowSeparator(.hidden)
            .listRowBackground(Color.clear)
            .selectionDisabled()
    }

    /// A session's or a draft's row: the list's own insets, and a fill only where it is the open one.
    func sessionRow(selected: Bool) -> some View {
        listRowInsets(EdgeInsets(top: 0, leading: 6, bottom: 0, trailing: 8))
            .listRowSeparator(.hidden)
            .listRowBackground(
                RoundedRectangle(cornerRadius: Theme.Radius.md, style: .continuous)
                    .fill(selected ? Theme.selected : .clear)
                    .padding(.horizontal, Theme.Space.xs))
    }
}

/// Every project by name, All first, the picked one in full ink. Fades out at
/// the right edge, where a long list runs off.
struct ProjectStrip: View {
    let names: [String]
    let picked: String?
    let pick: (String?) -> Void

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(alignment: .firstTextBaseline, spacing: 18) {
                chip("All", nil)
                ForEach(names, id: \.self) { chip($0, $0) }
            }
            .padding(.horizontal, 20)
        }
        .mask(LinearGradient(stops: [.init(color: .black, location: 0.82), .init(color: .clear, location: 1)],
                             startPoint: .leading, endPoint: .trailing))
        .padding(.top, 14)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Project filter")
    }

    private func chip(_ label: String, _ value: String?) -> some View {
        Button {
            Haptic.select()
            pick(value)
        } label: {
            Text(label)
                .font(Theme.Font.body)
                .foregroundStyle(picked == value ? Theme.text : Theme.tertiary)
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(picked == value ? .isSelected : [])
    }
}

/// One line of the list: rail, elbows, title, and the trailing slot.
struct SessionRow: View {
    @Environment(Store.self) private var store
    let key: SessionKey
    let item: SessionItem
    /// Per depth, whether the connector runs on below this row (`elbows`).
    let lines: [Bool]

    var body: some View {
        let pr = store.prMark(key, item)
        RowLine(title: item.title.isEmpty ? "Untitled" : item.title, time: parseDate(item.modified),
                rail: store.isAsking(key) ? Theme.accent : item.status == "completed" ? Theme.add : nil,
                lines: lines, pr: pr,
                checks: pr?.state == "OPEN" && pr?.checksState == "RUNNING", working: item.busy,
                offline: store.lost.contains(key.server))
    }
}

/// The row's drawing, shared by sessions and drafts. The trailing slot holds
/// what outranks the time — running checks, then the orb — since "last
/// activity" is the least useful thing to say of a row with anything in flight.
struct RowLine: View {
    let title: String
    let time: Date?
    var rail: Color? = nil
    var lines: [Bool] = []
    var pr: PrMark? = nil
    var checks = false
    var working = false
    /// Its server has been down a while: the row is what it last answered, so nothing on it is live.
    var offline = false

    var body: some View {
        HStack(spacing: 0) {
            // The desktop rail's marks: yellow waits on the reader, green is finished and unread.
            ZStack {
                if let rail { RoundedRectangle(cornerRadius: 1.5).fill(rail).frame(width: 2.5, height: 12) }
            }
            .frame(width: 14)
            ForEach(Array(lines.enumerated()), id: \.offset) { level, runsOn in
                Elbow(own: level == lines.count - 1, runsOn: runsOn)
            }
            if let pr { PrGlyph(mark: pr, size: 15).padding(.trailing, 6) }
            Text(title)
                .font(Theme.Font.body)
                .foregroundStyle(Theme.text.opacity(0.88))
                .lineLimit(1)
                .frame(maxWidth: .infinity, alignment: .leading)
            Group {
                if offline {
                    // The desktop's offline mark, never the orb: nobody can say it is still working.
                    Image(systemName: "wifi.slash").font(Theme.Font.footnote.font).foregroundStyle(Theme.tertiary)
                        .accessibilityLabel("Server unreachable")
                } else if checks {
                    ChecksSpinner().frame(width: 15, height: 15)
                } else if working {
                    Orb(.working, label: "Working")
                } else if let time {
                    Text(shortAge(time))
                        .font(Theme.Font.footnote.font.monospacedDigit())
                        .foregroundStyle(Theme.tertiary)
                        .lineLimit(1)
                        .fixedSize()
                }
            }
            .frame(minWidth: 36, alignment: .trailing)
        }
        .frame(height: 44)
        .padding(.trailing, Theme.Space.m)
        .contentShape(.rect)
    }
}

/// How long ago, as the sidebar says it: now, 4m, 1h, 3d.
func shortAge(_ date: Date, now: Date = .now) -> String {
    let s = Int(now.timeIntervalSince(date))
    return s < 60 ? "now" : s < 3600 ? "\(s / 60)m" : s < 86400 ? "\(s / 3600)h" : "\(s / 86400)d"
}

/// One depth of a child's connector, solid #404040: the elbow into the row at
/// its own depth, a straight line where an ancestor's sibling is still to come.
private struct Elbow: View {
    /// This row's own depth, which draws the curve into the title.
    let own: Bool
    let runsOn: Bool

    var body: some View {
        Canvas { ctx, size in
            var p = Path()
            if runsOn {
                p.move(to: CGPoint(x: 6, y: 0))
                p.addLine(to: CGPoint(x: 6, y: size.height))
            }
            if own {
                p.move(to: CGPoint(x: 6, y: runsOn ? 12 : 0))
                if !runsOn { p.addLine(to: CGPoint(x: 6, y: 12)) }
                p.addQuadCurve(to: CGPoint(x: 16, y: 22), control: CGPoint(x: 6, y: 22))
                p.addLine(to: CGPoint(x: 20, y: 22))
            }
            ctx.stroke(p, with: .color(Theme.connector), style: StrokeStyle(lineWidth: 1.2, lineCap: .round))
        }
        .frame(width: 24, height: 44)
        .accessibilityHidden(true)
    }
}

/// Lucide's check-check, the settled view's mark; SF Symbols has no twin.
private struct CheckCheck: View {
    var body: some View {
        Canvas { ctx, size in
            ctx.scaleBy(x: size.width / 24, y: size.height / 24)
            var p = Path()
            p.move(to: CGPoint(x: 18, y: 6)); p.addLine(to: CGPoint(x: 7, y: 17)); p.addLine(to: CGPoint(x: 2, y: 12))
            p.move(to: CGPoint(x: 22, y: 10)); p.addLine(to: CGPoint(x: 14.5, y: 17.5)); p.addLine(to: CGPoint(x: 13, y: 16))
            ctx.stroke(p, with: .foreground, style: StrokeStyle(lineWidth: 1.8, lineCap: .round, lineJoin: .round))
        }
    }
}
