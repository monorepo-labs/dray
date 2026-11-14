import CryptoKit
import Foundation
import Network
import Observation
import Security

struct Server: Codable, Identifiable, Hashable {
    let id: UUID
    var name: String
    var url: String
    /// The phone's own switch: off, it neither connects nor shows the server's tasks. Never sent.
    var on = true
    /// Set on a machine reached through a paired server that shares its list
    /// (#847). Never saved: it comes and goes with that server's answer.
    var via: Via?
}

/// A relayed server's way in: the paired server it goes through, whose token
/// it uses, and its id in that server's list.
struct Via: Codable, Hashable {
    let parent: UUID
    let machine: String
}

extension Server {
    /// Lenient on `on`, since every server saved before it existed has none.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(UUID.self, forKey: .id)
        name = try c.decode(String.self, forKey: .name)
        url = try c.decode(String.self, forKey: .url)
        on = try c.decodeIfPresent(Bool.self, forKey: .on) ?? true
    }
}

/// A relayed machine's id, the same on every launch so its transcripts and
/// Settings row survive a reconnect: hashed from the server it goes through.
private func relayedId(_ parent: UUID, _ machine: String) -> UUID {
    let digest = Array(SHA256.hash(data: Data("\(parent.uuidString)/\(machine)".utf8)))
    return UUID(uuid: digest.withUnsafeBytes { $0.load(as: uuid_t.self) })
}

/// A session is named by its server and its id; nothing on the wire carries
/// the server, so the connection a frame arrived on is the answer.
struct SessionKey: Hashable {
    let server: UUID
    let id: String
}

/// One folder however it was written: a bot's path and its chat's cwd differ by a trailing slash at most.
func samePath(_ a: String, _ b: String) -> Bool {
    a.trimmingCharacters(in: CharacterSet(charactersIn: "/")) == b.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
}

/// Every server's sessions, merged, and what the phone holds about each.
@MainActor @Observable
final class Store {
    private(set) var servers: [Server] = []
    private(set) var serverState: [UUID: Connection.State] = [:]
    private(set) var items: [SessionKey: SessionItem] = [:] { didSet { keepList() } }
    private(set) var transcripts: [SessionKey: Transcript] = [:]
    private(set) var asks: [SessionKey: [AgentEvent]] = [:] { didSet { asksChanged() } }
    private(set) var queued: [SessionKey: [Queued]] = [:]
    /// Counts the phone's own sends per session: a send brings its chat back to the bottom.
    private(set) var sends: [SessionKey: Int] = [:]
    private(set) var boatAlerts: [BoatAlert] = [] { didSet { boatChanged() } }
    private(set) var projects: [UUID: [Project]] = [:] { didSet { keepList() } }
    /// Each repo's PR marks by branch, as `pr_marks` last answered.
    private(set) var marks: [ProjectKey: [String: PrMark]] = [:]
    var drafts: [SessionKey: String] = [:]
    /// A bot chat's agent and model for its next message, picked in its sheet: the desktop's
    /// `unsentPicks`. Another agent moves the chat to a new session on that send.
    var unsent: [SessionKey: AgentPick] = [:]
    /// The session an agent switch from a chat goes to, minted once and kept until it lands.
    private var switches: [SessionKey: SessionKey] = [:]
    /// gh's latest progress line per clone, by server and slug.
    var cloneProgress: [UUID: [String: String]] = [:]
    /// Moves when any client saves a draft (`drafts_changed`) or this one removes one: the list re-reads.
    var draftsRevision = 0
    var lastError: String?
    /// False while the device has no network at all, which every server shares.
    private(set) var online = true
    /// A server that connected and then failed to read its sessions, by server.
    private(set) var loadErrors: [UUID: String] = [:]
    /// A transcript that could not be read with nothing of it held yet.
    private(set) var transcriptErrors: [SessionKey: String] = [:]
    /// Transcripts the server has answered for since they were held, not just the cache.
    private(set) var serverRead: Set<SessionKey> = []
    /// An older page that could not be read; the newer turns stay on screen.
    private(set) var olderErrors: [SessionKey: String] = [:]
    private(set) var tasks: [SessionKey: Int] = [:]
    /// Each server's bots: any server can hold them (#887).
    private(set) var bots: [UUID: [Bot]] = [:] { didSet { keepList() } }
    /// Servers whose index was read since this launch: before that, an empty list
    /// is one not read yet, never "No tasks yet".
    private(set) var listed: Set<UUID> = []
    /// Servers down long enough to say so (`lostAfter`), or refused outright.
    /// A quick drop — the app back from the background, a blip — says nothing.
    private(set) var lost: Set<UUID> = []

    /// For a client that reacts beside drawing: the Island chimes and counts a new card on its pill.
    @ObservationIgnored var asksChanged: () -> Void = {}
    /// The Island's: its own server came up, or Dray's window came or went, so
    /// the machines it follows may have moved.
    @ObservationIgnored var linksMayHaveMoved: () -> Void = {}
    /// The Island's This Mac; the phone has none.
    @ObservationIgnored private var home: UUID?
    @ObservationIgnored var boatChanged: () -> Void = {}
    @ObservationIgnored private let path = NWPathMonitor()
    @ObservationIgnored private var reading: Set<UUID> = []
    @ObservationIgnored private var statuses: [SessionKey: StatusEvent] = [:]
    @ObservationIgnored private var connections: [UUID: Connection] = [:]
    @ObservationIgnored private var marksAt: [ProjectKey: Date] = [:]
    @ObservationIgnored private var marking: Set<ProjectKey> = []
    /// `dropTranscripts` calls so far, and the session the last one kept, so a read out across a drop knows.
    @ObservationIgnored private var drops = 0
    @ObservationIgnored private var kept: SessionKey?
    @ObservationIgnored private var downSince: [UUID: Date] = [:]
    /// Transcripts opened while their server was down, read once it connects.
    @ObservationIgnored private var waiting: Set<SessionKey> = []
    @ObservationIgnored private var listSaving = false

