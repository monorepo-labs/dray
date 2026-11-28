import SwiftUI
import ThinkingOrbs

// MARK: Wire

struct IssueState: Codable, Hashable {
    let id: String
    let name: String
    /// `triage`, `backlog`, `unstarted`, `started`, `completed`, `canceled` or `other`.
    let kind: String
    let color: String
}

struct IssuePerson: Codable, Hashable {
    let name: String
    let avatar: String?
}

struct IssueGroup: Codable, Hashable {
    let id: String
    let name: String
}

/// One row of `list_issues`.
struct Issue: Codable, Hashable, Identifiable {
    let tracker: String
    let id: String
    /// `DRA-53`, or `owner/name#12` on GitHub.
    let identifier: String
    let title: String
    let url: String
    let state: IssueState
    /// `urgent`, `high`, `medium`, `low` or `none`.
    let priority: String
    let assignee: IssuePerson?
    let author: IssuePerson?
    let labels: [IssueLabel]
    let team: String?
    let project: String?
    let updatedAt: String
    let pullRequests: [Int]
    let issueType: IssueLabel?

    /// `#12` where every row is one repository's; Linear's is already short.
    var short: String { identifier.lastIndex(of: "#").map { String(identifier[$0...]) } ?? identifier }
}

struct IssueComment: Decodable, Hashable {
    let author: IssuePerson
    let body: String
    let createdAt: String
    let url: String?
}

/// `get_issue`'s answer: the row's fields, its text and talk, and its team's workflow.
struct IssueDetail: Decodable {
    let issue: Issue
    let description: String?
    let comments: [IssueComment]
    let states: [IssueState]

    private enum CodingKeys: String, CodingKey { case description, comments, states }

    init(from decoder: Decoder) throws {
        issue = try Issue(from: decoder)
        let c = try decoder.container(keyedBy: CodingKeys.self)
        description = try c.decodeIfPresent(String.self, forKey: .description)
        comments = try c.decodeIfPresent([IssueComment].self, forKey: .comments) ?? []
        states = try c.decodeIfPresent([IssueState].self, forKey: .states) ?? []
    }
}

struct IssueFilters: Codable {
    /// Linear's teams; GitHub's repositories.
    let teams: [IssueGroup]
    let projects: [IssueGroup]
    let labels: [IssueLabel]
    let issueTypes: [IssueLabel]
}

struct TrackerAccount: Codable {
    let userName: String
    let orgName: String
}

struct Integrations: Codable {
    let linear: TrackerAccount?
    let github: TrackerAccount?
}

/// Why a tracker read failed: `{"kind":…,"detail":…}`.
struct IssueUnavailable: Decodable {
    let kind: String
    let detail: String?

    static func from(_ error: Error) -> IssueUnavailable {
        let text = error.localizedDescription
        return (try? JSONDecoder().decode(IssueUnavailable.self, from: Data(text.utf8))) ?? IssueUnavailable(kind: "other", detail: text)
    }

    /// `issueErrorText`.
    func sentence(_ tracker: String) -> String {
        let linear = tracker == "linear"
        switch kind {
        case "unauthorized": return linear ? "Linear rejected the saved key. Disconnect it in Settings, then paste a new one."
            : "GitHub refused that read. Sign in again with `gh auth login`."
        case "offline": return linear ? "Could not reach Linear." : "Could not reach GitHub."
        case "not_connected": return linear ? "No issue tracker connected." : "Not signed in to GitHub. Run `gh auth login`."
        default: return detail ?? kind
        }
    }
}

// MARK: Rules

/// The status buckets Linear's half draws, in workflow order: `GROUPS` in `issue.ts`.
let issueGroups: [(kind: String, label: String)] = [
    ("started", "In Progress"), ("triage", "Triage"), ("unstarted", "Todo"), ("backlog", "Backlog"),
    ("completed", "Done"), ("canceled", "Cancelled"), ("other", "Other"),
]

let priorityLabels = ["urgent": "Urgent", "high": "High priority", "medium": "Medium priority", "low": "Low priority", "none": "No priority"]
let priorities = ["urgent", "high", "medium", "low", "none"]

/// The tag a prompt names an issue by: `issueTag`, which the server resolves on send.
func issueTag(_ identifier: String, _ title: String) -> String {
    title.isEmpty ? "#\(identifier)" : "#\(identifier) \(title)"
}

/// A GitHub issue's `owner/repo`, off its `owner/repo#12`; a Linear issue names none. `issueRepo`.
func issueRepo(_ issue: Issue) -> String? {
    guard issue.tracker == "github", let at = issue.identifier.lastIndex(of: "#"), at > issue.identifier.startIndex else { return nil }
    return String(issue.identifier[..<at])
}

