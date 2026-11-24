import SwiftUI
import ThinkingOrbs

extension EnvironmentValues {
    /// A settled task opened from a PR's page: its chat, and no dock to write in.
    @Entry var readOnly = false
}

/// A pull request picked on the pull requests page: what it is — state, people,
/// branches, labels, reviewers and its description, the issue page's shape —
/// then every task it has had, newest first, the PR sheet's own rows with a box
/// on each comment, and a box that starts another task on the PR's own branch,
/// the reader's or a bot's. The list's row draws the head at once; the reads fill in the rest.
struct PullDetailView: View {
    @Environment(Store.self) private var store
    let row: PullRow
    @State private var model: PrModel
    @State private var picked: Set<String> = []
    @State private var opening: SessionKey?
    @State private var detail: PrDetail?
    @State private var detailFailure: String?

    init(row: PullRow) {
        self.row = row
        _model = State(initialValue: PrModel(server: row.server, cwd: row.key, branch: row.mark.headRefName))
        _detail = State(initialValue: PullsModel.shared.details[row.id])
    }

    var body: some View {
        // The read answers every PR on the head branch; this page is one.
        let pr = model.prs.first { $0.number == row.mark.number }
        let tasks = sessionsForPr(row, store.items.map { (key: $0.key, item: $0.value) }, repoOf: store.repoOf,
                                  connected: { store.serverState[$0] == .connected })
        ScrollView {
            VStack(alignment: .leading, spacing: 28) {
                VStack(alignment: .leading, spacing: Theme.Space.xl) {
                    head(pr)
                    meta(pr)
                    description
                }
                if !tasks.isEmpty { taskList(tasks) }
                if let u = model.unavailable {
                    Text(.init(u.sentence)).font(Theme.Font.footnote).foregroundStyle(Theme.destructive)
                }
                if let e = model.actionError {
                    Text(sentence(e)).font(Theme.Font.footnote).foregroundStyle(Theme.destructive)
                }
                if let pr {
                    PrSection(pr: pr, model: model, picked: $picked, header: false)
                    PrStartBox(row: row, pr: pr, picked: $picked, latest: tasks.first.flatMap { store.items[$0] })
                } else if model.unavailable == nil {
                    reading("Reading the pull request…")
                }
            }
            .padding(.horizontal, 20)
            .padding(.top, 14)
            .padding(.bottom, Theme.Space.xxl)
        }
        .scrollDismissesKeyboard(.interactively)
        .page()
        .navigationTitle("#\(String(row.mark.number)) · \(row.repoName.split(separator: "/").last.map(String.init) ?? "")")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if let url = row.mark.url.flatMap(URL.init(string:)) {
                ToolbarItem(placement: .primaryAction) {
                    Link(destination: url) { Image(systemName: "arrow.up.right") }.accessibilityLabel("Open on GitHub")
                }
            }
        }
        .refreshable {
            async let detail: Void = readDetail()
            await model.load(store)
            await detail
        }
        .task { await readDetail() }
        // The PR sheet's poll: quicker while GitHub is still working something out.
        .task {
            while !Task.isCancelled {
                await model.load(store)
                try? await Task.sleep(for: .seconds(model.prs.contains(where: \.settling) ? 15 : 60))
            }
        }
        .navigationDestination(item: $opening) { key in
            TranscriptView(key: key).id(key).environment(\.readOnly, store.items[key]?.archived == true)
        }
    }

    /// The title over its state and number, as an issue's page leads.
    private func head(_ pr: PullRequest?) -> some View {
        let state = pr?.state ?? row.mark.state
        let draft = pr?.isDraft ?? row.mark.isDraft
        let label = state == "MERGED" ? "Merged" : state == "CLOSED" ? "Closed" : draft ? "Draft" : "Open"
        return VStack(alignment: .leading, spacing: Theme.Space.s) {
            Text(pr?.title ?? row.listing.title).font(Theme.Font.title).foregroundStyle(Theme.text)
            HStack(spacing: Theme.Space.s) {
                HStack(spacing: 6) {
                    PrGlyph(mark: pr?.mark ?? row.mark, size: 14)
                    Text(label)
                }
                .font(Theme.Font.subhead)
                .foregroundStyle(Theme.text)
                .padding(.horizontal, 12)
                .frame(height: 32)
                .background(Theme.raised, in: Capsule())
                Text("#\(String(row.mark.number))").font(Theme.Font.subhead.font.monospacedDigit()).foregroundStyle(Theme.secondary)
            }
        }
    }

    /// Who opened it and when, where it lands, its size, labels and reviewers.
    private func meta(_ pr: PullRequest?) -> some View {
        let l = row.listing
        let opened = detail.flatMap { parseDate($0.createdAt) }.map { " · \(ago($0))" } ?? ""
        let updated = parseDate(pr?.updatedAt ?? l.updatedAt).map { "Updated \(ago($0))" }
        let files = pr.map { "\($0.changedFiles) \($0.changedFiles == 1 ? "file" : "files")" }
        return VStack(alignment: .leading, spacing: Theme.Space.s) {
            PersonLine(avatar: l.authorAvatar ?? detail?.authorAvatar) { Text("\(pr?.author ?? l.author) opened this\(opened)") }
            HStack(spacing: 6) {
                Image(systemName: "arrow.triangle.branch").foregroundStyle(Theme.tertiary)
                // Base is read with the PR; until then the head alone.
                Text(pr.map { "\($0.baseRefName) ← \(row.mark.headRefName)" } ?? row.mark.headRefName)
                    .font(Theme.Font.footnote.font.monospaced())
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
            .font(Theme.Font.footnote)
            .foregroundStyle(Theme.secondary)
            HStack(spacing: 6) {
                Text("+\(pr?.additions ?? l.additions)").foregroundStyle(Theme.add)
                Text("−\(pr?.deletions ?? l.deletions)").foregroundStyle(Theme.destructive)
                Text(([files, updated].compactMap { $0 }).map { "· \($0)" }.joined(separator: " "))
            }
            .font(Theme.Font.footnote.font.monospacedDigit())
            .foregroundStyle(Theme.tertiary)
            .lineLimit(1)
            if let detail, !detail.labels.isEmpty { LabelChips(labels: detail.labels) }
            if let detail, !detail.reviewers.isEmpty { reviewers(detail.reviewers, decision: pr?.reviewDecision) }
        }
    }

    /// Each reviewer and where they stand, under the review decision GitHub holds the PR to.
    private func reviewers(_ list: [PrReviewer], decision: String?) -> some View {
        let said = ["requested": "awaiting review", "approved": "approved", "changes_requested": "requested changes", "commented": "commented"]
        return VStack(alignment: .leading, spacing: Theme.Space.s) {
            HStack {
                GroupLabel("Reviewers")
                Spacer()
                if decision == "REVIEW_REQUIRED" {
                    Text("Review required").font(Theme.Font.footnote).foregroundStyle(Theme.tertiary)
                }
            }
            .padding(.top, Theme.Space.s)
            ForEach(list, id: \.self) { r in
                PersonLine(avatar: r.avatar) {
                    HStack(spacing: 4) {
                        Text(r.name).foregroundStyle(Theme.text)
                        Text(said[r.state] ?? r.state.replacingOccurrences(of: "_", with: " "))
                            .foregroundStyle(r.state == "approved" ? Theme.add : r.state == "changes_requested" ? Theme.destructive : Theme.tertiary)
                    }
                    .lineLimit(1)
                }
            }
        }
    }

    @ViewBuilder private var description: some View {
        if let detail {
            let text = prBody(detail.body)
            if text.isEmpty {
                Text("No description.").font(Theme.Font.subhead).foregroundStyle(Theme.tertiary)
            } else {
                MarkdownText(text: text)
            }
        } else if let detailFailure {
            Text(sentence(detailFailure)).font(Theme.Font.footnote).foregroundStyle(Theme.tertiary)
        } else {
            reading("Reading the description…")
        }
    }

    private func reading(_ line: String) -> some View {
        HStack(spacing: Theme.Space.s) {
            Orb(.working)
            Text(line).font(Theme.Font.subhead).foregroundStyle(Theme.secondary).shimmer()
        }
    }

    private func ago(_ date: Date) -> String {
        let age = shortAge(date)
        return age == "now" ? "just now" : "\(age) ago"
    }

    /// The description, labels and reviewers; a server from before `pr_detail` says so in place of the text.
    private func readDetail() async {
        do {
            let read: PrDetail = try await store.call(row.server, "pr_detail", ["cwd": .string(row.key), "number": JSON(row.mark.number)])
            detail = read
            detailFailure = nil
            PullsModel.shared.details[row.id] = read
        } catch {
            guard detail == nil else { return }
            let said = error.localizedDescription
            detailFailure = said.contains("unknown command")
                ? "\(store.name(of: row.server)) is too old to send the description. Update it to see it here."
                : PrUnavailable.from(error).sentence
        }
    }

    /// The PR's tasks, newest first. A settled one still opens: its work and conversation are there.
    private func taskList(_ tasks: [SessionKey]) -> some View {
        VStack(alignment: .leading, spacing: Theme.Space.s) {
            GroupLabel(tasks.count == 1 ? "Task" : "Tasks")
            VStack(spacing: 0) {
                ForEach(Array(tasks.enumerated()), id: \.element) { i, key in
                    if i > 0 { PickDivider() }
                    if let item = store.items[key] {
                        let bot = store.botOf(key)
                        Button { opening = key } label: {
                            HStack(spacing: Theme.Space.s) {
                                if let bot { BotFace(bot: bot, size: 18) }
                                Text(bot.map { "\($0.name) · \(item.title)" } ?? item.title)
                                    .foregroundStyle(item.archived == true ? Theme.secondary : Theme.text)
                                    .lineLimit(1)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                if item.archived == true { Text("Settled").foregroundStyle(Theme.tertiary) }
                                else if item.busy { Orb(.working) }
                                Image(systemName: "chevron.right").font(.system(size: 13, weight: .semibold)).foregroundStyle(Theme.tertiary)
                            }
                            .font(Theme.Font.body)
                            .rowFrame()
                        }
                        .buttonStyle(RowButtonStyle())
                    }
                }
            }
            .background(Theme.raised, in: .rect(cornerRadius: Theme.Radius.group, style: .continuous))
        }
    }
}

