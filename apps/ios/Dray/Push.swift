import Observation
import os
import UIKit
import UserNotifications

/// Phone alerts (#1299): a task done, a permission or a question asked.
///
/// APNs gives the app a token; the relay on drayhq.com seals it into a handle,
/// and every server this phone connects to is handed that handle with the
/// phone's own id for the server, which each alert carries back. The server
/// sends through the relay, the only holder of the APNs key.
@MainActor @Observable
final class Push: NSObject, UNUserNotificationCenterDelegate {
    static let shared = Push()
    static let allowKey = "notify.allow"

    /// A chat a tapped alert asks to open, taken by the root view.
    var opening: SessionKey?
    /// The chat on screen, which raises no banner of its own.
    @ObservationIgnored var viewing: SessionKey?
    @ObservationIgnored private weak var store: Store?

    static var enabled: Bool { UserDefaults.standard.object(forKey: allowKey) as? Bool ?? true }

    /// Each kind a server can send, as its switch in Settings says it. All on until turned off.
    static let kinds: [(kind: String, label: String)] = [
        ("done", "A task is done"), ("permission", "A task needs permission"),
        ("question", "A task asks a question"), ("ready", "A PR is ready to merge"),
    ]
    static func key(_ kind: String) -> String { "notify.\(kind)" }
    /// The kinds turned off, which every server is told, so a kind added later reaches this phone.
    private var off: [String] {
        Self.kinds.map(\.kind).filter { UserDefaults.standard.object(forKey: Self.key($0)) as? Bool == false }
    }

    /// A kind's switch moved: every server up now hears the new list.
    func kindsChanged() {
        guard Self.enabled, let handle else { return }
        for s in store?.servers ?? [] where store?.serverState[s.id] == .connected { give(handle, to: s.id) }
    }

    /// drayhq.com, or `-pushRelay <url>` at launch for a local relay.
    private var relay: String { UserDefaults.standard.string(forKey: "pushRelay") ?? "https://drayhq.com" }

    private var handle: String? {
        get { UserDefaults.standard.string(forKey: "push.handle") }
        set { UserDefaults.standard.set(newValue, forKey: "push.handle") }
    }

    func start(_ store: Store) {
        self.store = store
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        Task {
            // The extension's per-question categories stay, or an alert still on screen loses its options.
            let asked = await center.notificationCategories().filter { $0.identifier.hasPrefix(questionCategoryPrefix) }
            center.setNotificationCategories(asked.union([
                UNNotificationCategory(identifier: "dray.permission", actions: [
                    UNNotificationAction(identifier: "allow", title: "Allow", options: [.authenticationRequired]),
                    UNNotificationAction(identifier: "deny", title: "Deny", options: [.destructive]),
                ], intentIdentifiers: []),
                UNNotificationCategory(identifier: "dray.question", actions: [], intentIdentifiers: []),
                UNNotificationCategory(identifier: "dray.done", actions: [], intentIdentifiers: []),
                UNNotificationCategory(identifier: "dray.ready", actions: [], intentIdentifiers: []),
            ]))
        }
        store.onConnected = { [weak self] server in self?.connected(server) }
        store.onRemoving = { [weak self] server in self?.leave(server) }
        // Every launch, as Apple asks: a restored or migrated phone gets a new token.
        if Self.enabled && handle != nil { Task { await ask() } }
    }