/// A task's prompt for an issue: its tag, which chips in the transcript, the link,
/// the body as the tracker holds it, and the reader's note last. `issuePrompt`.
func issuePrompt(_ issue: Issue, body: String?, note: String) -> String {
    let head = [issueTag(issue.identifier, issue.title), issue.url].filter { !$0.isEmpty }.joined(separator: "\n")
    return [head, body?.trimmingCharacters(in: .whitespacesAndNewlines), note.trimmingCharacters(in: .whitespacesAndNewlines)]
        .compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: "\n\n")
}

extension Color {
    /// A tracker's `#rrggbb`; grey for anything else.
    init(trackerHex: String) {
        let hex = trackerHex.hasPrefix("#") ? String(trackerHex.dropFirst()) : trackerHex
        self.init(hex: hex.count == 6 ? UInt32(hex, radix: 16) ?? 0xBEC2C8 : 0xBEC2C8)
    }
}

// MARK: Model

/// What the issues page last read: which trackers each server holds, each
/// repository's filters, and each query's list. Kept on disk, so the page draws
/// its last answer at once, even on a cold launch before any server is up, and
/// reads again behind it, as the desktop's `useIssues` cache does in memory.
@MainActor @Observable
final class IssuesModel {
    static let shared = IssuesModel()

    var integrations: [UUID: Integrations] = [:] { didSet { keep() } }
    private(set) var filters: [String: IssueFilters] = [:]
    private(set) var lists: [String: [Issue]] = [:]
    /// The tracker server the last read went through, whose answers draw until one is up.
    private(set) var home: UUID?
    /// When each list last landed, this launch only: a kept list is drawn, then read again.
    @ObservationIgnored private var listedAt: [String: Date] = [:]
    /// A search's lists stay in memory: the next launch opens on the box empty.
    @ObservationIgnored private var typed: Set<String> = []

    private struct Kept: Codable {
        var integrations: [UUID: Integrations]
        var filters: [String: IssueFilters]
        var lists: [String: [Issue]]
        var home: UUID?
    }

    private static let file = Cache.root.appending(path: "issues.json")

    private init() {
        guard let data = try? Data(contentsOf: Self.file), let kept = try? JSONDecoder().decode(Kept.self, from: data) else { return }
        (integrations, filters, lists, home) = (kept.integrations, kept.filters, kept.lists, kept.home)
    }

    private func keep() {
        let kept = Kept(integrations: integrations, filters: filters, lists: lists.filter { !typed.contains($0.key) }, home: home)
        Cache.write(Self.file) { try JSONEncoder().encode(kept) }
    }

    /// Drops everything read through `servers`, freshness stamps included. Keys lead with their server.
    func forget(_ servers: Set<UUID>) {
        func theirs(_ key: String) -> Bool { UUID(uuidString: String(key.prefix { $0 != "|" })).map(servers.contains) ?? false }
        guard lists.keys.contains(where: theirs) || filters.keys.contains(where: theirs)
                || integrations.keys.contains(where: servers.contains) || home.map(servers.contains) == true else { return }
        lists = lists.filter { !theirs($0.key) }
        filters = filters.filter { !theirs($0.key) }
        listedAt = listedAt.filter { !theirs($0.key) }
        if home.map(servers.contains) == true { home = nil }
        // Last: its `didSet` writes the file with everything above gone.
        integrations = integrations.filter { !servers.contains($0.key) }
    }

    func fresh(_ key: String) -> Bool { Date().timeIntervalSince(listedAt[key] ?? .distantPast) < 60 }

    func put(filters: IssueFilters, _ key: String) {
        self.filters[key] = filters
        keep()
    }

    func put(_ list: [Issue], _ key: String, server: UUID, typed: Bool, read: Bool = true) {
        lists[key] = list
        home = server
        if typed { self.typed.insert(key) }
        if read { listedAt[key] = Date() }
        keep()
    }
}

// MARK: The page

/// Every issue the reader could pick up, GitHub's or Linear's: the desktop's
/// issues page on a phone. The tracker switch leads; whose issues are chips
/// under it; repository, team, project, type and label sit behind the filter
/// button. A row opens the issue, where its status and priority can move and
/// play starts a task on it.
struct IssuesView: View {
    @Environment(Store.self) private var store

    @AppStorage("issues.tracker") private var tracker = "linear"
    @AppStorage("issues.repo") private var repo = ""
    @AppStorage("issues.linearScope") private var linearScope = "assigned"
    @AppStorage("issues.githubScope") private var githubScope = "assigned"
    @State private var closed = false
    @State private var team: String?
    @State private var project: String?
    @State private var label: String?
    @State private var issueType: String?
    @State private var text = ""
    @State private var searching = false
    @State private var model = IssuesModel.shared
    @State private var integrationsFailed = false
    /// The last list drawn, held while a new query's first read is out.
    @State private var stale: [Issue] = []
    /// The query whose read failed, which then draws what it has under the sentence.
    @State private var failedFor: String?
    @State private var loading = false
    @State private var unavailable: IssueUnavailable?
    @State private var settled: [Issue]?
    @State private var settledOpen = false
    /// The repository whose filters this page has read; a kept copy draws until then.
    @State private var filtersFor: String?
    @State private var picked: Issue?