/// Where a PR's task gets its checkout: one attached on a machine, a checkout on
/// disk to attach first (a bot task's), or a clone into `~/dray` there.
struct PrCheckout: Hashable {
    enum Kind { case here, attach, clone }
    let kind: Kind
    let server: UUID
    let path: String
}

/// The box a task for the PR starts from: a bot's task or the reader's own,
/// the plain task's machine, agent, model, effort and fast mode, the reader's
/// words, and Start. A bot's task runs on the bot's own agent, so its pickers
/// belong to the plain task alone. Always Auto: the page offers no stance.
private struct PrStartBox: View {
    @Environment(Store.self) private var store
    let row: PullRow
    let pr: PullRequest
    @Binding var picked: Set<String>
    /// The PR's latest task, whose agent and model a plain task starts on.
    let latest: SessionItem?

    @AppStorage("pr.startMode") private var mode = "bot"
    @AppStorage("pr.startBot") private var botId = ""
    @State private var text = ""
    @State private var machine: PrCheckout?
    @State private var harness = ""
    @State private var modelId = ""
    @State private var effort: String?
    @State private var fast = false
    @State private var agents: [AgentAvailability] = []
    @State private var models: [Model] = []
    @State private var starting = false
    @State private var cloning: (server: UUID, slug: String)?
    @State private var failure: String?
    @FocusState private var typing: Bool

