import SwiftUI
import UIKit

// MARK: Wire

struct Project: Decodable, Hashable {
    let path: String
    let name: String
    let lastSelected: String
}

struct AgentAvailability: Decodable, Hashable {
    let harness: String
    let available: Bool
    let label: String
    let reason: String
}

struct Model: Decodable, Hashable {
    let id: String
    let label: String
    let efforts: [String]
    let defaultEffort: String?
    let supportsFast: Bool
}

struct BranchList: Decodable {
    let current: String?
    let branches: [String]
    let defaultBase: String?
    let dirty: Int
}

struct GithubRepo: Decodable, Hashable {
    let slug: String
    let description: String?
    let path: String?
}

struct CloneProgress: Decodable {
    let slug: String
    let line: String
}

// MARK: Rules

/// The desktop composer's rules, restated since neither side can call the
/// other: `permission.ts`, `fastMode.ts` and `model.ts`. A new session runs no
/// turn yet, so nothing in `liveControls.ts` locks here.
enum Picks {
    /// `DEFAULT_MODEL_FOR`. Empty is "let the harness decide", which pi and fx
    /// answer from their own settings.
    static let defaultModel = ["claude_code": "opus", "codex": "gpt-6-sol", "pi": "", "fx": "", "grok": "grok-4.7"]
    static let defaultEffort = "high"
    static let effortLabels = ["low": "Low", "medium": "Medium", "high": "High", "xhigh": "Extra High", "max": "Max", "ultra": "Ultra"]
    static let stances = [("bypassPermissions", "Bypass permissions"), ("manual", "Ask every time"), ("plan", "Plan"), ("auto", "Auto")]

    /// `HONOURED`: absent means every stance applies.
    private static let honoured: [String: [String]] = [
        "codex": ["bypassPermissions", "manual", "auto"],
        "pi": [],
        "fx": ["manual", "auto"],
        "grok": ["manual", "auto", "bypassPermissions"],
    ]

    static func honours(_ harness: String, _ mode: String) -> Bool {
        honoured[harness]?.contains(mode) ?? true
    }

    /// One honoured stance is not a menu, and pi honours none.
    static func offersStances(_ harness: String) -> Bool {
        stances.filter { honours(harness, $0.0) }.count > 1
    }

    /// `stanceFor`: what the session will actually run, which is what the index records.
    static func stanceFor(_ harness: String, _ mode: String) -> String {
        if honours(harness, mode) { return mode }
        switch harness {
        case "fx": return mode == "plan" ? "manual" : "auto"
        case "grok": return mode == "plan" ? "manual" : "bypassPermissions"
        default: return "bypassPermissions"
        }
    }

    /// `offersFast` and `fastFor` for a new session: the harness needs a route
    /// to one (pi has none) and the model a faster tier. fx alone stands with no
    /// model picked, since it decides per model itself.
    static func offersFast(_ harness: String, _ model: Model?) -> Bool {
        guard ["claude_code", "codex", "fx", "grok"].contains(harness) else { return false }
        return model?.supportsFast ?? (harness == "fx")
    }

    /// `usableModel`: a pick this list cannot run falls to the harness's
    /// default, never to the head of the list.
    static func usableModel(_ models: [Model], _ picked: String, _ harness: String) -> String {
        if models.isEmpty || models.contains(where: { $0.id == picked }) { return picked }
        let fallback = defaultModel[harness] ?? ""
        if fallback.isEmpty { return "" }
        return models.contains { $0.id == fallback } ? fallback : models[0].id
    }

    /// `usableEffort`: the pick, else the model's default, else the app's, else the top rung.
    static func usableEffort(_ model: Model, _ remembered: String?) -> String? {
        guard !model.efforts.isEmpty else { return nil }
        for wanted in [remembered, model.defaultEffort, defaultEffort] {
            if let wanted, model.efforts.contains(wanted) { return wanted }
        }
        return model.efforts.last
    }
}

/// The last model per harness and effort per model, which `@AppStorage` cannot hold.
private enum Prefs {
    static func map(_ key: String) -> [String: String] {
        UserDefaults.standard.dictionary(forKey: "new." + key) as? [String: String] ?? [:]
    }
    static func set(_ value: [String: String], _ key: String) { UserDefaults.standard.set(value, forKey: "new." + key) }
}

// MARK: New session