    private var github: Bool { tracker == "github" }
    private var scope: String { github ? githubScope : linearScope }
    /// The tracker server, else the last one, so kept answers draw before it is up.
    private var server: UUID? {
        store.trackerServer ?? model.home.flatMap { h in store.live.contains { $0.id == h } ? h : nil }
    }
    /// Reads wait on this: a server still connecting would only fail them.
    private var online: Bool { server.map { store.serverState[$0] == .connected } ?? false }
    private var integrations: Integrations? { server.flatMap { model.integrations[$0] } }
    private var connected: Bool? {
        integrations.map { github ? $0.github != nil : $0.linear != nil }
    }
    /// The picked repository while this server lists it: a pick made through another server,
    /// one since switched off maybe, is no pick here, or its issues read on through this one.
    private var shownRepo: String { filters?.teams.contains { $0.id == repo } == true ? repo : "" }
    private var filtersKey: String { "\(server?.uuidString ?? "")|\(tracker)|\(repo)" }
    private var filters: IssueFilters? { model.filters[filtersKey] }
    private var issues: [Issue] { model.lists[queryKey] ?? stale }
    private var listed: Bool { model.lists[queryKey] != nil || failedFor == queryKey }

    var body: some View {
        List {
            if searching {
                ListSearchField(prompt: "Search issues", text: $text, open: $searching).plainRow()
            }
            if server == nil {
                note("Connect a server to read its issue trackers.")
            } else if connected == false {
                ConnectTracker(tracker: tracker, server: server!) { model.integrations[server!] = $0 }
                    .plainRow()
            } else if connected == nil {
                if integrationsFailed { note("Could not read which trackers \(store.name(of: server!)) is connected to. Pull down to try again.") }
            } else {
                scopes.plainRow()
                content
            }
        }
        .listStyle(.plain)
        .environment(\.defaultMinListRowHeight, 1)
        .themedList()
        .navigationTitle("Issues")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarLeading) { CloseButton() }
            ToolbarItemGroup(placement: .primaryAction) {
                if connected == true { SearchButton(open: $searching) }
                filterMenu
            }
        }
        .refreshable {
            await readIntegrations()
            await list(force: true)
        }
        .task(id: "\(server?.uuidString ?? "")|\(online)") { await readIntegrations() }
        .task(id: "\(filtersKey)|\(connected == true)|\(online)") { await readFilters() }
        // Typing waits a beat, so a word is one read rather than one per letter.
        .task(id: "\(queryKey)|\(online)") {
            if !text.isEmpty { try? await Task.sleep(for: .milliseconds(350)) }
            if Task.isCancelled { return }
            await list(force: false)
        }
        .navigationDestination(item: $picked) { issue in
            if let server {
                IssueDetailView(issue: issue, server: server, updated: edited)
            }
        }
    }

    private func note(_ line: String) -> some View {
        Text(.init(line)).font(Theme.Font.subhead).foregroundStyle(Theme.tertiary)
            .padding(.vertical, Theme.Space.m).plainRow()
    }

    /// Linear's two questions are what is mine and what I filed; GitHub's, mine and everything there.
    private var scopes: some View {
        ChipRow {
            let options = github ? [("assigned", "Assigned to me"), ("all", "All")] : [("assigned", "Assigned to me"), ("created", "Created")]
            ForEach(options, id: \.0) { value, title in
                PickChip(label: title, selected: scope == value) {
                    if github { githubScope = value } else { linearScope = value }
                }
            }
            if github {
                Theme.tile.frame(width: 1, height: 20).padding(.horizontal, Theme.Space.xs)
                PickChip(label: "Open", selected: !closed) { closed = false }
                PickChip(label: "Closed", selected: closed) { closed = true }
            }
        }
        .padding(.vertical, Theme.Space.s)
    }

    @ViewBuilder private var content: some View {
        if let unavailable {
            Text(.init(unavailable.sentence(tracker))).font(Theme.Font.footnote).foregroundStyle(Theme.destructive).plainRow()
        }
        if github && shownRepo.isEmpty {
            // Nothing is read until a repository is picked: the repositories are the empty state.
            if let filters {
                if filters.teams.isEmpty {
                    note("Attach a project with a GitHub remote to see its issues.")
                } else {
                    note("Choose a repository to see its issues.")
                    ForEach(filters.teams, id: \.id) { r in
                        Button { repo = r.id } label: {
                            HStack(spacing: Theme.Space.s) {
                                Image(systemName: "book.closed").foregroundStyle(Theme.tertiary)
                                Text(r.name).foregroundStyle(Theme.text)
                                Spacer()
                            }
                            .font(Theme.Font.body)
                            .frame(height: 44)
                            .padding(.leading, 14)
                            .contentShape(.rect)
                        }
                        .buttonStyle(RowButtonStyle())
                        .accessibilityIdentifier("issue.repo")
                        .sessionRow(selected: false)
                    }
                }
            } else {
                reading
            }
        } else if !listed && issues.isEmpty && unavailable == nil {
            reading
        } else if issues.isEmpty && listed {
            note(text.isEmpty ? emptyLine : "No issue matches that.")
        } else if github {
            ForEach(issues) { row($0) }
        } else {
            ForEach(issueGroups.filter { g in issues.contains { $0.state.kind == g.kind } }, id: \.kind) { g in
                header(g.kind, g.label, issues.filter { $0.state.kind == g.kind }.count)
                ForEach(issues.filter { $0.state.kind == g.kind }) { row($0) }
            }
        }
        // Done and Cancelled are Linear's, start closed, and are read only once opened.
        if !github && listed {
            Button {
                settledOpen.toggle()
                if settledOpen && settled == nil { Task { await listSettled() } }
            } label: {
                HStack(spacing: 6) {
                    Text("Done and cancelled")
                    Image(systemName: settledOpen ? "chevron.down" : "chevron.right").font(.system(size: 11, weight: .semibold))
                    Spacer()
                }
                .font(Theme.Font.footnote)
                .foregroundStyle(Theme.tertiary)
                .padding(.top, Theme.Space.l)
                .padding(.leading, Theme.Space.xs)
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .plainRow()
            if settledOpen {
                if let settled {
                    if settled.isEmpty { note("Nothing here.") }
                    ForEach(issueGroups.filter { g in settled.contains { $0.state.kind == g.kind } }, id: \.kind) { g in
                        header(g.kind, g.label, settled.filter { $0.state.kind == g.kind }.count)
                        ForEach(settled.filter { $0.state.kind == g.kind }) { row($0) }
                    }
                } else {
                    reading
                }
            }
        }
    }

    private var reading: some View {
        HStack(spacing: Theme.Space.s) {
            Orb(.working)
            Text("Reading…").font(Theme.Font.subhead).foregroundStyle(Theme.secondary).shimmer()
        }
        .frame(height: 44)
        .plainRow()
    }

    private var emptyLine: String {
        if closed { return scope == "all" ? "No closed issues in this repository." : "Nothing closed is assigned to you." }
        switch scope {
        case "created": return "Nothing you filed is open."
        case "all": return "No open issues in this repository."
        default: return "Nothing assigned to you."
        }
    }

    private func header(_ kind: String, _ label: String, _ count: Int) -> some View {
        HStack(spacing: 6) {
            IssueStateGlyph(kind: kind, color: nil)
            GroupLabel(label)
            Text("\(count)").font(Theme.Font.footnote.font.monospacedDigit()).foregroundStyle(Theme.tertiary)
        }
        .padding(.top, Theme.Space.l)
        .padding(.leading, Theme.Space.xs)
        .plainRow()
    }

    private func row(_ issue: Issue) -> some View {
        Button { picked = issue } label: { IssueRowView(issue: issue, showAssignee: scope != "assigned") }
            .buttonStyle(RowButtonStyle())
            .accessibilityIdentifier("issue.row")
            .sessionRow(selected: false)
    }

    /// The tracker leads, so it can move with nothing connected; the rest once its filters are read.
    private var filterMenu: some View {
        let narrowed = github ? (!shownRepo.isEmpty && (label != nil || issueType != nil)) : (team != nil || project != nil)
        return Menu {
            Picker("Tracker", selection: $tracker) {
                Text("GitHub").tag("github")
                Text("Linear").tag("linear")
            }
            .pickerStyle(.menu)
            if connected == true, let filters {
                if github {
                    if !filters.teams.isEmpty {
                        Picker("Repository", selection: Binding(get: { shownRepo }, set: { repo = $0; label = nil; issueType = nil })) {
                            ForEach(filters.teams, id: \.id) { Text($0.name).tag($0.id) }
                        }
                        .pickerStyle(.menu)
                    }
                    if !filters.issueTypes.isEmpty {
                        Picker("Type", selection: $issueType) {
                            Text("Any type").tag(String?.none)
                            ForEach(filters.issueTypes, id: \.name) { Text($0.name).tag(String?.some($0.name)) }
                        }
                        .pickerStyle(.menu)
                    }
                    if !filters.labels.isEmpty {
                        Picker("Label", selection: $label) {
                            Text("Any label").tag(String?.none)
                            ForEach(filters.labels, id: \.name) { Text($0.name).tag(String?.some($0.name)) }
                        }
                        .pickerStyle(.menu)
                    }
                } else {
                    if filters.teams.count > 1 {
                        Picker("Team", selection: $team) {
                            Text("All teams").tag(String?.none)
                            ForEach(filters.teams, id: \.id) { Text($0.name).tag(String?.some($0.id)) }
                        }
                        .pickerStyle(.menu)
                    }
                    if filters.projects.count > 1 {
                        Picker("Project", selection: $project) {
                            Text("All projects").tag(String?.none)
                            ForEach(filters.projects, id: \.id) { Text($0.name).tag(String?.some($0.id)) }
                        }
                        .pickerStyle(.menu)
                    }
                }
            }
        } label: {
            Image(systemName: narrowed ? "line.3.horizontal.decrease.circle.fill" : "line.3.horizontal.decrease.circle")
        }
        .accessibilityLabel("Filters")
    }

    // MARK: Reads

    private func query(settled: Bool) -> JSON {
        .object([
            "tracker": .string(tracker), "text": JSON(text.isEmpty ? nil : text), "scope": .string(scope),
            "teamId": JSON(github ? shownRepo : team), "projectId": JSON(github ? nil : project),
            "label": JSON(github ? label : nil), "issueType": JSON(github ? issueType : nil), "settled": .bool(settled),
        ])
    }

    private var queryKey: String {
        "\(server?.uuidString ?? "")|\(tracker)|\(scope)|\(closed)|\(shownRepo)|\(team ?? "")|\(project ?? "")|\(label ?? "")|\(issueType ?? "")|\(text)|\(connected == true)"
    }

    private func readIntegrations() async {
        guard let server, online else { return }
        do {
            model.integrations[server] = try await store.call(server, "get_integrations")
            integrationsFailed = false
        } catch {
            integrationsFailed = true
        }
    }

    private func readFilters() async {
        guard let server, online, connected == true else { return }
        let key = filtersKey
        guard filtersFor != key else { return }
        if let read: IssueFilters = try? await store.call(server, "list_issue_filters",
                                                          ["tracker": .string(tracker), "repo": JSON(github && !repo.isEmpty ? repo : nil)]) {
            model.put(filters: read, key)
            if key == filtersKey { filtersFor = key }
        }
    }

    private func list(force: Bool) async {
        guard let server, online, connected == true, !(github && shownRepo.isEmpty) else { return }
        let key = queryKey
        if !force && model.fresh(key) { return }
        loading = true
        defer { loading = false }
        do {
            let read: [Issue] = try await store.call(server, "list_issues", ["query": query(settled: github && closed), "limit": 100])
            model.put(read, key, server: server, typed: !text.isEmpty)
            guard key == queryKey else { return }
            stale = read
            failedFor = nil
            unavailable = nil
            settled = nil
            if settledOpen { await listSettled() }
        } catch {
            // What was on screen stays; the line above it says it is stale.
            guard key == queryKey else { return }
            unavailable = IssueUnavailable.from(error)
            failedFor = key
        }
    }

    /// Puts an edited issue back where it now belongs: Linear's Done and Cancelled draw from `settled`.
    private func edited(_ next: Issue) {
        func put(_ list: inout [Issue]) {
            if let i = list.firstIndex(where: { $0.id == next.id }) { list[i] = next } else { list.append(next) }
        }
        var shown = issues
        let done = ["completed", "canceled"].contains(next.state.kind)
        if github {
            // GitHub's Open and Closed are two lists: an issue moved across leaves this one.
            if done == closed { put(&shown) } else { shown.removeAll { $0.id == next.id } }
        } else if done {
            shown.removeAll { $0.id == next.id }
            if settled != nil { put(&settled!) }
        } else {
            settled?.removeAll { $0.id == next.id }
            put(&shown)
        }
        if let server { model.put(shown, queryKey, server: server, typed: !text.isEmpty, read: false) }
    }

    private func listSettled() async {
        guard let server else { return }
        let key = queryKey
        let read: [Issue] = (try? await store.call(server, "list_issues", ["query": query(settled: true), "limit": 100])) ?? []
        if key == queryKey { settled = read }
    }
}

