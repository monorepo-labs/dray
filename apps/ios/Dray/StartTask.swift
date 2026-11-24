import SwiftUI

/// What the start sheet starts a task on: a pull request on its own branch, or an issue.
enum StartSubject {
    case pr(PullRow, PullRequest)
    /// `server` is the tracker's, which read the issue; `body` its description, quoted into the prompt.
    case issue(Issue, server: UUID, body: String?)
}

/// Where a task gets its checkout: one attached on a machine, a checkout on
/// disk to attach first (a bot task's), or a clone into `~/dray` there.
struct PrCheckout: Hashable {
    enum Kind { case here, attach, clone }
    let kind: Kind
    let server: UUID
    let path: String
}

/// The sheet the PR and issue pages' play button opens: the reader's words, a
/// bot or the reader's own task, and the plain task's machine, agent, model,
/// effort and fast mode, then Start. A bot's task runs on the bot's own agent,
/// so the pickers belong to the plain task alone. Always Auto: the sheet offers no stance.
struct StartTaskSheet: View {
    @Environment(Store.self) private var store
    @Environment(\.dismiss) private var dismiss
    let subject: StartSubject
    /// The PR's latest task, whose agent and model a plain task starts on.
    var latest: SessionItem? = nil
    /// A task made; nil for an issue sent to a bot, which starts it in its own time.
    var started: (SessionKey?) -> Void = { _ in }

