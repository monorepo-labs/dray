import SwiftUI
import ThinkingOrbs

// MARK: Wire

struct IssueState: Decodable, Hashable {
    let id: String
    let name: String
    /// `triage`, `backlog`, `unstarted`, `started`, `completed`, `canceled` or `other`.
    let kind: String
    let color: String
}

struct IssuePerson: Decodable, Hashable {
    let name: String
    let avatar: String?
}

struct IssueLabel: Decodable, Hashable {
    let name: String
    let color: String
}

struct IssueGroup: Decodable, Hashable {
    let id: String
    let name: String
}

/// One row of `list_issues`.
struct Issue: Decodable, Hashable, Identifiable {
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

struct IssueFilters: Decodable {
    /// Linear's teams; GitHub's repositories.
    let teams: [IssueGroup]
    let projects: [IssueGroup]
    let labels: [IssueLabel]
    let issueTypes: [IssueLabel]
}

struct TrackerAccount: Decodable {
    let userName: String
    let orgName: String
}

struct Integrations: Decodable {
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

extension Color {
    /// A tracker's `#rrggbb`; grey for anything else.
    init(trackerHex: String) {
        let hex = trackerHex.hasPrefix("#") ? String(trackerHex.dropFirst()) : trackerHex
        self.init(hex: hex.count == 6 ? UInt32(hex, radix: 16) ?? 0xBEC2C8 : 0xBEC2C8)
    }
}

// MARK: The page

/// Every issue the reader could pick up, GitHub's or Linear's: the desktop's
/// issues page on a phone. The tracker switch leads; whose issues are chips
/// under it; repository, team, project, type and label sit behind the filter
/// button. A row opens the issue, where its status and priority can move and
/// Work on it carries its tag to the new-task dock.
struct IssuesView: View {
    @Environment(Store.self) private var store
    /// Puts a tag in the new task's words and goes back to the list.
    let workOn: (String) -> Void

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
    @State private var integrations: Integrations?
    @State private var integrationsFailed = false
    @State private var issues: [Issue] = []
    @State private var listedFor: String?
    @State private var loading = false
    @State private var unavailable: IssueUnavailable?
    @State private var settled: [Issue]?
    @State private var settledOpen = false
    @State private var filters: IssueFilters?
    @State private var filtersFor: String?
    @State private var picked: Issue?

    private var github: Bool { tracker == "github" }
    private var scope: String { github ? githubScope : linearScope }
    private var server: UUID? { store.trackerServer }
    private var connected: Bool? {
        integrations.map { github ? $0.github != nil : $0.linear != nil }
    }