/// One issue: its state, its title over its number, priority, labels and people.
private struct IssueRowView: View {
    let issue: Issue
    let showAssignee: Bool

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            IssueStateGlyph(kind: issue.state.kind, color: issue.state.color).padding(.top, 3)
            VStack(alignment: .leading, spacing: 3) {
                Text(issue.title).font(Theme.Font.body).foregroundStyle(Theme.text.opacity(0.88)).lineLimit(2)
                HStack(spacing: 6) {
                    Text(issue.short).monospacedDigit()
                    if issue.tracker == "linear" && issue.priority != "none" { PriorityGlyph(priority: issue.priority) }
                    if let type = issue.issueType { LabelDot(label: type) }
                    ForEach(issue.labels.prefix(2), id: \.name) { LabelDot(label: $0) }
                    if !issue.pullRequests.isEmpty {
                        HStack(spacing: 2) {
                            Image(systemName: "arrow.triangle.pull")
                            Text(issue.pullRequests.map { "#\($0)" }.joined(separator: " "))
                        }
                    }
                }
                .font(Theme.Font.footnote)
                .foregroundStyle(Theme.tertiary)
                .lineLimit(1)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            // The assignee sits under the age, as a PR's author does.
            VStack(alignment: .trailing, spacing: 6) {
                if let at = parseDate(issue.updatedAt) {
                    Text(shortAge(at)).font(Theme.Font.footnote.font.monospacedDigit()).foregroundStyle(Theme.tertiary)
                }
                if showAssignee, let a = issue.assignee { Avatar(url: a.avatar, name: a.name, size: 18) }
            }
            .padding(.top, 3)
        }
        .padding(.vertical, 10)
        .padding(.leading, 14)
        .padding(.trailing, Theme.Space.m)
        .contentShape(.rect)
    }
}