    /// Asks iOS once, then APNs; the token comes back through the app delegate.
    private func ask() async {
        guard Self.enabled,
              (try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge])) == true
        else { return pushLog.info("notifications not allowed") }
        pushLog.info("asking APNs for a token")
        UIApplication.shared.registerForRemoteNotifications()
    }

    /// A server came up: it gets the handle, or the first one starts the asking.
    private func connected(_ server: UUID) {
        guard Self.enabled else { return }
        if let handle { give(handle, to: server) } else { Task { await ask() } }
    }

    private func give(_ handle: String, to server: UUID) {
        Task {
            _ = try? await store?.call(server, "push_register", [
                "handle": .string(handle), "tag": .string(server.uuidString), "off": .array(off.map(JSON.string)),
            ], as: JSON.self)
        }
    }

    /// A server being removed stops alerting this phone. Its own socket and
    /// token, read now, since the removal drops both from the store.
    func leave(_ s: Server) {
        guard let handle else { return }
        let token = Keychain.get((s.via?.parent ?? s.id).uuidString) ?? ""
        Task { try? await send(s, token: token, "push_unregister", ["handle": .string(handle)]) }
    }

    /// APNs answered: trade the token for a handle and hand it to every server up now.
    func registered(_ token: Data) async {
        let hex = token.map { String(format: "%02x", $0) }.joined()
        // Sealed again on every launch, even for the same token: a server drops
        // a handle the relay stopped taking (a new `PUSH_HANDLE_SECRET`), and
        // only a fresh one reaches it again.
        #if DEBUG
        let env = "sandbox"
        #else
        let env = "production"
        #endif
        guard let url = URL(string: relay + "/api/push/register") else { return }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONEncoder().encode(["token": hex, "env": env])
        guard let (data, _) = try? await URLSession.shared.data(for: request),
              let sealed = (try? JSONDecoder().decode([String: String].self, from: data))?["handle"] else {
            return pushLog.error("the relay at \(self.relay, privacy: .public) sealed no handle")
        }
        pushLog.info("sealed a handle; handing it to the servers up now")
        handle = sealed
        UserDefaults.standard.set(hex, forKey: "push.token")
        for s in store?.servers ?? [] where store?.serverState[s.id] == .connected { give(sealed, to: s.id) }
    }

    /// Settings' switch. Off takes the handle back from every server up now and
    /// drops the token, so a server reached later hears 410 from the relay and forgets it too.
    func set(_ on: Bool) async {
        UserDefaults.standard.set(on, forKey: Self.allowKey)
        if on { return await ask() }
        if let handle {
            for s in store?.servers ?? [] where store?.serverState[s.id] == .connected {
                _ = try? await store?.call(s.id, "push_unregister", ["handle": .string(handle)], as: JSON.self)
            }
        }
        handle = nil
        UIApplication.shared.unregisterForRemoteNotifications()
    }

    // The completion-handler forms, each answered on the main thread: the async
    // forms answer off it, and UIKit aborts the app for that.
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                            withCompletionHandler done: @escaping (UNNotificationPresentationOptions) -> Void) {
        let key = PushAlert(notification.request.content.userInfo)?.key
        Task { @MainActor in done(key != nil && key == viewing ? [] : [.banner, .list, .sound]) }
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                            withCompletionHandler done: @escaping () -> Void) {
        let content = response.notification.request.content
        guard let alert = PushAlert(content.userInfo) else { return done() }
        let (action, title) = (response.actionIdentifier, content.title)
        let typed = (response as? UNTextInputNotificationResponse)?.userText
        Task { @MainActor in
            await act(alert, action, typed: typed, title: title)
            done()
        }
    }

    /// A tap opens the chat; an action answers from the alert, the app never coming forward.
    private func act(_ alert: PushAlert, _ action: String, typed: String?, title: String) async {
        let cmd: String
        var args: [String: JSON] = ["sessionId": .string(alert.session)]
        switch action {
        case UNNotificationDefaultActionIdentifier:
            opening = alert.key
            return
        case "allow", "deny":
            guard let request = alert.request, let option = action == "allow" ? alert.allow : alert.deny else { return }
            cmd = "respond_permission"
            args["requestId"] = .string(request)
            args["optionId"] = .string(option)
        case _ where action.hasPrefix("q."):
            guard let request = alert.request, let q = alert.question else { return }
            let answer = action == "q.text" ? typed : Int(action.dropFirst(2)).flatMap { q.options.indices.contains($0) ? q.options[$0] : nil }
            guard let answer, !answer.isEmpty else { return }
            cmd = "answer_questions"
            args["requestId"] = .string(request)
            args["answers"] = .object([q.text: .string(answer)])
        default:
            return
        }
        do {
            try await answer(alert.server, cmd, args)
            pushLog.info("\(cmd, privacy: .public) sent from an alert")
        } catch {
            pushLog.error("\(cmd, privacy: .public) from an alert failed: \(error.localizedDescription, privacy: .public)")
            // Said where the reader is looking: they answered from an alert, so it answers back the same way.
            let note = UNMutableNotificationContent()
            note.title = title
            note.body = "Couldn't send your answer: \(error.localizedDescription). Tap to answer in Dray."
            var dray = ["kind": "done", "server": alert.server.uuidString, "session": alert.session]
            dray["open"] = alert.open
            note.userInfo = ["dray": dray]
            try? await UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: UUID().uuidString, content: note, trigger: nil))
        }
    }

    #if DEBUG
    /// The UI test's stand-in for the extension, which `simctl push` never runs: an
    /// APNs payload the relay sent, saved on disk, dressed as the extension would and shown in 3s.
    func showDressed(_ path: String) async {
        guard let data = FileManager.default.contents(atPath: path),
              let payload = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let aps = payload["aps"] as? [String: Any], let alert = aps["alert"] as? [String: String] else { return }
        let raw = UNMutableNotificationContent()
        raw.title = alert["title"] ?? ""
        raw.body = alert["body"] ?? ""
        raw.sound = .default
        raw.categoryIdentifier = aps["category"] as? String ?? ""
        raw.threadIdentifier = aps["thread-id"] as? String ?? ""
        raw.userInfo = ["dray": payload["dray"] ?? [:]]
        let shown = await dressAlert(raw)
        try? await UNUserNotificationCenter.current().add(UNNotificationRequest(
            identifier: UUID().uuidString, content: shown, trigger: UNTimeIntervalNotificationTrigger(timeInterval: 3, repeats: false)))
    }
    #endif

    /// Answers on a socket of its own. An action wakes the app in the background,
    /// where the store's sockets are dead or half-dead and only coming to the front revives them.
    private func answer(_ server: UUID, _ cmd: String, _ args: [String: JSON]) async throws {
        // A shared machine is listed only once its server has said so, a moment after launch.
        var found: Server?
        for _ in 0..<40 {
            found = store?.servers.first { $0.id == server }
            if found != nil { break }
            try await Task.sleep(for: .milliseconds(250))
        }
        guard let s = found else { throw DrayError("this server is no longer paired") }
        try await send(s, token: Keychain.get((s.via?.parent ?? s.id).uuidString) ?? "", cmd, args)
    }

    private func send(_ s: Server, token: String, _ cmd: String, _ args: [String: JSON]) async throws {
        let c = Connection(serverId: s.id, url: s.url, token: token)
        c.via = s.via?.machine
        defer { c.stop() }
        let states = AsyncStream<Connection.State> { states in c.onState = { states.yield($0) } }
        c.resume()
        for await state in states {
            switch state {
            case .connected: return _ = try await c.call(cmd, args, as: JSON.self, timeout: .seconds(15))
            case .waiting(let problem, _), .failed(let problem): throw DrayError("can't reach the server (\(problem))")
            case .connecting: continue
            }
        }
    }
}