struct NewSessionView: View {
    @Environment(Store.self) private var store
    @Environment(\.dismiss) private var dismiss
    let onCreated: (SessionKey) -> Void

    @State private var pickedServer: UUID?
    @State private var prompt = ""
    @State private var projects: [Project] = []
    @State private var projectPath: String?
    @State private var agents: [AgentAvailability] = []
    @State private var models: [String: [Model]] = [:]
    @AppStorage("new.harness") private var harness = "claude_code"
    @State private var modelPicks = Prefs.map("models")
    @State private var effortPicks = Prefs.map("efforts")
    @State private var modelId = ""
    @AppStorage("new.stance") private var stance = "auto"
    @AppStorage("new.fast") private var fast = false
    @AppStorage("new.worktree") private var worktree = false
    @State private var branches: BranchList?
    /// A branch picked over a dirty tree, waiting on Stash or Bring, with the
    /// project it was picked in.
    @State private var switching: (server: UUID, cwd: String, target: String)?
    /// A branch read or checkout is out: the session must not start on the old branch.
    @State private var checkingOut = false
    @State private var sending = false
    @State private var failure: String?

    private var connected: [Server] { store.servers.filter { store.serverState[$0.id] == .connected } }
    private var server: UUID? { pickedServer ?? connected.first?.id }
    /// Keyed by server and harness, so a list never lands under the wrong one.
    private var modelsKey: String { "\(server?.uuidString ?? "")|\(harness)" }
    private var list: [Model] { models[modelsKey] ?? [] }
    private var model: Model? { list.first { $0.id == modelId } }
    private var effort: String? { model.map { Picks.usableEffort($0, effortPicks[modelId]) } ?? effortPicks[modelId] }
    private var agent: AgentAvailability? { agents.first { $0.harness == harness } }