    init() {
        if let data = UserDefaults.standard.data(forKey: "servers"),
           let saved = try? JSONDecoder().decode([Server].self, from: data) {
            servers = saved
        }
        for s in servers where s.on { start(s) }
        watchNetwork()
    }

    /// One server, read through `read` at every connect rather than the
    /// Keychain — the Island's This Mac, whose port and token are files.
    init(local s: Server, read: @escaping () -> (url: String, token: String)?) {
        servers = [s]
        home = s.id
        start(s, read: read, client: "island")
        watchNetwork()
    }

    /// The network coming back retries every server at once, rather than each
    /// sitting out the rest of its backoff.
    private func watchNetwork() {
        #if DEBUG
        // The UI test's way to draw offline: the simulator only follows the Mac's network.
        if ProcessInfo.processInfo.arguments.contains("-offline") { return online = false }
        #endif
        path.pathUpdateHandler = { [weak self] p in
            Task { @MainActor in
                guard let self else { return }
                let now = p.status == .satisfied
                if now && !self.online { self.resume(now: true) }
                self.online = now
            }
        }
        path.start(queue: .main)
    }

    // MARK: Servers

    func addServer(name: String, url: String, token: String) {
        let s = Server(id: UUID(), name: name, url: url)
        Keychain.set(token, for: s.id.uuidString)
        servers.append(s)
        save()
        start(s)
    }

    func removeServer(_ s: Server) {
        forget(s.id)
        Keychain.delete(s.id.uuidString)
        save()
    }

    /// The servers that are on, which is every one the list, Run with and banners reason about.
    var live: [Server] { servers.filter(\.on) }

    /// Off drops the connection and all held of it, so its tasks, cards and banners go;
    /// on connects afresh and reads everything again.
    func setServerOn(_ id: UUID, _ on: Bool) {
        guard let i = servers.firstIndex(where: { $0.id == id }), servers[i].on != on else { return }
        servers[i].on = on
        save()
        if on { start(servers[i]) } else { drop(id) }
    }

    private func forget(_ id: UUID) {
        let gone = Set([id] + servers.filter { $0.via?.parent == id }.map(\.id))
        drop(id)
        for key in transcripts.keys where gone.contains(key.server) { transcripts[key] = nil }
        serverRead = serverRead.filter { !gone.contains($0.server) }
        servers.removeAll { $0.id == id }
        for server in gone { try? FileManager.default.removeItem(at: Cache.folder(server)) }
    }

    /// Transcripts stay: a session left open across off and on is reloaded by `connected`,
    /// which finds it only through them, and its view never asks again.
    private func drop(_ id: UUID) {
        // Off, not forgotten: transcripts stay for `connected` to reload once
        // the paired server shares them again under the same ids.
        for s in servers where s.via?.parent == id {
            drop(s.id)
            servers.removeAll { $0.id == s.id }
        }
        connections.removeValue(forKey: id)?.stop()
        serverState[id] = nil
        for key in items.keys where key.server == id { items[key] = nil }
        for key in asks.keys where key.server == id { asks[key] = nil }
        for key in marks.keys where key.server == id { marks[key] = nil }
        // Or a reconnect inside the poll's gap skips the read that would bring them back.
        for key in marksAt.keys where key.server == id { marksAt[key] = nil }
        for key in tasks.keys where key.server == id { tasks[key] = nil }
        for key in queued.keys where key.server == id { queued[key] = nil }
        projects[id] = nil
        bots[id] = nil
        loadErrors[id] = nil
        listed.remove(id)
        lost.remove(id)
        downSince[id] = nil
    }

    /// The Island's machines beyond This Mac, as Dray's window last listed them:
    /// nothing saved, since the window is the list. A login that moved its port
    /// or token reconnects and keeps what is held.
    func follow(_ links: [(server: Server, url: String, token: String)]) {
        for s in servers where s.id != home && !links.contains(where: { $0.server.id == s.id }) { forget(s.id) }
        for link in links {
            let s = link.server
            if let i = servers.firstIndex(where: { $0.id == s.id }) { servers[i].name = s.name } else { servers.append(s) }
            if let held = connections[s.id], held.url == link.url, held.token == link.token { continue }
            connections[s.id]?.stop()
            start(s, read: { (link.url, link.token) })
        }
    }

    /// The name a remote machine goes by beside a title. This Mac has none, which is what says local.
    func machine(_ server: UUID) -> String? {
        server == home ? nil : name(of: server)
    }

    func renameServer(_ id: UUID, to name: String) {
        guard let i = servers.firstIndex(where: { $0.id == id }) else { return }
        servers[i].name = name
        save()
    }

    /// A new token for a server whose old one was refused, tried at once.
    func updateToken(_ id: UUID, _ token: String) {
        Keychain.set(token, for: id.uuidString)
        connections[id]?.update(token: token)
        for s in servers where s.via?.parent == id { connections[s.id]?.update(token: token) }
    }

    func connection(_ server: UUID) -> Connection? { connections[server] }

    func name(of server: UUID) -> String {
        servers.first { $0.id == server }?.name ?? "Server"
    }

    /// iOS drops sockets once the app leaves the screen; coming back reconnects.
    /// `now` also asks servers that stopped, as a Retry does.
    func resume(now: Bool = false) {
        // Back from the background every socket is down; each gets a fresh grace
        // to come up before anything says it is lost.
        for (id, state) in serverState where state != .connected {
            if case .failed = state { continue }
            lost.remove(id)
            downSince[id] = nil
            track(id, state)
        }
        for c in connections.values { now ? c.retryNow() : c.resume() }
    }

    /// How long a server may stay down before a session on it says so.
    private static let lostAfter: Duration = .seconds(10)

    private func track(_ id: UUID, _ state: Connection.State) {
        switch state {
        case .connected:
            downSince[id] = nil
            lost.remove(id)
        case .failed:
            // Waiting cannot fix a refused token or a version apart.
            lost.insert(id)
        case .connecting, .waiting:
            guard downSince[id] == nil else { return }
            let since = Date()
            downSince[id] = since
            Task {
                try? await Task.sleep(for: Self.lostAfter)
                if downSince[id] == since { lost.insert(id) }
            }
        }
    }