let pushLog = Logger(subsystem: "com.yogesh.dray.ios", category: "push")


/// What the relay puts under `dray` in an alert.
struct PushAlert {
    let kind: String
    let server: UUID
    let session: String
    /// The chat a tap opens where not `session`: a bot's task opens the bot's chat.
    let open: String?
    let request: String?
    let allow: String?
    let deny: String?
    let question: (text: String, options: [String])?

    /// The chat the alert belongs to on screen; actions still answer `session`.
    var key: SessionKey { SessionKey(server: server, id: open ?? session) }

    init?(_ info: [AnyHashable: Any]) {
        guard let d = info["dray"] as? [String: Any], let kind = d["kind"] as? String,
              let server = (d["server"] as? String).flatMap(UUID.init), let session = d["session"] as? String else { return nil }
        self.kind = kind
        self.server = server
        self.session = session
        open = d["open"] as? String
        request = d["request"] as? String
        allow = d["allow"] as? String
        deny = d["deny"] as? String
        question = (d["question"] as? [String: Any]).flatMap { q in
            (q["text"] as? String).map { ($0, q["options"] as? [String] ?? []) }
        }
    }
}

/// Where APNs hands the token back; SwiftUI has no other way in.
final class AppDelegate: NSObject, UIApplicationDelegate {
    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken token: Data) {
        pushLog.info("APNs gave a token")
        Task { await Push.shared.registered(token) }
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        pushLog.error("APNs registration failed: \(error.localizedDescription, privacy: .public)")
    }
}