    var body: some View {
        NavigationStack {
            Form {
                if connected.isEmpty {
                    Text("No server is connected.").foregroundStyle(.secondary)
                } else {
                    form
                }
            }
            .scrollDismissesKeyboard(.immediately)
            .navigationTitle("New session")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    if sending {
                        ProgressView()
                    } else {
                        Button("Start") { Task { await start() } }.disabled(!ready)
                    }
                }
            }
            .task(id: server) { await loadServer() }
            .task(id: modelsKey) { await loadModels() }
            // At once, not when the list lands: the old agent's model must never
            // go out under the new agent's name.
            .onChange(of: modelsKey) { modelId = Picks.usableModel(list, remembered, harness) }
            .task(id: projectPath) { await loadBranches() }
            .confirmationDialog(
                "\(branches?.dirty ?? 0) uncommitted \(branches?.dirty == 1 ? "file" : "files")",
                isPresented: Binding(get: { switching != nil }, set: { if !$0 { switching = nil } }),
                titleVisibility: .visible
            ) {
                if let s = switching {
                    Button("Stash changes") { Task { await checkout(s.server, s.cwd, s.target, stash: true) } }
                    Button("Bring changes") { Task { await checkout(s.server, s.cwd, s.target, stash: false) } }
                }
            } message: {
                Text("Switching to \(switching?.target ?? ""). Bring moves them with you; Stash keeps them here, saved for later.")
            }
        }
    }

    @ViewBuilder private var form: some View {
        Section {
            TextField("What should it do?", text: $prompt, axis: .vertical)
                .lineLimit(3...8)
                .accessibilityLabel("Prompt")
        }

        if connected.count > 1 {
            Picker("Server", selection: Binding(get: { server }, set: { pickedServer = $0 })) {
                ForEach(connected) { Text($0.name).tag(Optional($0.id)) }
            }
        }

        Section("Project") {
            if !projects.isEmpty {
                Picker("Project", selection: $projectPath) {
                    ForEach(projects, id: \.path) { Text($0.name).tag(Optional($0.path)) }
                }
            }
            if let server {
                NavigationLink("Attach project…") {
                    AttachProjectView(server: server, projects: projects) { list in
                        projects = list
                        projectPath = newest(list)
                    }
                }
            }
            // Both describe a repo, so neither means anything until one is picked.
            if projectPath != nil {
                Toggle("Worktree", isOn: $worktree)
                if worktree {
                    // A worktree forks from the remote's default branch whatever is
                    // checked out, so a branch picker here would promise nothing.
                    if let base = branches?.defaultBase {
                        LabeledContent("From", value: base)
                    }
                } else if let branches, !branches.branches.isEmpty {
                    Picker("Branch", selection: Binding(
                        get: { branches.current ?? "" },
                        set: { target in Task { await pickBranch(target) } }
                    )) {
                        ForEach(branches.branches, id: \.self) { Text($0).tag($0) }
                    }
                }
            }
        }

        Section {
            Picker("Agent", selection: $harness) {
                ForEach(agents, id: \.harness) { a in
                    Text(a.available ? a.label : "\(a.label) (unavailable)").tag(a.harness)
                }
            }
            Picker("Model", selection: Binding(get: { modelId }, set: pickModel)) {
                if Picks.defaultModel[harness]?.isEmpty ?? false {
                    Text("Default").tag("")
                }
                ForEach(list, id: \.id) { Text($0.label).tag($0.id) }
            }
            if let model, !model.efforts.isEmpty {
                Picker("Effort", selection: Binding(get: { effort ?? "" }, set: pickEffort)) {
                    ForEach(model.efforts, id: \.self) { Text(Picks.effortLabels[$0] ?? $0).tag($0) }
                }
            }
            if Picks.offersFast(harness, model) {
                Toggle("Fast mode", isOn: $fast)
            }
            if Picks.offersStances(harness) {
                Picker("Permissions", selection: Binding(get: { Picks.stanceFor(harness, stance) }, set: { stance = $0 })) {
                    ForEach(Picks.stances.filter { Picks.honours(harness, $0.0) }, id: \.0) { Text($0.1).tag($0.0) }
                }
            }
        } footer: {
            if let agent, !agent.available { Text(agent.reason) }
        }

        if let failure {
            Section { Text(failure).foregroundStyle(.red) }
        }
    }

    private var ready: Bool {
        !sending && !checkingOut && server != nil && projectPath != nil && agent?.available == true
            && models[modelsKey] != nil
            && !prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private var remembered: String { modelPicks[harness] ?? Picks.defaultModel[harness] ?? "" }

    /// Whether a reply read for this server and project still describes what is
    /// on screen. A call outlives the task that made it, so a late one from a
    /// server or project the reader left must not land.
    private func still(_ s: UUID, _ cwd: String? = nil) -> Bool {
        server == s && (cwd == nil || projectPath == cwd)
    }

    /// The project launch reopens: `add_project` and a pick both stamp it newest.
    private func newest(_ list: [Project]) -> String? {
        list.max { $0.lastSelected < $1.lastSelected }?.path
    }

    private func pickModel(_ id: String) {
        modelId = id
        modelPicks[harness] = id
        Prefs.set(modelPicks, "models")
    }

    private func pickEffort(_ level: String) {
        effortPicks[modelId] = level
        Prefs.set(effortPicks, "efforts")
    }

    private func loadServer() async {
        guard let server else { return }
        failure = nil
        projects = []
        projectPath = nil
        do {
            async let p: [Project] = store.call(server, "list_projects")
            async let a: [AgentAvailability] = store.call(server, "agent_availability")
            let (read, available) = try await (p, a)
            guard still(server) else { return }
            (projects, agents) = (read, available)
            projectPath = newest(read)
        } catch {
            if still(server) { failure = error.localizedDescription }
        }
    }

    private func loadModels() async {
        guard let server else { return }
        let key = modelsKey
        if models[key] == nil {
            do {
                models[key] = try await store.call(server, "list_models", ["harness": .string(harness)])
            } catch {
                // An empty list lets the pick stand, as the desktop's does.
                models[key] = []
                failure = error.localizedDescription
            }
        }
        if key == modelsKey { modelId = Picks.usableModel(list, remembered, harness) }
    }

    private func loadBranches() async {
        branches = nil
        guard let server, let cwd = projectPath else { return }
        // Fire and forget, as the desktop does: losing it costs one pick next time.
        _ = try? await store.call(server, "set_last_selected_project", ["path": .string(cwd)], as: JSON.self)
        do {
            let list: BranchList = try await store.call(server, "list_branches", ["cwd": .string(cwd)])
            if still(server, cwd) { branches = list }
        } catch {
            if still(server, cwd) { failure = error.localizedDescription }
        }
    }

    /// The dirty count is re-read at the pick: the one read with the project is
    /// stale by now, and a stale zero would move the reader's work silently.
    private func pickBranch(_ target: String) async {
        guard !checkingOut, let server, let cwd = projectPath, target != branches?.current else { return }
        checkingOut = true
        defer { checkingOut = false }
        do {
            let list: BranchList = try await store.call(server, "list_branches", ["cwd": .string(cwd)])
            guard still(server, cwd) else { return }
            branches = list
            if list.dirty > 0 {
                switching = (server, cwd, target)
            } else {
                await checkout(server, cwd, target, stash: false)
            }
        } catch {
            if still(server, cwd) { failure = error.localizedDescription }
        }
    }

    /// Runs where the branch was picked, never wherever the selection is by now.
    private func checkout(_ server: UUID, _ cwd: String, _ target: String, stash: Bool) async {
        switching = nil
        checkingOut = true
        defer { checkingOut = false }
        do {
            let list: BranchList = try await store.call(server, "checkout_branch", [
                "cwd": .string(cwd), "branch": .string(target), "stash": .bool(stash),
            ])
            if still(server, cwd) { branches = list }
        } catch {
            // Git refuses rather than clobbering, naming the files in the way.
            if still(server, cwd) { failure = error.localizedDescription }
        }
    }

    /// The argument set `useSessions.ts` sends for a new session, with the stance
    /// and fast mode narrowed to what this agent and model can honour.
    private func start() async {
        guard let server, let cwd = projectPath else { return }
        sending = true
        failure = nil
        defer { sending = false }
        let id = UUID().uuidString.lowercased()
        do {
            let outcome: SendOutcome = try await store.call(server, "send_msg", [
                "sessionId": .string(id),
                "prompt": .string(prompt),
                "attachmentPaths": [],
                "harness": .string(harness),
                "model": .string(modelId),
                "effort": JSON(effort),
                "permissionMode": .string(Picks.stanceFor(harness, stance)),
                "fast": .bool(fast && Picks.offersFast(harness, model)),
                "cwd": .string(cwd),
                "branch": worktree ? nil : JSON(branches?.current),
                "useWorktree": .bool(worktree),
                "worktreeName": nil,
                "baseRef": nil,
                "isNewSession": true,
            ])
            if let item = outcome.snapshot { store.created(server, item) }
            onCreated(SessionKey(server: server, id: id))
            dismiss()
        } catch {
            failure = error.localizedDescription
        }
    }
}