    /// One server's Retry: reconnect where it is down, re-read where it is up.
    func retry(_ server: UUID) async {
        if serverState[server] == .connected {
            await loadIndex(server)
        } else {
            connections[server]?.retryNow()
        }
    }

    func refresh() async {
        for s in servers where serverState[s.id] == .connected {
            await loadShared(s.id)
            await loadIndex(s.id)
            await loadProjects(s.id)
            await loadMarks(s.id, force: true)
        }
    }

    /// A command on one server, for a screen reading what the store does not hold.
    func call<T: Decodable>(_ server: UUID, _ cmd: String, _ args: [String: JSON] = [:], as: T.Type = T.self,
                            timeout: Duration = .seconds(60)) async throws -> T {
        guard let c = connections[server] else { throw DrayError("Not connected") }
        return try await c.call(cmd, args, timeout: timeout)
    }

    /// A session this phone just created, from the entry `send_msg` answered with.
    func created(_ server: UUID, _ item: SessionItem) {
        store(SessionKey(server: server, id: item.sessionId), item)
        Task { await loadMarks(server, force: false, only: [item.projectPath]) }
    }

    private func save() {
        UserDefaults.standard.set(try? JSONEncoder().encode(servers.filter { $0.via == nil }), forKey: "servers")
    }

    /// Brings `parent`'s relayed servers in line with what it shares. The Island
    /// follows the app's links instead, which already name these machines.
    private func share(_ parent: UUID, _ machines: [Sharing.Machine]) {
        guard home == nil, let p = servers.first(where: { $0.id == parent }), p.via == nil else { return }
        for s in servers where s.via?.parent == parent && !machines.contains(where: { $0.id == s.via?.machine }) { forget(s.id) }
        for m in machines {
            let id = relayedId(parent, m.id)
            if let i = servers.firstIndex(where: { $0.id == id }) {
                servers[i].name = m.name
                continue
            }
            let s = Server(id: id, name: m.name, url: p.url, via: Via(parent: parent, machine: m.id))
            // Listed under the server it goes through.
            let after = servers.lastIndex { $0.id == parent || $0.via?.parent == parent } ?? servers.count - 1
            servers.insert(s, at: after + 1)
            start(s)
        }
    }

    private func loadShared(_ server: UUID) async {
        guard home == nil, servers.first(where: { $0.id == server })?.via == nil else { return }
        // A server from before sharing answers `unknown command`, and shares nothing.
        guard let sharing: Sharing = try? await connections[server]?.call("share_machines") else { return }
        share(server, sharing.machines)
    }

    private func start(_ s: Server, read: (() -> (url: String, token: String)?)? = nil, client: String? = nil) {
        // No token saved connects anyway: the server refuses it, which draws as
        // a refused token, and that state is where a new one is pasted.
        let token = read?()?.token ?? Keychain.get((s.via?.parent ?? s.id).uuidString) ?? ""
        let c = Connection(serverId: s.id, url: s.url, token: token)
        c.refresh = read
        c.client = client
        c.via = s.via?.machine
        c.onState = { [weak self] state in
            guard let self else { return }
            serverState[s.id] = state
            track(s.id, state)
            if state == .connected { Task { await self.connected(s.id) } }
        }
        c.onEvent = { [weak self] name, data in self?.handle(s.id, name, data) }
        connections[s.id] = c
        restoreList(s.id)
        c.resume()
    }

    // MARK: Cache

    /// What the list last held of a server, so a cold open draws it before any socket is up.
    private struct CachedList: Codable {
        var items: [SessionItem]
        var projects: [Project]
        var bots: [Bot]
        var previews: [String: BotPreview]?
    }

    /// The phone's alone: the Island reads This Mac, which answers before a cache would.
    private func restoreList(_ id: UUID) {
        guard home == nil, !items.keys.contains(where: { $0.server == id }),
              let data = try? Data(contentsOf: Cache.list(id)),
              let held = try? JSONDecoder().decode(CachedList.self, from: data) else { return }
        for item in held.items { items[SessionKey(server: id, id: item.sessionId)] = item }
        projects[id] = held.projects
        bots[id] = held.bots
        for (sid, p) in held.previews ?? [:] { previews[SessionKey(server: id, id: sid)] = p }
    }

    /// Writes every live server's list a moment after the last change, off the main thread.
    private func keepList() {
        guard home == nil, !listSaving else { return }
        listSaving = true
        Task {
            try? await Task.sleep(for: .seconds(2))
            listSaving = false
            for s in live {
                // Only what a read answered: a server not reached yet keeps its file as it was.
                guard listed.contains(s.id) else { continue }
                let held = CachedList(items: items.filter { $0.key.server == s.id && $0.value.archived != true }.map(\.value),
                                      projects: projects[s.id] ?? [], bots: bots[s.id] ?? [],
                                      previews: Dictionary(uniqueKeysWithValues: previews.filter { $0.key.server == s.id }.map { ($0.key.id, $0.value) }))
                Cache.write(Cache.list(s.id)) { try JSONEncoder().encode(held) }
            }
        }
    }

    /// A transcript as its last read left it, decoded off the main thread.
    private func cachedSnapshot(_ key: SessionKey) async -> Snapshot? {
        guard home == nil else { return nil }
        let url = Cache.transcript(key)
        return await Task.detached(priority: .userInitiated) {
            guard let data = try? Data(contentsOf: url) else { return nil }
            return (try? JSONDecoder().decode(Reply<Snapshot?>.self, from: data))?.ok ?? nil
        }.value
    }