    var body: some View {
        let writable = !row.listing.isCrossRepository
        VStack(alignment: .leading, spacing: Theme.Space.m) {
            GroupLabel("Start a task")
            if !writable {
                Text("Read only. This branch lives in a fork, so an agent here can't push to it.")
                    .font(Theme.Font.subhead).foregroundStyle(Theme.secondary)
            } else {
                HStack(spacing: 6) {
                    Image(systemName: "arrow.triangle.branch")
                    Text("New worktree on **\(row.mark.headRefName)**, the PR's own branch").lineLimit(2)
                }
                .font(Theme.Font.footnote)
                .foregroundStyle(Theme.secondary)
                .padding(.horizontal, Theme.Space.xs)
                let bots = store.bots[initial.server] ?? []
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
                if !toBot { picks }
                TextField("What should the agent do with this pull request?", text: $text, axis: .vertical)
                    .lineLimit(2...8)
                    .focused($typing)
                    .font(Theme.Font.body)
                    .foregroundStyle(Theme.text)
                    .padding(14)
                    .background(Theme.raised, in: .rect(cornerRadius: Theme.Radius.lg, style: .continuous))
                Button { Task { await start() } } label: {
                    HStack(spacing: Theme.Space.s) {
                        if starting { ProgressView().tint(Theme.page) }
                        Text(cloning != nil ? "Cloning…" : starting ? "Starting…" : bot.map { "Start in \($0.name)" } ?? "Start task")
                    }
                }
                .buttonStyle(CapsuleButtonStyle(height: 48))
                .disabled(starting || (!toBot && machinePick == nil))
                if let cloning {
                    Text("Cloning \(cloning.slug)\(store.cloneProgress[cloning.server]?[cloning.slug].map { " · \($0)" } ?? "…")")
                        .font(Theme.Font.footnote.font.monospacedDigit()).foregroundStyle(Theme.secondary).lineLimit(1)
                } else if (toBot ? initial : machinePick)?.kind == .attach {
                    Text("Attaches \(row.key) first, the checkout a task of this repo already uses.")
                        .font(Theme.Font.footnote).foregroundStyle(Theme.secondary)
                }
                if !picked.isEmpty {
                    Text(picked.count == 1 ? "Quotes the comment picked above." : "Quotes the \(picked.count) comments picked above.")
                        .font(Theme.Font.footnote).foregroundStyle(Theme.tertiary)
                }
            }
            if let failure {
                Text(sentence(failure)).font(Theme.Font.footnote).foregroundStyle(Theme.destructive)
            }
        }
        .onAppear(perform: seed)
        .task(id: "\(machinePick?.server.uuidString ?? "")|\(harness)") { await loadModels() }
    }

