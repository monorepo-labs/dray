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

    var body: some View {
        // One entry per name: the same repo on two machines is one project here.
        var seen = Set<String>()
        let names = store.servers.flatMap { store.projects[$0.id] ?? [] }.map(\.name).filter { seen.insert($0).inserted }
        // A picked project that left the list narrows nothing.
        let filter = names.contains { $0 == project } ? project : nil
        let runs = mode == .drafts ? [] : store.runs(project: filter, settled: mode == .settled)
        let problems = store.servers.compactMap { s in store.health(s.id).map { (server: s, health: $0) } }
        VStack(spacing: 0) {
            if names.count > 1 {
                ProjectStrip(names: names, picked: filter) { project = $0 }
            }
            List(selection: $selection) {
                if !store.online { OfflineBanner().plainRow() }
                ForEach(problems, id: \.server.id) { p in
                    ServerBanner(name: p.server.name, health: p.health,
                                 retry: { Task { await store.retry(p.server.id) } },
                                 fix: { sheet = .settings(server: p.server.id) })
                        .plainRow()
                }
                if mode == .drafts {
                    draftRows(filter)
                } else if runs.isEmpty {
                    empty.plainRow().frame(minHeight: 460)
                }
                // One block per run: the gap between them is the whole signal, never a heading.
                ForEach(Array(runs.enumerated()), id: \.element.stage) { i, run in
                    if i > 0 { Color.clear.frame(height: Theme.Space.l).plainRow() }
                    ForEach(Array(run.rows.enumerated()), id: \.element.id) { j, row in
                        SessionRow(key: row.key, item: row.item, lines: elbows(run.rows, j))
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
            }
            .listStyle(.plain)
            .contentMargins(.top, Theme.Space.m, for: .scrollContent)
            // The resting dock's height, so the last row scrolls clear of the orb.
            .contentMargins(.bottom, store.servers.isEmpty ? 0 : 160, for: .scrollContent)
            // The breaks between runs are 16pt, under the 44pt a list row otherwise takes.
            .environment(\.defaultMinListRowHeight, 1)
            .themedList()
            .animation(Theme.motion, value: runs.map { $0.rows.map(\.id) })
            .refreshable {
                await store.refresh()
                if mode == .drafts { await loadDrafts() }
                if mode == .settled { await store.loadSettled() }
            }
        }
        .overlay(alignment: .bottom) {
            if !store.servers.isEmpty {
                VoiceDock(task: task) { selection = $0 }
            }
        }
        .page()
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { header }
        // Again once a server comes up: a view opened before it connected read nothing from it.
        .task(id: "\(mode) \(store.servers.filter { store.serverState[$0.id] == .connected }.count)") {
            if mode == .drafts { await loadDrafts() }
            if mode == .settled { await store.loadSettled() }
        }
    }

    /// Settings on the left; the drafts and settled views sharing one glass pill
    /// on the right. While one is shown, the other dims, so the lit one reads as on.
    @ToolbarContentBuilder private var header: some ToolbarContent {
        ToolbarItem(placement: .topBarLeading) {
            Button { sheet = .settings(server: nil) } label: { Image(systemName: "gearshape") }
                .accessibilityLabel("Settings")
        }
        ToolbarItemGroup(placement: .topBarTrailing) {
            viewToggle(.drafts, label: "Drafts") { Image(systemName: "circle.dashed") }
            viewToggle(.settled, label: "Settled") { CheckCheck().frame(width: 20, height: 20) }
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

    /// Every connected server's drafts, newest first. A server that cannot say is left out.
    private func loadDrafts() async {
        var all: [(server: UUID, draft: DraftItem)] = []
        for s in store.servers where store.serverState[s.id] == .connected {
            let list: [DraftItem] = (try? await store.call(s.id, "list_drafts")) ?? []
            all += list.map { (s.id, $0) }
        }
        drafts = all.sorted { ($0.draft.created ?? "") > ($1.draft.created ?? "") }
    }

    /// What the list says with no rows: no server yet, one coming up, or nothing started.
    @ViewBuilder private var empty: some View {
        if mode == .settled {
            Text("Nothing settled.").font(Theme.Font.subhead).foregroundStyle(Theme.tertiary)
                .padding(.leading, 14).frame(height: 44, alignment: .leading)
        } else if store.servers.isEmpty {
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
            EmptyState(title: "No tasks yet", message: "Hold the orb to start one.") {
                Orb(state: .idle, size: 40)
            }
        } else {
            EmptyState(title: "Nothing to show yet", message: "Sessions show up here once a server connects.") {
                Orb(state: .idle, size: 40)
            }
        }
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
                checks: pr?.state == "OPEN" && pr?.checksState == "RUNNING", working: item.busy)
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
                if checks {
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