    /// A fresh connection re-reads the index and the tail of every open
    /// transcript, so nothing that happened while it was down is missed.
    private func connected(_ server: UUID) async {
        if server == home { linksMayHaveMoved() }
        Task { await loadBots(server) }
        // Its own task: a sandbox's sessions need not wait on this server's.
        Task { await loadShared(server) }
        // Heard on the old socket, so older than the read below — and a read
        // never moves `modified`, so a stale `completed` would win the tie.
        for key in statuses.keys where key.server == server { statuses[key] = nil }
        await loadIndex(server)
        Task { await loadPreviews(server) }
        // A failed first read holds no transcript, so its error is what remembers it.
        let opened = waiting.filter { $0.server == server }
        waiting.subtract(opened)
        for key in Set(transcripts.keys).union(transcriptErrors.keys).union(opened) where key.server == server { await reload(key) }
        // After the transcripts: a mark costs a `gh` call per repo, missed messages must not wait on it.
        await loadProjects(server)
        await loadMarks(server, force: false)
    }

    func loadBots(_ server: UUID) async {
        // A server from before bots answers `unknown command`, and holds none.
        guard let list: [Bot] = try? await connections[server]?.call("list_bots") else { return }
        bots[server] = list
        await loadPreviews(server)
    }

    /// The bot whose chat this session is: one running in its folder.
    func bot(_ key: SessionKey) -> Bot? {
        guard let cwd = items[key]?.cwd else { return nil }
        return bots[key.server]?.first { samePath($0.path, cwd) }
    }

    /// Every live server's bots, in its own order, servers in the list's.
    var allBots: [(server: UUID, bot: Bot)] {
        live.flatMap { s in (bots[s.id] ?? []).map { (s.id, $0) } }
    }

    /// A bot's chat: every unsettled session in its folder, oldest first. The
    /// newest is the one a reply goes to; an agent switch leaves the older ones (`botChat`).
    func botChat(_ server: UUID, _ bot: Bot) -> [SessionKey] {
        items.filter { $0.key.server == server && $0.value.archived != true && samePath($0.value.cwd, bot.path) }
            .sorted { ($0.value.created ?? $0.value.modified) < ($1.value.created ?? $1.value.modified) }
            .map(\.key)
    }

    /// A bot's tasks at any depth under any of its chat's sessions, newest
    /// created first at each level; settled ones drop, and a sub-task of one
    /// hangs under the session that adopted it (`crewRows`).
    /// Every live server's, since `--machine` puts a task on another one, which
    /// still names the bot's session as its parent; ids are UUIDs, so they join across servers.
    func botTasks(_ chat: [SessionKey]) -> [SessionKey] {
        // One copy per id: a machine paired directly and shared too lists a task twice,
        // and the one to open is the one whose connection is up.
        var copies: [String: (key: SessionKey, item: SessionItem)] = [:]
        for (key, item) in items where item.archived != true && item.parentSessionId.map({ $0 != item.sessionId }) == true {
            if let held = copies[item.sessionId], serverState[held.key.server] == .connected { continue }
            copies[item.sessionId] = (key, item)
        }
        let live = Set(items.filter { $0.value.archived != true }.map(\.key.id))
        var kids: [String: [(key: SessionKey, item: SessionItem)]] = [:]
        for copy in copies.values {
            let parent = copy.item.parentSessionId
            if let p = parent.flatMap({ live.contains($0) ? $0 : nil }) ?? copy.item.adoptedBy ?? parent {
                kids[p, default: []].append(copy)
            }
        }
        var out: [SessionKey] = []
        var seen = Set(chat.map(\.id))
        func walk(_ ids: [String]) {
            let level = ids.flatMap { kids[$0] ?? [] }.sorted { ($0.item.created ?? $0.item.modified) > ($1.item.created ?? $1.item.modified) }
            for kid in level where seen.insert(kid.item.sessionId).inserted {
                out.append(kid.key)
                walk([kid.item.sessionId])
            }
        }
        walk(chat.reversed().map(\.id))
        return out
    }

    /// Each bot chat's newest reply and unread count, read off the log's end by its server.
    private(set) var previews: [SessionKey: BotPreview] = [:] { didSet { keepList() } }

    func loadPreviews(_ server: UUID) async {
        let chats = (bots[server] ?? []).compactMap { botChat(server, $0).last }
        guard !chats.isEmpty,
              let read: [String: BotPreview] = try? await call(server, "bot_previews", ["sessionIds": .array(chats.map { .string($0.id) })])
        else { return }
        for (id, p) in read { previews[SessionKey(server: server, id: id)] = p }
    }

    /// Reads a repo's PR marks if none are held, for a merge card on a repo no row lists.
    func ensureMarks(_ server: UUID, _ path: String) async {
        await loadMarks(server, force: false, only: [path])
    }

    /// Whether a repo's marks have been read at all: a PR missing from them then is one GitHub no longer lists.
    func marksRead(_ server: UUID, _ path: String) -> Bool { marks[ProjectKey(server: server, path: path)] != nil }

    private struct WorktreeDisposition: Decodable {
        let exists: Bool
        let changedFiles: Int
        let unpushedCommits: Int
    }

    /// Lands a bot task's PR the desktop's way (`mergeTask`): merge, then settle
    /// the task and remove its worktree where nothing in it would be lost. A task
    /// mid-turn, or one whose branch moved on, keeps both.
    func mergeTask(_ server: UUID, taskId: String, cwd: String, number: Int, branch: String, method: String) async -> Bool {
        do {
            let _: JSON = try await call(server, "merge_pr", ["cwd": .string(cwd), "number": JSON(number), "method": .string(method)],
                                         timeout: .seconds(120))
        } catch {
            lastError = error.localizedDescription
            return false
        }
        await loadMarks(server, force: true, only: [cwd])
        let key = SessionKey(server: server, id: taskId)
        guard let item = items[key], item.archived != true, !item.busy,
              sessionBranch(branch: item.branch, worktreeName: item.worktreeName,
                            worktreeRemoved: item.worktreeRemoved ?? false, observed: nil) == branch else { return true }
        _ = try? await call(server, "set_session_flags", ["sessionId": .string(taskId), "archived": true], as: JSON.self)
        if item.worktreeName != nil, item.worktreeRemoved != true,
           let d: WorktreeDisposition = try? await call(server, "worktree_disposition", ["sessionId": .string(taskId)]),
           !d.exists || (d.changedFiles == 0 && d.unpushedCommits == 0) {
            _ = try? await call(server, "remove_session_worktree", ["sessionId": .string(taskId)], as: JSON.self)
        }
        return true
    }