    @AppStorage("pr.startMode") private var mode = "bot"
    @AppStorage("pr.startBot") private var botId = ""
    @State private var text = ""
    @State private var machine: PrCheckout?
    @State private var harness = ""
    @State private var modelId = ""
    @State private var effort: String?
    @State private var fast = false
    @State private var worktree = UserDefaults.standard.bool(forKey: "new.worktree")
    @State private var agents: [AgentAvailability] = []
    @State private var models: [Model] = []
    @State private var starting = false
    @State private var cloning: (server: UUID, slug: String)?
    @State private var failure: String?
    @FocusState private var typing: Bool

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: Theme.Space.m) {
                    if readOnly {
                        Text("Read only. This branch lives in a fork, so an agent here can't push to it.")
                            .font(Theme.Font.subhead).foregroundStyle(Theme.secondary)
                    } else {
                        form
                    }
                    if let failure {
                        Text(sentence(failure)).font(Theme.Font.footnote).foregroundStyle(Theme.destructive)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 20)
                .padding(.top, Theme.Space.s)
                .padding(.bottom, Theme.Space.xl)
            }
            .scrollDismissesKeyboard(.interactively)
            .safeAreaInset(edge: .bottom) { if !readOnly { startButton } }
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .topBarLeading) { CloseButton() } }
            .background(Theme.card)
        }
        .presentationDetents([.large])
        .presentationDragIndicator(.visible)
        .presentationBackground(Theme.card)
        .onAppear {
            seed()
            typing = !readOnly
        }
        .task(id: "\(machinePick?.server.uuidString ?? "")|\(harness)") { await loadModels() }
    }

    @ViewBuilder private var form: some View {
        TextField(placeholder, text: $text, axis: .vertical)
            .lineLimit(3...10)
            .focused($typing)
            .font(Theme.Font.body)
            .foregroundStyle(Theme.text)
            .padding(14)
            .background(Theme.raised, in: .rect(cornerRadius: Theme.Radius.lg, style: .continuous))
        if case .pr(let row, _) = subject {
            HStack(spacing: 6) {
                Image(systemName: "arrow.triangle.branch")
                Text("New worktree on **\(row.mark.headRefName)**, the PR's own branch").lineLimit(2)
            }
            .font(Theme.Font.footnote)
            .foregroundStyle(Theme.secondary)
            .padding(.horizontal, Theme.Space.xs)
        }
        let bots = store.bots[home] ?? []
        if !bots.isEmpty {
            ChipRow(focus: toBot ? botId : "task") {
                ForEach(bots, id: \.id) { b in
                    BotChip(bot: b, selected: toBot && bot?.id == b.id) {
                        mode = "bot"
                        botId = b.id
                    }
                    .id(b.id)
                }
                PickChip(label: "Task", selected: !toBot) { mode = "task" }.id("task")
            }
        }
        if !toBot {
            if machines.isEmpty {
                Text("Attach a project on a connected machine to start a task here.")
                    .font(Theme.Font.subhead).foregroundStyle(Theme.secondary)
            } else {
                picks
            }
        }
        if let cloning {
            Text("Cloning \(cloning.slug)\(store.cloneProgress[cloning.server]?[cloning.slug].map { " · \($0)" } ?? "…")")
                .font(Theme.Font.footnote.font.monospacedDigit()).foregroundStyle(Theme.secondary).lineLimit(1)
        } else if !toBot, let at = machinePick, at.kind == .attach {
            Text("Attaches \(at.path) first, the checkout a task of this repo already uses.")
                .font(Theme.Font.footnote).foregroundStyle(Theme.secondary)
        }
    }

    private var startButton: some View {
        Button { Task { await start() } } label: {
            HStack(spacing: Theme.Space.s) {
                if starting { ProgressView().tint(Theme.page) }
                Text(cloning != nil ? "Cloning…" : starting ? "Starting…" : bot.map { isIssue ? "Send to \($0.name)" : "Start in \($0.name)" } ?? "Start task")
            }
        }
        .buttonStyle(CapsuleButtonStyle(height: 48))
        .disabled(starting || (!toBot && machinePick == nil))
        .padding(.horizontal, 20)
        .padding(.vertical, Theme.Space.s)
        .background(Theme.card)
    }

    // MARK: Subject

    private var isIssue: Bool { if case .issue = subject { true } else { false } }

    private var readOnly: Bool { if case .pr(let row, _) = subject { row.listing.isCrossRepository } else { false } }

    private var title: String {
        switch subject {
        case .pr(let row, _): "Start a task on #\(String(row.mark.number))"
        case .issue(let issue, _, _): "Work on \(issue.short)"
        }
    }

    private var placeholder: String {
        isIssue ? "Anything to add? The issue goes with it." : "What should the agent do with this pull request?"
    }

    /// The machine the subject was read on: its bots are the ones offered.
    private var home: UUID {
        switch subject {
        case .pr(let row, _): row.server
        case .issue(_, let server, _): server
        }
    }

    /// The repository's `host/owner/name`, which a project's `remote` matches; nil for Linear, which names none.
    private var remote: String? {
        switch subject {
        case .pr(let row, _): row.repo
        case .issue(let issue, _, _): issueRepo(issue).map { "github.com/\($0)".lowercased() }
        }
    }

    /// `owner/name` to clone where no machine holds one.
    private var slug: String? {
        switch subject {
        case .pr(let row, _): row.key.hasPrefix("github:") ? String(row.key.dropFirst("github:".count)) : prRepoSlug(row.mark.url)
        case .issue(let issue, _, _): issueRepo(issue)
        }
    }

    // MARK: Picks

    private var bot: Bot? {
        guard mode == "bot" else { return nil }
        let bots = store.bots[home] ?? []
        return bots.first { $0.id == botId } ?? bots.first
    }
    private var toBot: Bool { bot != nil }

    private var connected: [UUID] { store.live.filter { store.serverState[$0.id] == .connected }.map(\.id) }

    /// Every checkout of the repo, the PR's own checkout if no project holds it,
    /// then a clone on each connected machine with none. A Linear issue names no
    /// repo, so every attached project is a pick and nothing is cloned.
    private var machines: [PrCheckout] {
        let real = connected.flatMap { s in
            (store.projects[s] ?? []).filter { p in
                guard let remote else { return true }
                if case .pr(let row, _) = subject, s == row.server && p.path == row.key { return true }
                return p.remote == remote
            }
            .sorted { $0.lastSelected > $1.lastSelected }
            .map { PrCheckout(kind: .here, server: s, path: $0.path) }
        }
        var attach: [PrCheckout] = []
        if case .pr(let row, _) = subject, !row.key.hasPrefix("github:"), !real.contains(where: { $0.server == row.server && $0.path == row.key }) {
            attach = [PrCheckout(kind: .attach, server: row.server, path: row.key)]
        }
        guard remote != nil, let slug else { return attach + real }
        let name = slug.split(separator: "/").last.map(String.init) ?? slug
        let clones = connected.filter { s in !(real + attach).contains { $0.server == s } }
            .map { PrCheckout(kind: .clone, server: $0, path: "~/dray/\(name)") }
        return attach + real + clones
    }

    /// The checkout it would use anyway: the PR's own, else one on the tracker's machine, else any.
    private var initial: PrCheckout? {
        let all = machines
        if case .pr(let row, _) = subject, let own = all.first(where: { $0.server == row.server && $0.path == row.key }) { return own }
        return all.first { $0.kind == .here && $0.server == home } ?? all.first { $0.kind == .here } ?? all.first { $0.server == home } ?? all.first
    }

    private var machinePick: PrCheckout? {
        machine.flatMap { m in machines.contains(m) ? m : nil } ?? initial
    }

    private func label(_ c: PrCheckout) -> String {
        let place = store.name(of: c.server)
        switch c.kind {
        case .clone: return "\(place) · clone into ~/dray"
        default: return "\(place) · \((c.path as NSString).lastPathComponent)"
        }
    }

    @ViewBuilder private var picks: some View {
        let model = models.first { $0.id == modelId }
        let usable = agents.filter(\.available)
        PickCard {
            PickMenu(isIssue && remote == nil ? "Project" : "Machine", value: machinePick.map(label) ?? "") {
                Picker("Machine", selection: Binding(get: { machinePick }, set: { machine = $0 })) {
                    ForEach(machines, id: \.self) { Text(label($0)).tag(Optional($0)) }
                }
            }
            if isIssue {
                PickDivider()
                PickRow("Worktree") { PickSwitch(label: "Worktree", isOn: $worktree) }
            }
            if usable.count > 1 {
                PickDivider()
                PickMenu("Agent", value: Picks.agentLabels[harness] ?? harness) {
                    Picker("Agent", selection: Binding(get: { harness }, set: pickHarness)) {
                        ForEach(usable, id: \.harness) { Text($0.label).tag($0.harness) }
                    }
                }
            }
            if !models.isEmpty {
                PickDivider()
                PickMenu("Model", value: model?.label ?? (modelId.isEmpty ? "Default" : modelId)) {
                    Picker("Model", selection: $modelId) {
                        if Picks.defaultModel[harness] == "" { Text("Default").tag("") }
                        ForEach(models, id: \.id) { Text($0.label).tag($0.id) }
                    }
                }
            }
            if let model, !model.efforts.isEmpty {
                PickDivider()
                PickMenu("Effort", value: effort.map { Picks.effortLabels[$0] ?? $0 } ?? "") {
                    Picker("Effort", selection: Binding(get: { effort ?? "" }, set: { effort = $0 })) {
                        ForEach(model.efforts, id: \.self) { Text(Picks.effortLabels[$0] ?? $0).tag($0) }
                    }
                }
            }
            if Picks.offersFast(harness, model) {
                PickDivider()
                PickRow("Fast mode") { PickSwitch(label: "Fast mode", isOn: $fast) }
            }
        }
        .onChange(of: modelId) { repairEffort() }
    }

    /// The PR's latest task's agent and model, since that agent did the work, else a new task's remembered ones.
    private func seed() {
        guard harness.isEmpty else { return }
        if let latest {
            (harness, modelId, effort, fast) = (latest.harness, latest.model, latest.effort, latest.fast ?? false)
        } else {
            harness = UserDefaults.standard.string(forKey: "new.harness") ?? "claude_code"
            modelId = Prefs.map("models")[harness] ?? Picks.defaultModel[harness] ?? ""
            effort = Prefs.map("efforts")[modelId]
            fast = UserDefaults.standard.bool(forKey: "new.fast")
        }
    }

    private func pickHarness(_ h: String) {
        harness = h
        modelId = Prefs.map("models")[h] ?? Picks.defaultModel[h] ?? ""
        effort = Prefs.map("efforts")[modelId]
        models = []
    }

    private func loadModels() async {
        guard let server = machinePick?.server, !harness.isEmpty else { return }
        let asked = harness
        let current = { machinePick?.server == server && harness == asked }
        let read: [AgentAvailability] = (try? await store.call(server, "agent_availability")) ?? []
        guard current() else { return }
        agents = read
        // A machine without this agent starts on one it has.
        if !agents.isEmpty, !agents.contains(where: { $0.harness == harness && $0.available }),
           let first = agents.first(where: \.available) {
            return pickHarness(first.harness)
        }
        let listed: [Model] = (try? await store.call(server, "list_models", ["harness": .string(harness)])) ?? []
        guard current() else { return }
        models = listed
        // A remembered model this agent no longer runs would reach the server as a pick nobody made.
        modelId = Picks.usableModel(models, modelId, harness)
        repairEffort()
    }

    private func repairEffort() {
        guard let model = models.first(where: { $0.id == modelId }) else { return }
        effort = Picks.usableEffort(model, effort)
        if !Picks.offersFast(harness, model) { fast = false }
    }

    // MARK: Start

    private func start() async {
        guard !starting else { return }
        typing = false
        starting = true
        failure = nil
        defer {
            starting = false
            cloning = nil
        }
        // An issue goes to the bot as a hand-off it starts once free, as an issue card's does.
        if case .issue(let issue, _, _) = subject, let bot {
            do {
                let ref: JSON = .object(["tracker": .string(issue.tracker), "id": .string(issue.id),
                                         "identifier": .string(issue.identifier), "title": .string(issue.title), "url": .string(issue.url)])
                _ = try await store.call(home, "send_issue_to_bot", ["botId": .string(bot.id), "issue": ref, "note": JSON(text.isEmpty ? nil : text)], as: JSON.self)
                Haptic.success()
                started(nil)
                dismiss()
            } catch {
                Haptic.error()
                let said = error.localizedDescription
                failure = said.contains("unknown command") ? "Update \(store.name(of: home)) to send it issues." : said
            }
            return
        }
        // A bot's PR task runs in the PR's own checkout, wherever the plain task's picks point.
        guard let at = toBot ? initial : machinePick else { return failure = "No connected machine to start it on." }
        guard let cwd = await checkout(at) else { return }
        do {
            let item: SessionItem
            let id = UUID().uuidString.lowercased()
            switch subject {
            case .pr(let row, let pr):
                item = try await store.call(at.server, "start_pr_session", [
                    "sessionId": .string(id),
                    "prompt": .string(prPrompt(pr, text: text)),
                    "harness": .string(harness), "model": .string(modelId), "effort": JSON(effort),
                    "permissionMode": "auto", "fast": .bool(fast), "cwd": .string(cwd),
                    "prHead": .object(["branch": .string(row.mark.headRefName), "repo": .string(row.repo)]),
                    "prNumber": JSON(row.mark.number), "bot": JSON(bot?.id),
                ], timeout: .seconds(120))
            case .issue(let issue, _, let body):
                let outcome: SendOutcome = try await store.call(at.server, "send_msg", [
                    "sessionId": .string(id),
                    "prompt": .string(issuePrompt(issue, body: body, note: text)),
                    "attachmentPaths": [],
                    "harness": .string(harness), "model": .string(modelId), "effort": JSON(effort),
                    "permissionMode": .string(Picks.stanceFor(harness, "auto")),
                    "fast": .bool(fast && Picks.offersFast(harness, models.first { $0.id == modelId })),
                    "cwd": .string(cwd), "branch": nil, "useWorktree": .bool(worktree), "worktreeName": nil, "baseRef": nil,
                    "isNewSession": true, "issueIds": [.string(issue.identifier)],
                    "device": .string(sendingDevice), "sentAt": sentAt(),
                ], timeout: .seconds(120))
                guard let snap = outcome.snapshot else { return failure = "The task started but the server sent no row for it." }
                item = snap
            }
            store.created(at.server, item)
            text = ""
            Haptic.success()
            started(SessionKey(server: at.server, id: item.sessionId))
            dismiss()
        } catch {
            Haptic.error()
            let said = error.localizedDescription
            // Asked before anything is made, so nothing is left to tidy up.
            failure = said.contains("unknown command")
                ? "This server is older than the pull requests page. Update it, then start the task again." : said
        }
    }

    /// The checkout's path, attached or cloned first only now, so opening a page changes nothing on disk.
    private func checkout(_ at: PrCheckout) async -> String? {
        guard at.kind != .here else { return at.path }
        let slug = slug ?? ""
        do {
            let list: [Project]
            let before = Set((store.projects[at.server] ?? []).map(\.path))
            if at.kind == .clone {
                cloning = (at.server, slug)
                store.cloneProgress[at.server]?[slug] = nil
                // A clone runs as long as the repository is big; progress arrives meanwhile.
                list = try await store.call(at.server, "clone_github_repo", ["slug": .string(slug)], timeout: .seconds(1800))
            } else {
                list = try await store.call(at.server, "add_project", ["path": .string(at.path)])
            }
            store.attached(at.server, list)
            // By full path, never by folder name: two checkouts can share one.
            let made = at.kind == .attach ? list.first { $0.path == at.path }
                : list.first { !before.contains($0.path) && $0.remote == remote } ?? list.first { $0.remote == remote }
            guard let made else {
                failure = "The checkout was made but is not in the project list."
                return nil
            }
            await PullsModel.shared.loadMarks(store, [ProjectKey(server: at.server, path: made.path)], force: true)
            cloning = nil
            return made.path
        } catch {
            Haptic.error()
            failure = at.kind == .clone ? "Could not clone \(slug) into ~/dray: \(error.localizedDescription)"
                : "Could not attach \(at.path): \(error.localizedDescription)"
            return nil
        }
    }
}

