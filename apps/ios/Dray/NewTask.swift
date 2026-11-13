import SwiftUI
import ThinkingOrbs
import UIKit

// MARK: New task

extension SessionKey {
    /// The new task's draft: one for the app, so a closed dock keeps what was
    /// said and dictation has a draft to land in.
    static let newSession = SessionKey(server: UUID(uuid: (0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0)), id: "new")
}

/// The voice dock's picks and the send that starts a task on them: the desktop
/// composer's rules (`Picks`), cut to what the dock offers — agent and model,
/// effort, project, machine, worktree and stance. The last picks are the
/// defaults next time.
@MainActor @Observable
final class NewTask {
    private let store: Store
    /// A project by name, so one repo checked out on two machines is one pick.
    var projectName: String? = UserDefaults.standard.string(forKey: "new.project") {
        didSet { UserDefaults.standard.set(projectName, forKey: "new.project") }
    }
    /// One of two same-named projects on a machine, by path; `nil` where the name is enough.
    var projectPath: String?
    /// The machine picked; `nil` or one not connected takes the first holding the last project.
    var pickedServer: UUID? = UserDefaults.standard.string(forKey: "new.server").flatMap(UUID.init(uuidString:)) {
        didSet { UserDefaults.standard.set(pickedServer?.uuidString, forKey: "new.server") }
    }
    var harness = UserDefaults.standard.string(forKey: "new.harness") ?? "claude_code" {
        didSet { UserDefaults.standard.set(harness, forKey: "new.harness") }
    }
    var stance = UserDefaults.standard.string(forKey: "new.stance") ?? "auto" {
        didSet { UserDefaults.standard.set(stance, forKey: "new.stance") }
    }
    var fast = UserDefaults.standard.bool(forKey: "new.fast") {
        didSet { UserDefaults.standard.set(fast, forKey: "new.fast") }
    }
    var worktree = UserDefaults.standard.bool(forKey: "new.worktree") {
        didSet { UserDefaults.standard.set(worktree, forKey: "new.worktree") }
    }
    private var modelPicks = Prefs.map("models")
    private var effortPicks = Prefs.map("efforts")
    private(set) var modelId = ""
    private var agents: [UUID: [AgentAvailability]] = [:]
    private var models: [String: [Model]] = [:]
    /// Lists that failed to read: not cached, so asking again retries, and no
    /// longer holding Start, since an empty list lets the pick stand.
    private var modelsFailed: Set<String> = []
    /// Machines whose agents could not be read; not cached, so the next load asks again.
    private var agentsFailed: Set<UUID> = []
    private(set) var sending = false
    /// Why the last start or save failed, said under the orb.
    var failure: String?
    /// The draft this text came from, removed once it starts or is saved again.
    var draftId: (server: UUID, id: String)?

    init(store: Store) { self.store = store }

