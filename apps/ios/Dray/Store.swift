import Foundation
import Observation
import Security

struct Server: Codable, Identifiable, Hashable {
    let id: UUID
    var name: String
    var url: String
}

/// A session is named by its server and its id; nothing on the wire carries
/// the server, so the connection a frame arrived on is the answer.
struct SessionKey: Hashable {
    let server: UUID
    let id: String
}

/// Every server's sessions, merged, and what the phone holds about each.
@MainActor @Observable
final class Store {
    private(set) var servers: [Server] = []
    private(set) var serverState: [UUID: Connection.State] = [:]
    private(set) var items: [SessionKey: SessionItem] = [:]
    private(set) var transcripts: [SessionKey: Transcript] = [:]
    private(set) var asks: [SessionKey: [AgentEvent]] = [:]
    private(set) var queued: [SessionKey: [Queued]] = [:]
    var drafts: [SessionKey: String] = [:]
    /// gh's latest progress line per clone, by server and slug.
    var cloneProgress: [UUID: [String: String]] = [:]
    var lastError: String?

    @ObservationIgnored private var tasks: [SessionKey: Int] = [:]
    @ObservationIgnored private var reading: Set<UUID> = []
    @ObservationIgnored private var statuses: [SessionKey: StatusEvent] = [:]
    @ObservationIgnored private var connections: [UUID: Connection] = [:]

    init() {
        if let data = UserDefaults.standard.data(forKey: "servers"),
           let saved = try? JSONDecoder().decode([Server].self, from: data) {
            servers = saved
        }
        for s in servers { start(s) }
    }

    /// One server, read through `read` at every connect rather than the
    /// Keychain — the Notch's This Mac, whose port and token are files.
    init(local s: Server, read: @escaping () -> (url: String, token: String)?) {
        servers = [s]
        start(s, read: read)
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
        connections.removeValue(forKey: s.id)?.stop()
        Keychain.delete(s.id.uuidString)
        servers.removeAll { $0.id == s.id }
        serverState[s.id] = nil
        for key in items.keys where key.server == s.id { items[key] = nil }
        for key in transcripts.keys where key.server == s.id { transcripts[key] = nil }
        for key in asks.keys where key.server == s.id { asks[key] = nil }
        save()
    }

    func connection(_ server: UUID) -> Connection? { connections[server] }

    func name(of server: UUID) -> String {
        servers.first { $0.id == server }?.name ?? "Server"
    }

    /// iOS drops sockets once the app leaves the screen; coming back reconnects.
    func resume() {
        for c in connections.values { c.resume() }
    }

    func refresh() async {
        for s in servers where serverState[s.id] == .connected { await loadIndex(s.id) }
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
    }

    private func save() {
        UserDefaults.standard.set(try? JSONEncoder().encode(servers), forKey: "servers")
    }

    private func start(_ s: Server, read: (() -> (url: String, token: String)?)? = nil) {
        guard let token = read?()?.token ?? Keychain.get(s.id.uuidString) else {
            serverState[s.id] = .failed("No token saved; remove and add this server again")
            return
        }
        let c = Connection(serverId: s.id, url: s.url, token: token)
        c.refresh = read
        c.onState = { [weak self] state in
            guard let self else { return }
            serverState[s.id] = state
            if state == .connected { Task { await self.connected(s.id) } }
        }
        c.onEvent = { [weak self] name, data in self?.handle(s.id, name, data) }
        connections[s.id] = c
        c.resume()
    }

    /// A fresh connection re-reads the index and the tail of every open
    /// transcript, so nothing that happened while it was down is missed.
    private func connected(_ server: UUID) async {
        await loadIndex(server)
        for key in transcripts.keys where key.server == server { await reload(key) }
    }

    private func loadIndex(_ server: UUID) async {
        guard let c = connections[server] else { return }
        do {
            let list: [SessionItem] = try await c.call("list_session_index_items", ["archived": false])
            for key in items.keys where key.server == server { items[key] = nil }
            for item in list { store(SessionKey(server: server, id: item.sessionId), item) }
        } catch {
            serverState[server] = .failed(error.localizedDescription)
        }
    }

    /// Writes an entry read off the index. A status event that arrived while
    /// the read was out is newer than it, so it wins.
    private func store(_ key: SessionKey, _ read: SessionItem) {
        var item = read
        if let s = statuses[key], let m = s.modified, m >= item.modified {
            item.status = s.status
            item.modified = m
        }
        items[key] = item
    }

    // MARK: Sessions