    /// A project list a command answered with, such as `add_project`'s.
    func attached(_ server: UUID, _ list: [Project]) { projects[server] = list }

    private func loadProjects(_ server: UUID) async {
        if let list: [Project] = try? await connections[server]?.call("list_projects", [:]) { projects[server] = list }
    }

    // MARK: PR marks

    /// The repos the list draws sessions from on one server.
    private func repos(_ server: UUID) -> Set<String> {
        Set(items.filter { $0.key.server == server && $0.value.hidden != true && $0.value.archived != true }.map(\.value.projectPath))
    }

    /// One `pr_marks` per repo, the desktop's `usePrMarks`: fresh for two
    /// minutes unless forced. A failed read changes nothing — no `gh`, no
    /// GitHub remote, logged out — and the last good marks stay on screen.
    private func loadMarks(_ server: UUID, force: Bool, only: Set<String>? = nil) async {
        guard let c = connections[server] else { return }
        for path in only ?? repos(server) {
            let key = ProjectKey(server: server, path: path)
            // ponytail: a forced read landing on one in flight is dropped, not queued
            // behind it as the desktop does; the next poll or turn end catches up.
            if marking.contains(key) { continue }
            if !force, let at = marksAt[key], Date().timeIntervalSince(at) < 120 { continue }
            marking.insert(key)
            defer { marking.remove(key) }
            guard let list: [PrMark] = try? await c.call("pr_marks", ["cwd": .string(path)]) else { continue }
            marks[key] = Dictionary(grouping: list, by: \.headRefName).compactMapValues(pickMark)
            marksAt[key] = Date()
        }
    }

    /// Re-reads every repo holding an open PR — the only mark that changes on
    /// its own, as checks report or someone merges. Called every 30s while the
    /// app is on screen, and once on coming back.
    func pollMarks() async {
        for s in servers where serverState[s.id] == .connected {
            // Every repo whose marks are held, not the list's alone: a bot's tasks are hidden,
            // and their merge cards read marks the list never asks for (`ensureMarks`).
            let open = Set(marks.keys.filter { $0.server == s.id }.map(\.path)).filter { path in
                let key = ProjectKey(server: s.id, path: path)
                return marks[key]?.values.contains { $0.state == "OPEN" } == true
                    && Date().timeIntervalSince(marksAt[key] ?? .distantPast) >= 30
            }
            if !open.isEmpty { await loadMarks(s.id, force: true, only: open) }
        }
    }

    func prMark(_ key: SessionKey, _ item: SessionItem) -> PrMark? {
        // The sidebar's guess: no observed HEAD, which would cost a spawn per row.
        sessionBranch(branch: item.branch, worktreeName: item.worktreeName, worktreeRemoved: item.worktreeRemoved ?? false, observed: nil)
            .flatMap { marks[ProjectKey(server: key.server, path: item.projectPath)]?[$0] }
    }

    private func loadIndex(_ server: UUID) async {
        guard let c = connections[server] else { return }
        do {
            let list: [SessionItem] = try await c.call("list_session_index_items", ["archived": false])
            // Settled rows are the settled view's to replace; this read never holds them.
            // Built apart and written once, so the list redraws once rather than per row.
            var next = items.filter { $0.key.server != server || $0.value.archived == true }
            for item in list {
                let key = SessionKey(server: server, id: item.sessionId)
                next[key] = merged(key, item)
            }
            items = next
            loadErrors[server] = nil
            listed.insert(server)
        } catch {
            // The rows already listed stay; the list says this read failed beside them.
            loadErrors[server] = error.localizedDescription
        }
    }

    /// Settled sessions, read only when the settled view asks: the live read
    /// leaves them out, and its next pass clears them again.
    func loadSettled() async {
        for s in servers where serverState[s.id] == .connected {
            // Rows held before the read; one the reply leaves out was deleted, unless an event
            // moved it meanwhile. Unsettling leaves `modified` alone, so `archived` is read again too.
            let held = items.filter { $0.key.server == s.id && $0.value.archived == true }.mapValues(\.modified)
            guard let list: [SessionItem] = try? await call(s.id, "list_session_index_items", ["archived": true]) else { continue }
            let listed = Set(list.map(\.sessionId))
            for (key, modified) in held where !listed.contains(key.id) {
                if let now = items[key], now.archived == true, now.modified == modified { items[key] = nil }
            }
            for item in list { store(SessionKey(server: s.id, id: item.sessionId), item) }
        }
    }

    /// Writes an entry read off the index. A status event that arrived while
    /// the read was out is newer than it, so it wins.
    private func store(_ key: SessionKey, _ read: SessionItem) {
        items[key] = merged(key, read)
    }

    private func merged(_ key: SessionKey, _ read: SessionItem) -> SessionItem {
        var item = read
        if let s = statuses[key], let m = s.modified, m >= item.modified {
            item.status = s.status
            item.modified = m
        }
        return item
    }

    // MARK: Sessions

    /// What the list draws, in the desktop sidebar's runs: the live sessions,
    /// or the settled ones, narrowed to one project by name when one is picked —
    /// by name, so a repo checked out on two machines is one project.
    func runs(project: String?, settled: Bool = false) -> [(stage: Stage, rows: [ListRow])] {
        // A bot's chat is its row in the Bots section, never a task row.
        let chats = Dictionary(uniqueKeysWithValues: bots.map { ($0.key, $0.value.map(\.path)) })
        let list = items.filter { key, item in
            item.hidden != true && (item.archived == true) == settled
                && (project.map { $0 == item.project } ?? true)
                && !(settled == false && (chats[key.server] ?? []).contains { samePath($0, item.cwd) })
        }.map { (key: $0.key, item: $0.value) }
        return stageRuns(list) { stage($0.key, $0.item) }
    }