    var text: String {
        get { store.drafts[.newSession] ?? "" }
        set { store.drafts[.newSession] = newValue.isEmpty ? nil : newValue }
    }
    var hasText: Bool { !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    var connected: [Server] { store.live.filter { store.serverState[$0.id] == .connected } }

    /// The server comes first and the project is picked from what it holds, so a
    /// machine with nothing attached yet is still a place to start: it attaches one.
    var server: UUID? {
        connected.first { $0.id == pickedServer }?.id
            ?? connected.first { s in (store.projects[s.id] ?? []).contains { $0.name == projectName } }?.id
            ?? connected.first?.id
    }
    /// The picked server's projects by name, newest pick first.
    var projectNames: [String] {
        var seen = Set<String>()
        return held.sorted { $0.lastSelected > $1.lastSelected }.map(\.name).filter { seen.insert($0).inserted }
    }
    private var held: [Project] { server.flatMap { store.projects[$0] } ?? [] }
    /// The picked project where this server has it, else the one picked last here.
    var project: String? { projectName.flatMap { projectNames.contains($0) ? $0 : nil } ?? projectNames.first }
    var cwd: String? {
        let named = held.filter { $0.name == project }
        return named.first { $0.path == projectPath }?.path ?? named.first?.path
    }

    /// The project menu: a name per repo, split by folder where the server holds two of that name.
    var projectChoices: [ProjectChoice] {
        projectNames.flatMap { name -> [ProjectChoice] in
            let paths = held.filter { $0.name == name }.map(\.path)
            return paths.count > 1 ? paths.map { ProjectChoice(name: name, path: $0) } : [ProjectChoice(name: name, path: nil)]
        }
    }
    var projectChoice: ProjectChoice? {
        projectChoices.first { $0.name == project && $0.path == cwd } ?? projectChoices.first { $0.name == project && $0.path == nil }
    }

    /// A new server keeps the project by name where it has one, as the old pick did across machines.
    func pick(server: UUID?) {
        pickedServer = server
        projectPath = nil
    }

    func pick(_ choice: ProjectChoice?) {
        guard let choice else { return }
        projectName = choice.name
        projectPath = choice.path
    }

    /// Opens a saved draft with the picks it was saved on, so starting it or saving it again keeps them.
    func open(_ draft: DraftItem, on server: UUID) {
        text = draft.prompt
        draftId = (server, draft.id)
        if let name = draft.project { projectName = name }
        projectPath = draft.projectPath
        pickedServer = server
        if let h = draft.harness { harness = h }
        if let m = draft.model {
            pickModel(m)
            if let e = draft.effort { pickEffort(e) }
        }
        if let p = draft.permissionMode { stance = p }
        if let f = draft.fast { fast = f }
        if let w = draft.useWorktree { worktree = w }
    }

    private var modelsKey: String { "\(server?.uuidString ?? "")|\(harness)" }
    var list: [Model] { models[modelsKey] ?? [] }
    var model: Model? { list.first { $0.id == modelId } }
    var effort: String? { model.map { Picks.usableEffort($0, effortPicks[modelId]) } ?? effortPicks[modelId] }
    var available: [AgentAvailability] { server.flatMap { agents[$0] } ?? [] }
    private var agent: AgentAvailability? { available.first { $0.harness == harness } }
    var stanceLabel: String { Picks.stances.first { $0.0 == Picks.stanceFor(harness, stance) }?.1 ?? "Auto" }

    var ready: Bool {
        // An unread availability lets Start stand: `send_msg` refuses a missing agent itself, in words.
        !sending && hasText && cwd != nil && (agent?.available == true || server.map(agentsFailed.contains) == true)
            && (models[modelsKey] != nil || modelsFailed.contains(modelsKey))
    }

    func pickModel(_ id: String) {
        modelId = id
        modelPicks[harness] = id
        Prefs.set(modelPicks, "models")
    }

    func pickEffort(_ level: String) {
        effortPicks[modelId] = level
        Prefs.set(effortPicks, "efforts")
    }

    /// What the picks need from the machine they point at: its agents and
    /// this agent's models. Read once per machine and agent.
    func load() async {
        guard let server else { return }
        if agents[server] == nil {
            if let read: [AgentAvailability] = try? await store.call(server, "agent_availability") {
                agents[server] = read
                agentsFailed.remove(server)
            } else {
                agentsFailed.insert(server)
            }
        }
        // A machine without the remembered agent starts on one it has; with only one, no picker shows to fix it.
        // Only while that machine is still the pick: a late answer for another must not move this one's agent.
        if server == self.server, let held = agents[server], !held.contains(where: { $0.harness == harness && $0.available }),
           let first = held.first(where: \.available) {
            harness = first.harness
        }
        // Taken before the read: the picks can move to another machine while it is out.
        let harness = harness
        let key = "\(server.uuidString)|\(harness)"
        if models[key] == nil {
            do {
                models[key] = try await store.call(server, "list_models", ["harness": .string(harness)])
                modelsFailed.remove(key)
            } catch {
                modelsFailed.insert(key)
            }
        }
        // At once on the list landing: the old agent's model must never go out under the new agent's name.
        if key == modelsKey { modelId = Picks.usableModel(list, modelPicks[harness] ?? Picks.defaultModel[harness] ?? "", harness) }
    }

    /// The argument set `useSessions.ts` sends for a new session, with the
    /// stance and fast mode narrowed to what this agent and model honour.
    func start() async -> SessionKey? {
        guard let server, let cwd, ready else { return nil }
        sending = true
        failure = nil
        defer { sending = false }
        let opened = draftId
        let id = UUID().uuidString.lowercased()
        let sent = text
        do {
            let outcome: SendOutcome = try await store.call(server, "send_msg", [
                "sessionId": .string(id),
                "prompt": .string(sent),
                "attachmentPaths": [],
                "harness": .string(harness),
                "model": .string(modelId),
                "effort": JSON(effort),
                "permissionMode": .string(Picks.stanceFor(harness, stance)),
                "fast": .bool(fast && Picks.offersFast(harness, model)),
                "cwd": .string(cwd),
                "branch": nil,
                "useWorktree": .bool(worktree),
                "worktreeName": nil,
                "baseRef": nil,
                "isNewSession": true,
            ])
            if let item = outcome.snapshot { store.created(server, item) }
            await dropDraft(opened)
            // Words added while the start was out were never sent, so they stay.
            if text == sent { text = "" }
            Haptic.success()
            return SessionKey(server: server, id: id)
        } catch {
            failure = error.localizedDescription
            Haptic.error()
            return nil
        }
    }

    /// Saves the text as a draft in Dray's sidebar, on these picks, and clears it.
    func saveDraft() async -> Bool {
        guard !sending else { return false }
        guard let server, let cwd, hasText else {
            failure = "Pick a project first."
            return false
        }
        sending = true
        defer { sending = false }
        let saved = text
        let opened = draftId
        let draft: [String: JSON] = [
            "id": .string(UUID().uuidString.lowercased()),
            "prompt": .string(saved),
            "created": .string(Date().formatted(.iso8601)),
            "projectPath": .string(cwd),
            "harness": .string(harness),
            "model": .string(modelId),
            "effort": JSON(effort),
            "permissionMode": .string(Picks.stanceFor(harness, stance)),
            "fast": .bool(fast && Picks.offersFast(harness, model)),
            "useWorktree": .bool(worktree),
        ]
        do {
            let _: JSON = try await store.call(server, "create_draft", ["draft": .object(draft)])
        } catch {
            failure = error.localizedDescription
            return false
        }
        await dropDraft(opened)
        if text == saved { text = "" }
        return true
    }

    /// Lets go of the text without saving it.
    func discard() {
        text = ""
        draftId = nil
        failure = nil
    }

    /// The draft a start or save began from goes once its text has gone somewhere else —
    /// that one, taken before the request, never whichever is open by the time it answers.
    private func dropDraft(_ d: (server: UUID, id: String)?) async {
        guard let d else { return }
        if draftId?.server == d.server && draftId?.id == d.id { draftId = nil }
        _ = try? await store.call(d.server, "delete_draft", ["id": .string(d.id)], as: JSON.self)
        store.draftsRevision += 1
    }
}

/// One entry in the dock's project menu.
struct ProjectChoice: Hashable {
    let name: String
    /// Set only where the server holds two projects of this name.
    let path: String?