/// The share and play buttons a PR's and an issue's page carry, play the rightmost and the primary.
struct DetailActions: ToolbarContent {
    let link: URL?
    let title: String
    let play: (() -> Void)?

    var body: some ToolbarContent {
        ToolbarItemGroup(placement: .primaryAction) {
            if let link {
                ShareLink(item: link, subject: Text(title), message: Text(title)) { Image(systemName: "square.and.arrow.up") }
                    .accessibilityLabel("Share")
            }
            if let play {
                Button(action: play) { Image(systemName: "play.fill") }
                    .accessibilityLabel("Start a task")
                    .modifier(Prominent())
            }
        }
    }
}

/// The bar's filled primary on iOS 26, the yellow one; a plain item before it.
private struct Prominent: ViewModifier {
    func body(content: Content) -> some View {
        if #available(iOS 26, *) {
            content.buttonStyle(.glassProminent).tint(Theme.accent)
        } else {
            content
        }
    }
}

/// A bot as a chip in the start sheet: its face and name, white when picked.
private struct BotChip: View {
    let bot: Bot
    let selected: Bool
    let pick: () -> Void

    var body: some View {
        HStack(spacing: 6) {
            BotFace(bot: bot, size: 18)
            Text(bot.name).font(selected ? Theme.Font.pill : Theme.Font.subhead)
        }
        .foregroundStyle(selected ? Theme.page : Theme.text)
        .lineLimit(1)
        .padding(.leading, 9)
        .padding(.trailing, 14)
        .frame(height: 36)
        .background(selected ? Theme.text : Theme.tile, in: Capsule())
        .contentShape(Capsule())
        .onTapGesture {
            Haptic.select()
            pick()
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(bot.name)
        .accessibilityIdentifier("bot.chip")
        .accessibilityAddTraits(selected ? [.isButton, .isSelected] : .isButton)
    }
}