/// Linear's status mark: a ring, part-filled with progress, filled once done or
/// cancelled, in the tracker's own colour.
struct IssueStateGlyph: View {
    let kind: String
    let color: String?
    var size: CGFloat = 14

    private static let fallback = ["triage": "#e2a336", "backlog": "#bec2c8", "unstarted": "#e2e2e2", "started": "#f2c94c",
                                   "completed": "#5e6ad2", "canceled": "#95a2b3", "other": "#bec2c8"]

    var body: some View {
        let tone = Color(trackerHex: color ?? Self.fallback[kind] ?? "")
        ZStack {
            switch kind {
            case "completed":
                Image(systemName: "checkmark.circle.fill").resizable().foregroundStyle(tone)
            case "canceled":
                Image(systemName: "xmark.circle.fill").resizable().foregroundStyle(tone)
            default:
                Circle().strokeBorder(tone, style: StrokeStyle(lineWidth: 1.5, dash: kind == "backlog" ? [2, 1.6] : []))
                let fill: CGFloat = kind == "triage" ? 0.25 : kind == "started" ? 0.5 : 0
                if fill > 0 {
                    Circle().trim(from: 0, to: fill).stroke(tone, lineWidth: size * 0.25).rotationEffect(.degrees(-90))
                        .padding(size * 0.25)
                }
            }
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}

/// Linear's priority: rising bars, urgent a filled square.
struct PriorityGlyph: View {
    let priority: String

    var body: some View {
        Group {
            switch priority {
            case "urgent": Image(systemName: "exclamationmark.square.fill").foregroundStyle(Theme.urgent)
            case "high": Image(systemName: "cellularbars", variableValue: 1)
            case "medium": Image(systemName: "cellularbars", variableValue: 0.66)
            case "low": Image(systemName: "cellularbars", variableValue: 0.33)
            default: Image(systemName: "minus")
            }
        }
        .accessibilityLabel(priorityLabels[priority] ?? priority)
    }
}

/// Labels as a sideways run of capsules: an issue's or a pull request's.
struct LabelChips: View {
    let labels: [IssueLabel]

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                ForEach(labels, id: \.name) { l in
                    LabelDot(label: l)
                        .font(Theme.Font.footnote)
                        .foregroundStyle(Theme.secondary)
                        .padding(.horizontal, 10)
                        .frame(height: 26)
                        .background(Theme.raised, in: Capsule())
                }
            }
        }
    }
}