    var label: String { path.map { "\(name) — \((($0 as NSString).deletingLastPathComponent as NSString).lastPathComponent)" } ?? name }
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
                Text(sentence(u.detail ?? "Couldn't read repositories.")).foregroundStyle(Theme.destructive)
            } else if repos == nil {
                Label { Text("Reading your repositories…") } icon: { Orb(.loading) }
                    .foregroundStyle(Theme.secondary)
            } else if shown.isEmpty {
                Text(repos!.isEmpty ? "No repositories." : "No repository matches.").foregroundStyle(Theme.secondary)
            } else {
                Section {
                    ForEach(shown, id: \.slug) { row($0) }
                } footer: {
                    Text("Repositories not on \(place) yet clone into ~/dray there.")
                        .font(Theme.Font.footnote).foregroundStyle(Theme.tertiary)
                }
            }
            if let failure {
                Text(sentence(failure)).foregroundStyle(Theme.destructive)
            }
        }
        .themedList()
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
                        if let mark { Text(mark).font(Theme.Font.footnote).foregroundStyle(.secondary) }
                    }
                    if cloning == r.slug {
                        Text(store.cloneProgress[server]?[r.slug] ?? "Cloning…")
                            .font(Theme.Font.footnote).foregroundStyle(.secondary).lineLimit(1)
                    } else if let d = r.description {
                        Text(d).font(Theme.Font.footnote).foregroundStyle(.secondary).lineLimit(2)
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
                Label(command, systemImage: "doc.on.doc").font(Theme.Font.body)
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