    /// The desktop's `sessionState`: a merged PR holds its session whatever
    /// the turn says, and running checks outrank the PR being open.
    private func stage(_ key: SessionKey, _ item: SessionItem) -> Stage {
        if isAsking(key) { return .asking }
        let mark = prMark(key, item)
        let open = mark?.state == "OPEN" ? mark : nil
        if open == nil && mark?.state == "MERGED" { return .merged }
        if item.status == "completed" { return open == nil ? .completed : .unreadPr }
        guard let open else { return .idle }
        return open.checksState == "RUNNING" ? .checks : .pr
    }

    func isAsking(_ key: SessionKey) -> Bool { !(asks[key]?.isEmpty ?? true) }

    func open(_ key: SessionKey) async {
        await load(key)
        if items[key]?.status == "completed" {
            items[key]?.status = "idle"
            _ = try? await connections[key.server]?.call("mark_session_read", ["sessionId": .string(key.id), "read": true], as: JSON.self)
        }
    }

    /// Lets go of every transcript held but `kept`'s. The Island's close: held, each
    /// grew by every event its session sent, and a day of them stayed in memory.
    func dropTranscripts(keeping kept: SessionKey?) {
        transcripts = transcripts.filter { $0.key == kept }
        serverRead = serverRead.filter { $0 == kept }
        transcriptErrors = [:]
        olderErrors = [:]
        drops += 1
        self.kept = kept
    }

    /// Starts following a transcript without marking the session read.
    /// What was read last time draws at once, and the read lays the newest turns over it.
    func load(_ key: SessionKey) async {
        guard transcripts[key] == nil else { return }
        if let held = await cachedSnapshot(key), transcripts[key] == nil {
            var t = Transcript(olderBefore: held.olderBefore)
            for e in held.events { t.append(e) }
            transcripts[key] = t
        }
        // Down, the connect reads it: a read now only fails, and says so under what the cache drew.
        guard serverState[key.server] == .connected else {
            waiting.insert(key)
            return
        }
        await reload(key)
    }

    /// Whether a transcript read is out with nothing held to show: the skeleton's cue.
    func isLoading(_ key: SessionKey) -> Bool { transcripts[key] == nil && transcriptErrors[key] == nil }

    /// A transcript's Retry. Disconnected, the error stays until the connect
    /// re-reads it, since a key with nothing held is reloaded through that error.
    func retryLoad(_ key: SessionKey) async {
        if serverState[key.server] == .connected { await reload(key) } else { connections[key.server]?.retryNow() }
    }

    /// Re-reads the newest turns and lays them over what is held: older pages
    /// the read starts inside are kept, the read's own events follow in log
    /// order, and anything that arrived live while it was out goes last.
    /// Matched on id, since a subagent restarts `seq`.
    private func reload(_ key: SessionKey) async {
        guard let c = connections[key.server] else { return }
        let before = transcripts[key]?.ids ?? []
        let drop = drops
        do {
            let raw = try await c.callRaw("get_session_by_id", ["sessionId": .string(key.id), "turns": 8])
            let snap = try await decodeReply(raw, as: Snapshot?.self)
            if snap != nil, home == nil { Cache.write(Cache.transcript(key)) { raw } }
            // Dropped while the read was out: writing it back would hold it, growing, until the next drop.
            guard drop == drops || key == kept else { return }
            // Deleted from another client. Said, or the transcript waits on a read that already answered.
            guard let snap else {
                transcriptErrors[key] = "Session not found."
                return
            }
            let read = Set(snap.events.map(\.id))
            let held = transcripts[key]?.events ?? []
            let live = held.filter { !before.contains($0.id) && !read.contains($0.id) }
            var t = Transcript(olderBefore: snap.olderBefore)
            if let first = snap.events.first, let i = held.firstIndex(where: { $0.id == first.id }) {
                for e in held[..<i] { t.append(e) }
                t.olderBefore = transcripts[key]?.olderBefore
            }
            for e in snap.events + live { t.append(e) }
            transcripts[key] = t
            transcriptErrors[key] = nil
            serverRead.insert(key)
        } catch {
            transcriptErrors[key] = error.localizedDescription
        }
    }

    func loadOlder(_ key: SessionKey) async {
        guard let c = connections[key.server], let before = transcripts[key]?.olderBefore else { return }
        olderErrors[key] = nil
        do {
            let page: Snapshot = try await c.call("get_session_page", ["sessionId": .string(key.id), "before": JSON(before), "turns": 16])
            guard var t = transcripts[key] else { return }
            let older = page.events.filter { !t.ids.contains($0.id) }
            t.events.insert(contentsOf: older, at: 0)
            t.ids.formUnion(older.map(\.id))
            t.olderBefore = page.olderBefore
            transcripts[key] = t
        } catch {
            olderErrors[key] = error.localizedDescription
        }
    }