    /// What the list draws: sessions waiting on the reader first, then newest.
    var sessions: [(key: SessionKey, item: SessionItem)] {
        items.filter { !($0.value.hidden ?? false) && !($0.value.archived ?? false) }
            .map { (key: $0.key, item: $0.value) }
            .sorted { a, b in
                let wa = isAsking(a.key), wb = isAsking(b.key)
                if wa != wb { return wa }
                return a.item.modified > b.item.modified
            }
    }

    func isAsking(_ key: SessionKey) -> Bool { !(asks[key]?.isEmpty ?? true) }

    func open(_ key: SessionKey) async {
        if transcripts[key] == nil { await reload(key) }
        if items[key]?.status == "completed" {
            items[key]?.status = "idle"
            _ = try? await connections[key.server]?.call("mark_session_read", ["sessionId": .string(key.id), "read": true], as: JSON.self)
        }
    }

    /// Re-reads the newest turns and lays them over what is held: older pages
    /// the read starts inside are kept, the read's own events follow in log
    /// order, and anything that arrived live while it was out goes last.
    /// Matched on id, since a subagent restarts `seq`.
    private func reload(_ key: SessionKey) async {
        guard let c = connections[key.server] else { return }
        let before = transcripts[key]?.ids ?? []
        do {
            let snap: Snapshot? = try await c.call("get_session_by_id", ["sessionId": .string(key.id), "turns": 8])
            guard let snap else { return }
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
        } catch {
            lastError = error.localizedDescription
        }
    }

    func loadOlder(_ key: SessionKey) async {
        guard let c = connections[key.server], let before = transcripts[key]?.olderBefore else { return }
        do {
            let page: Snapshot = try await c.call("get_session_page", ["sessionId": .string(key.id), "before": JSON(before), "turns": 16])
            guard var t = transcripts[key] else { return }
            let older = page.events.filter { !t.ids.contains($0.id) }
            t.events.insert(contentsOf: older, at: 0)
            t.ids.formUnion(older.map(\.id))
            t.olderBefore = page.olderBefore
            transcripts[key] = t
        } catch {
            lastError = error.localizedDescription
        }
    }

    /// Sends a prompt carrying the session's own recorded settings back, so
    /// `send_msg` finds nothing changed and respawns nothing. They are read
    /// fresh first: another client moving the model broadcasts nothing, and a
    /// held copy sent back would undo its change.
    func send(_ key: SessionKey, _ text: String) async -> Bool {
        guard let c = connections[key.server] else { return false }
        do {
            let fresh: SessionItem? = try await c.call("get_session_by_id", ["sessionId": .string(key.id), "turns": 0])
            guard let item = fresh else { throw DrayError("Session not found") }
            store(key, item)
            let outcome: SendOutcome = try await c.call("send_msg", [
                "sessionId": .string(key.id),
                "prompt": .string(text),
                "attachmentPaths": [],
                "harness": .string(item.harness),
                "model": .string(item.model),
                "effort": JSON(item.effort),
                "permissionMode": .string(item.permissionMode),
                "fast": .bool(item.fast ?? false),
                "cwd": .string(item.cwd),
                "branch": nil,
                "useWorktree": false,
                "worktreeName": nil,
                "baseRef": nil,
                "isNewSession": false,
            ])
            if let q = outcome.queued { queued[key, default: []].append(q) }
            return true
        } catch {
            lastError = error.localizedDescription
            return false
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
        case "session_status":
            guard let s = try? decoder.decode(EventFrame<StatusEvent>.self, from: data).payload else { return }
            let key = SessionKey(server: server, id: s.sessionId)
            statuses[key] = s
            notice(key)
            items[key]?.status = s.status
            if let m = s.modified { items[key]?.modified = m }
            if s.status != "in_progress" { strand(key) }
        case "session_title":
            guard let t = try? decoder.decode(EventFrame<TitleEvent>.self, from: data).payload else { return }
            items[SessionKey(server: server, id: t.sessionId)]?.title = t.title
        case "clone_progress":
            guard let p = try? decoder.decode(EventFrame<CloneProgress>.self, from: data).payload else { return }
            cloneProgress[server, default: [:]][p.slug] = p.line
        case "session_created", "session_changed":
            guard let item = try? decoder.decode(EventFrame<SessionItem>.self, from: data).payload else { return }
            items[SessionKey(server: server, id: item.sessionId)] = item
        default:
            break
        }
    }

    /// A session another client started reaches this one as events alone —
    /// `send_msg` hands its entry back to the caller — so an id the index
    /// does not name re-reads it, once per burst.
    private func notice(_ key: SessionKey) {
        guard items[key] == nil, !reading.contains(key.server) else { return }
        reading.insert(key.server)
        Task {
            await loadIndex(key.server)
            reading.remove(key.server)
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
        case .userMessage(let text, _, _, _):
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