/// A person's avatar and a line about them, as a detail page's meta lists people.
struct PersonLine<Line: View>: View {
    let avatar: String?
    @ViewBuilder let line: Line

    var body: some View {
        HStack(spacing: Theme.Space.s) {
            Avatar(url: avatar, name: nil, size: 18)
            line.font(Theme.Font.subhead).foregroundStyle(Theme.secondary)
        }
    }
}

/// Someone's picture in a circle; their initial on grey while it loads, or where there is none.
struct Avatar: View {
    let url: String?
    let name: String?
    var size: CGFloat = 16

    var body: some View {
        AsyncImage(url: url.flatMap(URL.init(string:))) { $0.resizable() } placeholder: {
            Circle().fill(Theme.tile).overlay {
                if let first = name?.first {
                    Text(String(first).uppercased()).font(.system(size: size * 0.55, weight: .semibold)).foregroundStyle(Theme.secondary)
                }
            }
        }
        .frame(width: size, height: size)
        .clipShape(Circle())
        .accessibilityLabel(name ?? "")
    }
}

/// A label as its colour's dot and its name.
private struct LabelDot: View {
    let label: IssueLabel

    var body: some View {
        HStack(spacing: 3) {
            Circle().fill(Color(trackerHex: label.color)).frame(width: 7, height: 7)
            Text(label.name)
        }
    }
}

/// A tracker with nothing behind it on the server: Linear takes a key here, GitHub a `gh auth login` there.
private struct ConnectTracker: View {
    @Environment(Store.self) private var store
    let tracker: String
    let server: UUID
    let connected: (Integrations) -> Void
    @State private var key = ""
    @State private var busy = false
    @State private var failure: String?
    @State private var copied = false