    /// Sends a prompt carrying the session's own recorded settings back, so
    /// `send_msg` finds nothing changed and respawns nothing. They are read
    /// fresh first: another client moving the model broadcasts nothing, and a
    /// held copy sent back would undo its change.
    /// `model`, `effort`, `stance` and `fast` are what the reader moved for this reply; each nil keeps
    /// the session's as just re-read, so a change another client made is never undone.
    /// Sends a reply, answering the session it went to. Another `harness`, in a bot chat, is
    /// an agent switch: a new session in the bot's folder, which the server hands the chat so far.
    @discardableResult
    func send(_ key: SessionKey, _ text: String, attachments: [String] = [], harness: String? = nil,
              model: String? = nil, effort: String? = nil, stance: String? = nil, fast: Bool? = nil) async -> SessionKey? {
        guard let c = connections[key.server] else { return nil }
        do {
            let fresh: SessionItem? = try await c.call("get_session_by_id", ["sessionId": .string(key.id), "turns": 0])
            guard let item = fresh else { throw DrayError("Session not found") }
            store(key, item)
            let moving = harness.map { $0 != item.harness } ?? false
            var to = key
            var isNew = false
            if moving {
                // One id per switch, kept across retries: a switch whose reply was lost already
                // made its session, and a second would stop the first and send the words twice.
                to = switches[key] ?? SessionKey(server: key.server, id: UUID().uuidString.lowercased())
                switches[key] = to
                let made: SessionItem? = (try? await c.call("get_session_by_id", ["sessionId": .string(to.id), "turns": 0])) ?? nil
                if let made {
                    created(key.server, made)
                    // The index entry lands before the agent starts, so the session alone proves
                    // nothing: the words landed only if its log holds them.
                    let log: Snapshot? = try await c.call("get_session_by_id", ["sessionId": .string(to.id), "turns": 1])
                    if log?.events.contains(where: { if case .userMessage = $0.payload { true } else { false } }) == true {
                        switches[key] = nil
                        unsent[key] = nil
                        return to
                    }
                    // Still starting: the first send may yet land, and a second session would run it twice.
                    if made.busy { throw DrayError("The switch is still starting. Try again in a moment.") }
                    // Its agent never started, and Codex cannot resume a thread it never made: a new one.
                    // ponytail: the empty session stays in the chat as one more "Switched to" line;
                    // delete_session would tell the bot the reader deleted a task.
                    to = SessionKey(server: key.server, id: UUID().uuidString.lowercased())
                    switches[key] = to
                }
                // The desktop's rule: the old agent's turn would be cut off by the switch.
                if item.busy { throw DrayError("Wait for this turn to end to switch agent.") }
                isNew = true
            }
            let agent = harness ?? item.harness
            let outcome: SendOutcome = try await c.call("send_msg", [
                "sessionId": .string(to.id),
                "prompt": .string(text),
                "attachmentPaths": .array(attachments.map { .string($0) }),
                "harness": .string(agent),
                "model": .string(model ?? (moving ? Picks.defaultModel[agent] ?? "" : item.model)),
                "effort": JSON(moving ? effort : effort ?? item.effort),
                "permissionMode": .string(Picks.stanceFor(agent, stance ?? item.permissionMode)),
                "fast": .bool(fast ?? item.fast ?? false),
                "cwd": .string(item.cwd),
                "branch": nil,
                "useWorktree": false,
                "worktreeName": nil,
                "baseRef": nil,
                "isNewSession": .bool(isNew),
            ])
            if let snapshot = outcome.snapshot { created(key.server, snapshot) }
            unsent[key] = nil
            switches[key] = nil
            // By id: the server's `queue_changed` usually lands before this reply.
            if let q = outcome.queued, !(queued[to]?.contains(q) ?? false) { queued[to, default: []].append(q) }
            sends[to, default: 0] += 1
            return to
        } catch {
            lastError = error.localizedDescription
            return nil
        }
    }

    func interrupt(_ key: SessionKey) async {
        do {
            _ = try await connections[key.server]?.call("interrupt_session", ["sessionId": .string(key.id)], as: JSON.self)
        } catch {
            lastError = error.localizedDescription
        }
    }

    func respond(_ key: SessionKey, requestId: String, optionId: String) async {
        do {
            _ = try await connections[key.server]?.call("respond_permission", [
                "sessionId": .string(key.id), "requestId": .string(requestId), "optionId": .string(optionId),
            ], as: JSON.self)
            retire(key, requestId)
        } catch {
            lastError = error.localizedDescription
        }
    }

    /// Answers keyed by each question's own text, which is how the CLI matches them.
    func answer(_ key: SessionKey, requestId: String, answers: [String: String]) async {
        do {
            _ = try await connections[key.server]?.call("answer_questions", [
                "sessionId": .string(key.id), "requestId": .string(requestId),
                "answers": .object(answers.mapValues(JSON.string)),
            ], as: JSON.self)
            retire(key, requestId)
        } catch {
            lastError = error.localizedDescription
        }
    }

    private func retire(_ key: SessionKey, _ requestId: String) {
        asks[key]?.removeAll { $0.payload.askId == requestId }
    }

    // MARK: Events