    var body: some View {
        List {
            Picker("Tracker", selection: $tracker) {
                Text("GitHub").tag("github")
                Text("Linear").tag("linear")
            }
            .pickerStyle(.segmented)
            .padding(.vertical, Theme.Space.s)
            .plainRow()
            if server == nil {
                note("Connect a server to read its issue trackers.")
            } else if connected == false {
                ConnectTracker(tracker: tracker, server: server!) { integrations = $0 }
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
        .searchable(text: $text, placement: .navigationBarDrawer(displayMode: .always), prompt: "Search issues")
        .toolbar {
            ToolbarItem(placement: .topBarLeading) { CloseButton() }
            ToolbarItem(placement: .primaryAction) { filterMenu }
        }
        .refreshable {
            if integrations == nil { await readIntegrations() }
            await list(force: true)
        }
        .task(id: server) { await readIntegrations() }
        .task(id: "\(server?.uuidString ?? "")|\(tracker)|\(repo)|\(connected == true)") { await readFilters() }
        // Typing waits a beat, so a word is one read rather than one per letter.
        .task(id: queryKey) {
            if listedFor != nil, !text.isEmpty { try? await Task.sleep(for: .milliseconds(350)) }
            if Task.isCancelled { return }
            await list(force: false)
        }
        .navigationDestination(item: $picked) { issue in
            if let server {
                IssueDetailView(issue: issue, server: server, workOn: workOn, updated: edited)
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
        .padding(.bottom, Theme.Space.s)
    }

    @ViewBuilder private var content: some View {
        if let unavailable {
            Text(.init(unavailable.sentence(tracker))).font(Theme.Font.footnote).foregroundStyle(Theme.destructive).plainRow()
        }
        if github && repo.isEmpty {
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
        } else if listedFor != queryKey && issues.isEmpty && unavailable == nil {
            reading
        } else if issues.isEmpty && listedFor != nil {
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
        if !github && listedFor != nil {
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

    @ViewBuilder private var filterMenu: some View {
        if connected == true, let filters {
            let narrowed = github ? (!repo.isEmpty && (label != nil || issueType != nil)) : (team != nil || project != nil)
            Menu {
                if github {
                    if !filters.teams.isEmpty {
                        Picker("Repository", selection: Binding(get: { repo }, set: { repo = $0; label = nil; issueType = nil })) {
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
            } label: {
                Image(systemName: narrowed ? "line.3.horizontal.decrease.circle.fill" : "line.3.horizontal.decrease.circle")
            }
            .accessibilityLabel("Filters")
        }
    }

    // MARK: Reads

    private func query(settled: Bool) -> JSON {
        .object([
            "tracker": .string(tracker), "text": JSON(text.isEmpty ? nil : text), "scope": .string(scope),
            "teamId": JSON(github ? repo : team), "projectId": JSON(github ? nil : project),
            "label": JSON(github ? label : nil), "issueType": JSON(github ? issueType : nil), "settled": .bool(settled),
        ])
    }

    private var queryKey: String {
        "\(server?.uuidString ?? "")|\(tracker)|\(scope)|\(closed)|\(repo)|\(team ?? "")|\(project ?? "")|\(label ?? "")|\(issueType ?? "")|\(text)|\(connected == true)"
    }

    private func readIntegrations() async {
        guard let server else { return }
        do {
            integrations = try await store.call(server, "get_integrations")
            integrationsFailed = false
        } catch {
            integrationsFailed = true
        }
    }

    private func readFilters() async {
        guard let server, connected == true else { return }
        let key = "\(server)|\(tracker)|\(repo)"
        guard filtersFor != key else { return }
        filters = nil
        filtersFor = nil
        if let read: IssueFilters = try? await store.call(server, "list_issue_filters",
                                                          ["tracker": .string(tracker), "repo": JSON(github && !repo.isEmpty ? repo : nil)]),
           key == "\(self.server.map { "\($0)" } ?? "")|\(tracker)|\(repo)" {
            filters = read
            filtersFor = key
        }
    }

    private func list(force: Bool) async {
        guard let server, connected == true, !(github && repo.isEmpty) else { return }
        let key = queryKey
        if !force && listedFor == key { return }
        loading = true
        defer { loading = false }
        do {
            let read: [Issue] = try await store.call(server, "list_issues", ["query": query(settled: github && closed), "limit": 100])
            guard key == queryKey else { return }
            issues = read
            listedFor = key
            unavailable = nil
            settled = nil
            if settledOpen { await listSettled() }
        } catch {
            // What was on screen stays; the line above it says it is stale.
            guard key == queryKey else { return }
            unavailable = IssueUnavailable.from(error)
            listedFor = key
        }
    }

    /// Puts an edited issue back where it now belongs: Linear's Done and Cancelled draw from `settled`.
    private func edited(_ next: Issue) {
        func put(_ list: inout [Issue]) {
            if let i = list.firstIndex(where: { $0.id == next.id }) { list[i] = next } else { list.append(next) }
        }
        if !github && ["completed", "canceled"].contains(next.state.kind) {
            issues.removeAll { $0.id == next.id }
            if settled != nil { put(&settled!) }
        } else {
            settled?.removeAll { $0.id == next.id }
            put(&issues)
        }
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
                    if showAssignee, let a = issue.assignee { Text(a.name) }
                }
                .font(Theme.Font.footnote)
                .foregroundStyle(Theme.tertiary)
                .lineLimit(1)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            if let at = parseDate(issue.updatedAt) {
                Text(shortAge(at)).font(Theme.Font.footnote.font.monospacedDigit()).foregroundStyle(Theme.tertiary).padding(.top, 3)
            }
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
/// and labels, its description and conversation, and Work on it.
struct IssueDetailView: View {
    @Environment(Store.self) private var store
    let issue: Issue
    let server: UUID
    let workOn: (String) -> Void
    /// The list's copy of the row, kept in step with a status or priority moved here.
    let updated: (Issue) -> Void
    @State private var detail: IssueDetail?
    @State private var failure: String?
    @State private var saving = false

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
                Button { workOn(issueTag(shown.identifier, shown.title)) } label: { Text("Work on it") }
                    .buttonStyle(CapsuleButtonStyle(height: 48))
            }
            .padding(.horizontal, 20)
            .padding(.top, 14)
            .padding(.bottom, Theme.Space.xxl)
        }
        .page()
        .navigationTitle(shown.short)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if let url = URL(string: shown.url) {
                ToolbarItem(placement: .primaryAction) {
                    Link(destination: url) { Image(systemName: "arrow.up.right") }.accessibilityLabel("Open in the tracker")
                }
            }
        }
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
            if !i.labels.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) {
                        ForEach(i.labels, id: \.name) { l in
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
    }

    private func person(_ p: IssuePerson, _ line: String) -> some View {
        HStack(spacing: Theme.Space.s) {
            AsyncImage(url: p.avatar.flatMap(URL.init(string:))) { $0.resizable() } placeholder: { Circle().fill(Theme.tile) }
                .frame(width: 18, height: 18)
                .clipShape(Circle())
            Text(line).font(Theme.Font.subhead).foregroundStyle(Theme.secondary)
        }
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