    // MARK: Picks

    private var bot: Bot? {
        guard mode == "bot" else { return nil }
        let bots = store.bots[initial.server] ?? []
        return bots.first { $0.id == botId } ?? bots.first
    }
    private var toBot: Bool { bot != nil }

    private var connected: [UUID] { store.live.filter { store.serverState[$0.id] == .connected }.map(\.id) }

    /// Every checkout of the PR's repo, the checkout it was read through if no
    /// project holds it, then a clone on each connected machine with none.
    private var machines: [PrCheckout] {
        let real = connected.flatMap { s in
            (store.projects[s] ?? []).filter { $0.remote == row.repo || (s == row.server && $0.path == row.key) }
                .map { PrCheckout(kind: .here, server: s, path: $0.path) }
        }
        let attach = !row.key.hasPrefix("github:") && !real.contains { $0.server == row.server && $0.path == row.key }
            ? [PrCheckout(kind: .attach, server: row.server, path: row.key)] : []
        let name = row.repo.split(separator: "/").last.map(String.init) ?? row.repo
        let clones = connected.filter { s in !(real + attach).contains { $0.server == s } }
            .map { PrCheckout(kind: .clone, server: $0, path: "~/dray/\(name)") }
        return attach + real + clones
    }

    /// The checkout the PR would use anyway: the one it was read through, else any, else a clone here.
    private var initial: PrCheckout {
        let all = machines
        return all.first { $0.server == row.server && $0.path == row.key }
            ?? all.first { $0.kind == .here }
            ?? all.first { $0.server == row.server }
            ?? all.first
            ?? PrCheckout(kind: .clone, server: row.server, path: "")
    }

    private var machinePick: PrCheckout? {
        machine.flatMap { m in machines.contains(m) ? m : nil } ?? (machines.isEmpty ? nil : initial)
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
            PickMenu("Machine", value: machinePick.map(label) ?? "") {
                Picker("Machine", selection: Binding(get: { machinePick }, set: { machine = $0 })) {
                    ForEach(machines, id: \.self) { Text(label($0)).tag(Optional($0)) }
                }
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

    /// A new worktree on the PR's own branch, the reader's own task or the bot's;
    /// a checkout attached or cloned first only now, so opening a PR changes nothing on disk.
    private func start() async {
        guard !starting, let at = toBot ? initial : machinePick else { return }
        typing = false
        starting = true
        failure = nil
        defer {
            starting = false
            cloning = nil
        }
        var cwd = at.path
        if at.kind != .here {
            let slug = row.key.hasPrefix("github:") ? String(row.key.dropFirst("github:".count)) : (prRepoSlug(row.mark.url) ?? "")
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
                    : list.first { !before.contains($0.path) && $0.remote == row.repo } ?? list.first { $0.remote == row.repo }
                guard let made else { return failure = "The checkout was made but is not in the project list." }
                cwd = made.path
                await PullsModel.shared.loadMarks(store, [ProjectKey(server: at.server, path: made.path)], force: true)
            } catch {
                Haptic.error()
                return failure = at.kind == .clone ? "Could not clone \(slug) into ~/dray: \(error.localizedDescription)"
                    : "Could not attach \(at.path): \(error.localizedDescription)"
            }
            cloning = nil
        }
        do {
            let item: SessionItem = try await store.call(at.server, "start_pr_session", [
                "sessionId": .string(UUID().uuidString.lowercased()),
                "prompt": .string(prPrompt(pr, picked: picked, text: text)),
                "harness": .string(harness), "model": .string(modelId), "effort": JSON(effort),
                "permissionMode": "auto", "fast": .bool(fast), "cwd": .string(cwd),
                "prHead": .object(["branch": .string(row.mark.headRefName), "repo": .string(row.repo)]),
                "prNumber": JSON(row.mark.number), "bot": JSON(bot?.id),
            ], timeout: .seconds(120))
            store.created(at.server, item)
            text = ""
            picked = []
            Haptic.success()
        } catch {
            Haptic.error()
            let said = error.localizedDescription
            // Asked before anything is made, so nothing is left to tidy up.
            failure = said.contains("unknown command")
                ? "This server is older than the pull requests page. Update it, then start the task again." : said
        }
    }
}

/// A bot as a chip in the start box: its face and name, white when picked.
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