// MARK: Attach

/// A GitHub repo cloned into `~/dray` on that server, or a folder already
/// there; ATTACH-PLAN.md. A repo already on the server attaches straight away.
struct AttachProjectView: View {
    @Environment(Store.self) private var store
    @Environment(\.dismiss) private var dismiss
    let server: UUID
    let projects: [Project]
    let onAttached: ([Project]) -> Void

    @State private var repos: [GithubRepo]?
    /// `no_cli`, `not_authenticated`, or a sentence for anything else.
    @State private var unavailable: (kind: String, detail: String?)?
    @State private var loading = false
    @State private var stillMissing = false
    @State private var query = ""
    /// A repo not yet on the server, waiting on the reader to confirm the clone.
    @State private var confirming: GithubRepo?
    @State private var cloning: String?
    @State private var failure: String?
    @State private var typing = false
    @State private var path = ""

    private var place: String { store.name(of: server) }
    private var attached: Set<String> { Set(projects.map(\.path)) }
    private var shown: [GithubRepo] {
        let needle = query.trimmingCharacters(in: .whitespaces).lowercased()
        return (repos ?? []).filter {
            needle.isEmpty || $0.slug.lowercased().contains(needle) || ($0.description?.lowercased().contains(needle) ?? false)
        }
    }

    var body: some View {
        List {
            if let u = unavailable, u.kind == "no_cli" || u.kind == "not_authenticated" {
                missingCli(u.kind)
            } else if let u = unavailable {
                Text(u.detail ?? "Could not read repositories.").foregroundStyle(.red)
            } else if repos == nil {
                Label { Text("Reading your repositories…") } icon: { ProgressView() }
                    .foregroundStyle(.secondary)
            } else if shown.isEmpty {
                Text(repos!.isEmpty ? "No repositories." : "No repository matches.").foregroundStyle(.secondary)
            } else {
                Section {
                    ForEach(shown, id: \.slug) { row($0) }
                } footer: {
                    Text("Repositories not on \(place) yet clone into ~/dray there.")
                }
            }
            if let failure {
                Text(failure).foregroundStyle(.red)
            }
        }
        .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: "Search repositories")
        .navigationTitle("Attach project")
        .toolbar {
            ToolbarItem(placement: .bottomBar) {
                Button("Enter path") { typing = true }.disabled(cloning != nil)
            }
        }
        // A question rather than a toolbar Attach: an active search hides the
        // navigation bar, and with it any button there.
        .confirmationDialog("Clone \(confirming?.slug ?? "")?", isPresented: Binding(
            get: { confirming != nil }, set: { if !$0 { confirming = nil } }
        ), titleVisibility: .visible, presenting: confirming) { r in
            Button("Clone into ~/dray") { Task { await clone(r) } }
        } message: { _ in
            Text("It clones on \(place), with gh.")
        }
        .alert("Folder on \(place)", isPresented: $typing) {
            TextField("~/code/project", text: $path)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
            Button("Cancel", role: .cancel) {}
            Button("Attach") { Task { await attach("add_project", ["path": .string(path.trimmingCharacters(in: .whitespaces))]) } }
        }
        .task { await read() }
    }

    private func row(_ r: GithubRepo) -> some View {
        let here = r.path.map { attached.contains($0) } ?? false
        let mark = r.path == nil ? nil : here ? "Attached" : "Cloned"
        // One already on the server attaches at once; anything else asks first,
        // since a clone is too big to start on a stray tap.
        return Button {
            if let path = r.path { Task { await attach("add_project", ["path": .string(path)]) } } else { confirming = r }
        } label: {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    HStack {
                        Text(r.slug).foregroundStyle(.primary)
                        Spacer()
                        if let mark { Text(mark).font(.caption).foregroundStyle(.secondary) }
                    }
                    if cloning == r.slug {
                        Text(store.cloneProgress[server]?[r.slug] ?? "Cloning…")
                            .font(.caption).foregroundStyle(.secondary).lineLimit(1)
                    } else if let d = r.description {
                        Text(d).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                    }
                }
                if cloning == r.slug { ProgressView() }
            }
        }
        // Already a project here: nothing for Attach to do.
        .disabled(cloning != nil || here)
    }

    /// The PR panel's `MissingCli`, with a server's commands: the phone is never the machine.
    private func missingCli(_ kind: String) -> some View {
        let command = kind == "no_cli" ? "dray setup" : "gh auth login"
        return Section {
            Text(kind == "no_cli"
                 ? "Dray lists your repositories through GitHub's CLI, which is not on \(place). Run this there:"
                 : "GitHub's CLI on \(place) is not logged in. Run this there:")
            Button {
                UIPasteboard.general.string = command
            } label: {
                Label(command, systemImage: "doc.on.doc").font(.body.monospaced())
            }
            Button(loading ? "Looking…" : "Recheck") { Task { await recheck(kind) } }
                .disabled(loading)
            if stillMissing {
                Text("Still no gh — Dray looks where your login shell looks.").foregroundStyle(.secondary)
            }
        }
    }

    private func read() async {
        loading = true
        defer { loading = false }
        unavailable = nil
        do {
            repos = try await store.call(server, "github_repos")
        } catch {
            // A typed reason from gh arrives as `{"kind":…,"detail":…}`.
            let reason = (error as? DrayError).flatMap {
                try? JSONDecoder().decode([String: String].self, from: Data($0.message.utf8))
            }
            unavailable = (reason?["kind"] ?? "other", reason?["detail"] ?? error.localizedDescription)
        }
    }

    /// Logging in changes nothing about where `gh` is, so that half only asks GitHub again.
    private func recheck(_ kind: String) async {
        stillMissing = false
        guard kind == "no_cli" else { return await read() }
        let found = (try? await store.call(server, "recheck_gh", as: Bool.self)) ?? false
        if found { await read() } else { stillMissing = true }
    }

    private func clone(_ repo: GithubRepo) async {
        cloning = repo.slug
        store.cloneProgress[server]?[repo.slug] = nil
        await attach("clone_github_repo", ["slug": .string(repo.slug)])
        cloning = nil
    }

    private func attach(_ cmd: String, _ args: [String: JSON]) async {
        failure = nil
        do {
            // A clone runs as long as the repository is big; progress arrives meanwhile.
            let list: [Project] = try await store.call(server, cmd, args, timeout: .seconds(1800))
            onAttached(list)
            dismiss()
        } catch {
            failure = error.localizedDescription
        }
    }
}