    private func handle(_ server: UUID, _ name: String, _ data: Data) {
        let decoder = JSONDecoder()
        switch name {
        case "agent_event":
            guard let e = try? decoder.decode(EventFrame<AgentEvent>.self, from: data).payload else { return }
            apply(SessionKey(server: server, id: e.sessionId), e)
        case "live_state":
            guard let live = try? decoder.decode(EventFrame<LiveState>.self, from: data).payload else { return }
            // Replaces what is held: a card answered while the socket was down goes.
            for key in asks.keys where key.server == server { asks[key] = nil }
            for key in tasks.keys where key.server == server { tasks[key] = nil }
            for a in live.asks { asks[SessionKey(server: server, id: a.sessionId), default: []].append(a) }
            for t in live.tasks {
                if case .backgroundTasks(let n) = t.payload { tasks[SessionKey(server: server, id: t.sessionId)] = n }
            }
            // This Mac's alone: its app reads the timers and answers Extend. Another
            // Mac's would name servers this one has never heard of.
            if server == home, let boat = live.boat { boatAlerts = boat }
            if let held = live.queued {
                for key in queued.keys where key.server == server { queued[key] = nil }
                for q in held where !q.queued.isEmpty { queued[SessionKey(server: server, id: q.sessionId)] = q.queued }
            }
        case "boat_alerts":
            guard server == home,
                  let frame = try? decoder.decode(EventFrame<BoatAlerts>.self, from: data).payload else { return }
            boatAlerts = frame.alerts
        case "queue_changed":
            // Every client's sends, the desktop's and the CLI's included; `send_msg` answers only its caller.
            guard let q = try? decoder.decode(EventFrame<QueueChanged>.self, from: data).payload else { return }
            queued[SessionKey(server: server, id: q.sessionId)] = q.queued.isEmpty ? nil : q.queued
        case "session_status":
            guard let s = try? decoder.decode(EventFrame<StatusEvent>.self, from: data).payload else { return }
            let key = SessionKey(server: server, id: s.sessionId)
            statuses[key] = s
            notice(key)
            let ended = items[key]?.busy == true && s.status != "in_progress"
            // A turn ending is when a pull request appears.
            if ended, let path = items[key]?.projectPath {
                Task { await loadMarks(server, force: true, only: [path]) }
            }
            items[key]?.status = s.status
            if let m = s.modified { items[key]?.modified = m }
            if s.status != "in_progress" { strand(key) }
            // Live events reach memory alone; the turn's end re-reads it so a cold open has the reply.
            if ended, home == nil, transcripts[key] != nil { Task { await reload(key) } }
            // A bot's row shows its newest reply, which only its server can read.
            if s.status != "in_progress", bot(key) != nil { Task { await loadPreviews(server) } }
        case "session_title":
            guard let t = try? decoder.decode(EventFrame<TitleEvent>.self, from: data).payload else { return }
            items[SessionKey(server: server, id: t.sessionId)]?.title = t.title
        case "clone_progress":
            guard let p = try? decoder.decode(EventFrame<CloneProgress>.self, from: data).payload else { return }
            cloneProgress[server, default: [:]][p.slug] = p.line
        case "host_changed":
            linksMayHaveMoved()
        case "bots_changed":
            Task { await loadBots(server) }
        case "drafts_changed":
            draftsRevision += 1
        case "machines_shared":
            guard let sharing = try? decoder.decode(EventFrame<Sharing>.self, from: data).payload else { return }
            share(server, sharing.machines)
        case "session_created", "session_changed":
            guard let item = try? decoder.decode(EventFrame<SessionItem>.self, from: data).payload else { return }
            items[SessionKey(server: server, id: item.sessionId)] = item
            Task { await loadMarks(server, force: false, only: [item.projectPath]) }
            // `bots_changed` comes from the CLI alone, and a bot the app made is first seen as its chat.
            if name == "session_created", !(bots[server] ?? []).contains(where: { $0.path == item.cwd }) {
                Task { await loadBots(server) }
            }
        default:
            break
        }
    }

    /// An id the index does not name re-reads it, once per burst.
    /// `session_created` carries a new session's entry to every client, so this
    /// is what is left for a server from before that event.
    private func notice(_ key: SessionKey) {
        guard items[key] == nil, !reading.contains(key.server) else { return }
        reading.insert(key.server)
        Task {
            await loadIndex(key.server)
            reading.remove(key.server)
            // A repo joining the list is read once, the desktop's rule; fresh ones are skipped.
            await loadMarks(key.server, force: false)
        }
    }

    private func apply(_ key: SessionKey, _ e: AgentEvent) {
        notice(key)
        switch e.payload {
        case .permissionRequested, .questionsAsked:
            if !(asks[key]?.contains { $0.payload.askId == e.payload.askId } ?? false) {
                asks[key, default: []].append(e)
            }
        case .permissionDecided(let id):
            retire(key, id)
        case .backgroundTasks(let n):
            tasks[key] = n
            if n == 0 && items[key]?.busy != true { strand(key) }
        case .userMessage(let text, _, _, _, _, _, _):
            queued[key]?.removeAll { $0.text == text }
        default:
            break
        }
        if !e.payload.isTransient, transcripts[key] != nil { transcripts[key]?.append(e) }
    }

    /// Drops a session's cards once nothing could answer them: no turn
    /// running and no background task left — the server's own rule.
    private func strand(_ key: SessionKey) {
        if items[key]?.busy != true && (tasks[key] ?? 0) == 0 { asks[key] = nil }
    }
}

/// Tokens live in the Keychain, never in defaults.
enum Keychain {
    private static let service = "com.yogesh.dray.ios.servers"

    private static func query(_ account: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: service,
         kSecAttrAccount as String: account]
    }

    static func set(_ value: String, for account: String) {
        SecItemDelete(query(account) as CFDictionary)
        var add = query(account)
        add[kSecValueData as String] = Data(value.utf8)
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        SecItemAdd(add as CFDictionary, nil)
    }

    static func get(_ account: String) -> String? {
        var q = query(account)
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let data = out as? Data else { return nil }
        return String(decoding: data, as: UTF8.self)
    }

    static func delete(_ account: String) {
        SecItemDelete(query(account) as CFDictionary)
    }
}

/// Files under Caches, which the system may clear: everything here is read again from its server.
enum Cache {
    static let root = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
        .appending(path: "dray", directoryHint: .isDirectory)
    static func folder(_ server: UUID) -> URL { root.appending(path: server.uuidString, directoryHint: .isDirectory) }
    static func list(_ server: UUID) -> URL { folder(server).appending(path: "list.json") }
    /// The id is the server's to pick, so it is encoded down to one name that cannot leave the folder.
    static func transcript(_ key: SessionKey) -> URL {
        let name = key.id.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? "invalid"
        return folder(key.server).appending(path: "t-\(name).json")
    }

    /// Encodes and writes off the main thread; a failed write costs the next cold open, nothing else.
    static func write(_ url: URL, _ make: @escaping () throws -> Data) {
        Task.detached(priority: .utility) {
            guard let data = try? make() else { return }
            try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try? data.write(to: url, options: .atomic)
        }
    }
}

#if ISLAND_DEMO
extension Store {
    /// The island demo's cases: sessions and the cards they wait on, with no
    /// server behind them. In this file, since both maps are `private(set)`.
    func seed(_ server: UUID, items: [SessionItem], asks: [AgentEvent], prs: [String: [String: PrMark]] = [:]) {
        for item in items { self.items[SessionKey(server: server, id: item.sessionId)] = item }
        for ask in asks { self.asks[SessionKey(server: server, id: ask.sessionId), default: []].append(ask) }
        for (path, byBranch) in prs { marks[ProjectKey(server: server, path: path)] = byBranch }
    }

    func seed(home server: UUID, bots: [Bot]) {
        home = server
        self.bots = [server: bots]
    }
}
#endif