    var body: some View {
        let place = store.name(of: server)
        VStack(alignment: .leading, spacing: Theme.Space.m) {
            Text(tracker == "linear" ? "Connect Linear" : "GitHub CLI is logged out").font(Theme.Font.title).foregroundStyle(Theme.text)
            if tracker == "linear" {
                Text("Paste a personal API key. \(place) keeps it and reads Linear with it.")
                    .font(Theme.Font.subhead).foregroundStyle(Theme.secondary)
                SecureField("lin_api_…", text: $key)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .font(Theme.Font.body)
                    .padding(14)
                    .background(Theme.raised, in: .rect(cornerRadius: Theme.Radius.lg, style: .continuous))
                Button { Task { await connect() } } label: { Text(busy ? "Connecting…" : "Connect") }
                    .buttonStyle(CapsuleButtonStyle(height: 48))
                    .disabled(busy || key.trimmingCharacters(in: .whitespaces).isEmpty)
                Link("Make a key in Linear", destination: URL(string: "https://linear.app/settings/account/security")!)
                    .font(Theme.Font.subhead).foregroundStyle(Theme.link)
            } else {
                Text("Issues on GitHub come from the GitHub CLI on \(place). Run this there, then check again.")
                    .font(Theme.Font.subhead).foregroundStyle(Theme.secondary)
                Button {
                    UIPasteboard.general.string = "gh auth login"
                    Haptic.tap()
                    copied = true
                } label: {
                    HStack {
                        Text("gh auth login").font(Theme.Font.code).foregroundStyle(Theme.text)
                        Spacer()
                        Image(systemName: copied ? "checkmark" : "square.on.square").foregroundStyle(Theme.secondary)
                    }
                    .padding(14)
                    .background(Theme.raised, in: .rect(cornerRadius: Theme.Radius.lg, style: .continuous))
                }
                .buttonStyle(RowButtonStyle())
                Button { Task { await recheck() } } label: { Text(busy ? "Checking…" : "Check again") }
                    .buttonStyle(CapsuleButtonStyle(height: 48))
                    .disabled(busy)
            }
            if let failure { Text(sentence(failure)).font(Theme.Font.footnote).foregroundStyle(Theme.destructive) }
        }
        .padding(.top, Theme.Space.xl)
    }

    private func connect() async {
        busy = true
        defer { busy = false }
        do {
            let next: Integrations = try await store.call(server, "connect_linear", ["key": .string(key.trimmingCharacters(in: .whitespaces))])
            key = ""
            failure = nil
            Haptic.success()
            connected(next)
        } catch {
            failure = error.localizedDescription
            Haptic.error()
        }
    }

    private func recheck() async {
        busy = true
        defer { busy = false }
        _ = try? await store.call(server, "recheck_gh", as: Bool.self)
        guard let next: Integrations = try? await store.call(server, "get_integrations") else { return }
        if next.github == nil { failure = "Still not signed in on \(store.name(of: server))." }
        connected(next)
    }
}

// MARK: One issue

/// An opened issue: its status and priority, which move from here, its people
/// and labels, its description and conversation. Play opens the sheet that
/// starts a task on it, the reader's own or a bot's, and Share hands the link on.
struct IssueDetailView: View {
    @Environment(Store.self) private var store
    let issue: Issue
    let server: UUID
    /// The list's copy of the row, kept in step with a status or priority moved here.
    let updated: (Issue) -> Void
    /// Set from a bot's issue card: play hands the issue back to that bot, as the card's own play does.
    var approve: (() -> Void)? = nil
    /// Whether play shows at all; a card's issue already started, or closed, has none.
    var startable = true
    @State private var detail: IssueDetail?
    @State private var failure: String?
    @State private var saving = false
    @State private var starting = false
    @State private var opening: SessionKey?

    var body: some View {
        let shown = detail?.issue ?? issue
        ScrollView {
            VStack(alignment: .leading, spacing: Theme.Space.xl) {
                VStack(alignment: .leading, spacing: Theme.Space.s) {
                    Text(shown.title).font(Theme.Font.title).foregroundStyle(Theme.text)
                    HStack(spacing: Theme.Space.s) {
                        statusMenu(shown)
                        if shown.tracker == "linear" { priorityMenu(shown) }
                        if saving { ProgressView().controlSize(.small) }
                    }
                }
                meta(shown)
                if let failure { Text(sentence(failure)).font(Theme.Font.footnote).foregroundStyle(Theme.destructive) }
                if let detail {
                    if let text = detail.description, !text.isEmpty {
                        MarkdownText(text: text)
                    } else {
                        Text("No description.").font(Theme.Font.subhead).foregroundStyle(Theme.tertiary)
                    }
                    if !detail.comments.isEmpty {
                        VStack(alignment: .leading, spacing: Theme.Space.s) {
                            GroupLabel("Comments")
                            ForEach(Array(detail.comments.enumerated()), id: \.offset) { _, c in comment(c) }
                        }
                    }
                } else if failure == nil {
                    HStack(spacing: Theme.Space.s) {
                        Orb(.working)
                        Text("Reading the issue…").font(Theme.Font.subhead).foregroundStyle(Theme.secondary).shimmer()
                    }
                }
            }
            // Full width whatever the content: a short line left the scroll view a narrow column (#1509).
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 20)
            .padding(.top, 14)
            .padding(.bottom, Theme.Space.xxl)
        }
        .page()
        .navigationTitle(shown.short)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            DetailActions(link: URL(string: shown.url), title: shown.title,
                          play: !startable ? nil : approve ?? { starting = true })
        }
        .sheet(isPresented: $starting) {
            StartTaskSheet(subject: .issue(shown, server: server, body: detail?.description)) { key in
                if let key { opening = key }
            }
        }
        .navigationDestination(item: $opening) { TranscriptView(key: $0).id($0) }
        .refreshable { await read() }
        .task { await read() }
    }

    private func meta(_ i: Issue) -> some View {
        VStack(alignment: .leading, spacing: Theme.Space.s) {
            if let a = i.author { person(a, "\(a.name) opened this") }
            if let a = i.assignee { person(a, "Assigned to \(a.name)") }
            let facts = [i.issueType?.name, i.project, i.pullRequests.isEmpty ? nil : "PR " + i.pullRequests.map { "#\($0)" }.joined(separator: ", "),
                         parseDate(i.updatedAt).map { "Updated \(shortAge($0)) ago" }].compactMap { $0 }
            if !facts.isEmpty {
                Text(facts.joined(separator: " · ")).font(Theme.Font.footnote).foregroundStyle(Theme.tertiary)
            }
            if !i.labels.isEmpty { LabelChips(labels: i.labels) }
        }
    }

    private func person(_ p: IssuePerson, _ line: String) -> some View {
        PersonLine(avatar: p.avatar) { Text(line) }
    }

    private func comment(_ c: IssueComment) -> some View {
        VStack(alignment: .leading, spacing: Theme.Space.s) {
            HStack(spacing: Theme.Space.s) {
                AsyncImage(url: c.author.avatar.flatMap(URL.init(string:))) { $0.resizable() } placeholder: { Circle().fill(Theme.tile) }
                    .frame(width: 20, height: 20)
                    .clipShape(Circle())
                Text(c.author.name).foregroundStyle(Theme.text)
                Spacer()
                if let at = parseDate(c.createdAt) { Text(shortAge(at)).foregroundStyle(Theme.tertiary) }
            }
            .font(Theme.Font.subhead)
            MarkdownText(text: c.body)
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.raised, in: .rect(cornerRadius: Theme.Radius.group, style: .continuous))
    }

    /// The workflow of the issue's own team; a plain mark until the read lands.
    @ViewBuilder private func statusMenu(_ i: Issue) -> some View {
        let label = HStack(spacing: 6) {
            IssueStateGlyph(kind: i.state.kind, color: i.state.color)
            Text(i.state.name)
            if detail?.states.isEmpty == false {
                Image(systemName: "chevron.up.chevron.down").font(.system(size: 11, weight: .semibold)).foregroundStyle(Theme.tertiary)
            }
        }
        .font(Theme.Font.subhead)
        .foregroundStyle(Theme.text)
        .padding(.horizontal, 12)
        .frame(height: 32)
        .background(Theme.raised, in: Capsule())
        if let states = detail?.states, !states.isEmpty {
            Menu {
                Picker("Status", selection: Binding(get: { i.state.id }, set: { id in
                    Task { await update(stateId: id, priority: nil) }
                })) {
                    ForEach(states, id: \.id) { Text($0.name).tag($0.id) }
                }
            } label: { label }
            .accessibilityLabel("Status: \(i.state.name)")
        } else {
            label
        }
    }

    private func priorityMenu(_ i: Issue) -> some View {
        Menu {
            Picker("Priority", selection: Binding(get: { i.priority }, set: { p in
                Task { await update(stateId: nil, priority: p) }
            })) {
                ForEach(priorities, id: \.self) { Text(priorityLabels[$0] ?? $0).tag($0) }
            }
        } label: {
            HStack(spacing: 6) {
                PriorityGlyph(priority: i.priority)
                Text(priorityLabels[i.priority] ?? i.priority)
                Image(systemName: "chevron.up.chevron.down").font(.system(size: 11, weight: .semibold)).foregroundStyle(Theme.tertiary)
            }
            .font(Theme.Font.subhead)
            .foregroundStyle(Theme.text)
            .padding(.horizontal, 12)
            .frame(height: 32)
            .background(Theme.raised, in: Capsule())
        }
        .accessibilityLabel(priorityLabels[i.priority] ?? i.priority)
    }

    private func read() async {
        do {
            detail = try await store.call(server, "get_issue", ["identifier": .string(issue.identifier), "id": .string(issue.id)])
            failure = nil
        } catch {
            failure = IssueUnavailable.from(error).sentence(issue.tracker)
        }
    }

    private func update(stateId: String?, priority: String?) async {
        let i = detail?.issue ?? issue
        saving = true
        defer { saving = false }
        do {
            let next: IssueDetail = try await store.call(server, "update_issue", [
                "identifier": .string(i.identifier), "id": .string(i.id), "stateId": JSON(stateId), "priority": JSON(priority),
            ])
            detail = next
            failure = nil
            updated(next.issue)
            Haptic.success()
        } catch {
            failure = "Could not update \(i.identifier): \(error.localizedDescription)"
            Haptic.error()
        }
    }
}
