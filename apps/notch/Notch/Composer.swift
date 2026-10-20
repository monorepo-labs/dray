import AppKit
import Observation

/// One line of the message being built, in the order it was said or typed,
/// or a file — a marked-up capture or a drop — riding the prompt as an attachment.
struct Row: Identifiable, Hashable {
    let id = UUID()
    var text: String
    let said: Bool
    var file: String? = nil
    /// A screenshot's place, held from the press so speech said meanwhile
    /// lands around it rather than ahead of it. Drawn as nothing.
    var pending = false
}

enum Target: Hashable {
    case session(SessionKey)
    case new
}

enum Dictation { case idle, starting, recording, transcribing }

/// The panel's layout, the reader's pick from its right-click menu and never
/// switched for them: compact, one row with the orb beside the input, or voice,
/// the orb alone in the middle.
enum InputMode: String, CaseIterable {
    case compact, expanded

    var label: String { self == .expanded ? "Expanded" : "Compact" }
}

/// The new-session bar's dropdowns.
enum MenuID: Hashable { case model, project, stance }

/// The draft and everything the panel does with it.
@MainActor @Observable
final class Composer {
    static let width: CGFloat = 520

    let store: Store
    let server: UUID
    // A notice is about the last thing tried, so whatever the reader does next retires it.
    var rows: [Row] = [] { didSet { notice = nil } }
    var typing = "" { didSet { if typing != oldValue { notice = nil } } }
    var target: Target?
    var dictation = Dictation.idle {
        didSet {
            // Decided as the pill appears, so the hint arrives with it rather than a beat later.
            // A recording begun under Sent is new work: the draft comes back and the panel stays.
            if dictation == .starting { sent = false; notice = nil; drawHint = UserDefaults.standard.integer(forKey: "notch.drawHints") < Self.drawHints }
            if !listening { drawHint = false }
            if (dictation == .recording) != (oldValue == .recording) {
                recordingSince = dictation == .recording ? Date() : nil
                recordingChanged(dictation == .recording)
                // Counted once the microphone is open, so a refused start spends nothing.
                if dictation == .recording, drawHint {
                    UserDefaults.standard.set(UserDefaults.standard.integer(forKey: "notch.drawHints") + 1, forKey: "notch.drawHints")
                }
            }
        }
    }
    var listening: Bool { dictation == .starting || dictation == .recording }
    /// For the drawing overlay, up for exactly as long as the microphone records.
    @ObservationIgnored var recordingChanged: (Bool) -> Void = { _ in }
    /// When the microphone opened, for the timer; `nil` unless recording.
    var recordingSince: Date?
    var mode = InputMode(rawValue: UserDefaults.standard.string(forKey: "notch.mode") ?? "") ?? .compact {
        didSet { UserDefaults.standard.set(mode.rawValue, forKey: "notch.mode") }
    }
    var level: Float = 0
    var notice: String? { didSet { retryPath = nil } }
    /// The recording a failed transcription kept, offered beside its notice.
    private(set) var retryPath: String?
    /// Speech a mid-recording cut could not transcribe, and the screenshot it
    /// belongs ahead of. Apart from `notice`, which the shot's own row retires:
    /// those words have already left the recording, so this is their only copy.
    private(set) var lostCut: (path: String, before: UUID)?
    var sending = false
    /// A screenshot is in flight; Send waits for its row.
    var capturing = false
    /// "Hold Shift to draw", until the first stroke of a dictation, for a reader's first few dictations.
    var drawHint = false
    static let drawHints = 5
    /// A lost cut is being transcribed again; Send waits for its words.
    private(set) var retryingCut = false
    /// Bumped to put focus in the input: every open, and every new task.
    var opens = 0
    /// Drawn open; the window lags it on the way out, so the close can animate.
    var shown = false
    var notchHeight: CGFloat = 0
    var placement = Placement(rawValue: UserDefaults.standard.string(forKey: "notch.placement") ?? "") ?? .notch {
        didSet { UserDefaults.standard.set(placement.rawValue, forKey: "notch.placement") }
    }

    // A new session's picks.
    var projects: [Project] = []
    var projectPath: String?
    var agents: [AgentAvailability] = []
    var models: [String: [Model]] = [:]
    var harness = UserDefaults.standard.string(forKey: "notch.harness") ?? "claude_code" {
        didSet { UserDefaults.standard.set(harness, forKey: "notch.harness") }
    }
    var modelPicks = Prefs.map("models")
    var effortPicks = Prefs.map("efforts")
    var stance = UserDefaults.standard.string(forKey: "notch.stance") ?? "auto" {
        didSet { UserDefaults.standard.set(stance, forKey: "notch.stance") }
    }
    /// The reader's worktree pick per project; a project never toggled takes one.
    private var worktreeByProject = UserDefaults.standard.dictionary(forKey: "notch.worktreeByProject") as? [String: Bool] ?? [:]
    var worktree: Bool {
        get { projectPath.flatMap { worktreeByProject[$0] } ?? true }
        set {
            guard let projectPath else { return }
            worktreeByProject[projectPath] = newValue
            UserDefaults.standard.set(worktreeByProject, forKey: "notch.worktreeByProject")
        }
    }
    var openMenu: MenuID?

    // The session list.
    /// Hidden until asked for — the title, ⌘F or ↑/↓ — and again once the
    /// reader picks, types or talks.
    var listShown = false
    var search = ""
    /// Bumped by ⌘F, so the view can focus the search field.
    var searches = 0

    /// Set for the moment between a send landing and the panel closing, which says it went.
    private(set) var sent = false
    /// Return and number keys on a questions card, whose answers live in its view.
    var submits = 0
    var digits = 0
    private(set) var digit = 0
    /// The session whose card is up, picked from the tabs; the oldest when unpicked.
    var askTab: SessionKey?
    /// Every ask's id in the order it arrived, which is the order the tabs are in.
    private var askOrder: [String] = []

    @ObservationIgnored var hide: () -> Void = {}
    @ObservationIgnored var present: () -> Void = {}
    @ObservationIgnored var pillChanged: () -> Void = {}
    @ObservationIgnored var reposition: () -> Void = {}
    @ObservationIgnored private var asksPending = false
    /// Hides the panel, runs the screenshot overlay, and opens it again.
    @ObservationIgnored var capture: () -> Void = {}
    @ObservationIgnored private var lastUsed = UserDefaults.standard.string(forKey: "notch.lastSession")

    init(store: Store, server: UUID) {
        self.store = store
        self.server = server
        store.asksChanged = { [weak self] in self?.asksChanged() }
    }

    // MARK: Cards and alerts

    /// The sessions waiting on the reader, oldest ask first: the tabs over the card.
    var attention: [SessionKey] {
        func first(_ asks: [AgentEvent]) -> Int {
            asks.compactMap { $0.payload.askId.flatMap(askOrder.firstIndex) }.min() ?? .max
        }
        return store.asks.filter { !$0.value.isEmpty }
            .sorted { (first($0.value), $0.key.id) < (first($1.value), $1.key.id) }
            .map(\.key)
    }

    /// The card the panel draws in place of the draft: the picked tab's oldest
    /// ask, so answering one moves to the next.
    var ask: (key: SessionKey, event: AgentEvent)? {
        let keys = attention
        guard let key = askTab.flatMap({ keys.contains($0) ? $0 : nil }) ?? keys.first,
              let event = store.asks[key]?.first else { return nil }
        return (key, event)
    }

    /// A reconnect empties and refills the asks one session at a time, so the
    /// change is read once the burst has landed, not at every step of it.
    /// Nothing opens on its own: a new ask chimes and the pill says how many wait.
    private func asksChanged() {
        guard !asksPending else { return }
        asksPending = true
        DispatchQueue.main.async { [self] in
            asksPending = false
            let ids = store.asks.values.flatMap { $0.compactMap(\.payload.askId) }
            let fresh = ids.filter { !askOrder.contains($0) }
            let hadCards = !askOrder.isEmpty
            askOrder = askOrder.filter(ids.contains) + fresh
            if !fresh.isEmpty, !shown { Sound.done?.play() }
            // The last card answered is the panel's job done.
            if ids.isEmpty, hadCards, shown, !listening { hide() }
            pillChanged()
        }
    }

    var isQuestions: Bool { if case .questionsAsked = ask?.event.payload { true } else { false } }

    /// A number key on a card: a permission's option outright, a question's toggled.
    func pickOption(_ i: Int) {
        switch ask?.event.payload {
        case .permissionRequested(let r)? where r.options.indices.contains(i):
            Task { await respond(r.options[i].id) }
        case .questionsAsked?:
            digit = i
            digits += 1
        default:
            break
        }
    }

    /// The title clicked: Dray's window, on this session. A closed app is
    /// launched and asked again once its window can answer.
    func showInApp(_ key: SessionKey) async {
        let args: [String: JSON] = ["sessionId": .string(key.id)]
        for attempt in 0..<16 {
            if (try? await store.call(server, "show_session", args, as: JSON.self)) != nil {
                hide()
                return
            }
            if attempt == 0 {
                // Bundled, the notch sits at Dray.app/Contents/Helpers; in a dev build there is no Dray around it.
                let host = Bundle.main.bundleURL.deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
                let app = host.pathExtension == "app" ? host : NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.yogesh.dray")
                if let app { _ = try? await NSWorkspace.shared.openApplication(at: app, configuration: NSWorkspace.OpenConfiguration()) }
            }
            try? await Task.sleep(for: .seconds(1))
        }
        notice = "Couldn't open Dray."
    }

    func respond(_ optionId: String) async {
        guard let (key, e) = ask, case .permissionRequested(let r) = e.payload else { return }
        await store.respond(key, requestId: r.requestId, optionId: optionId)
    }

    func answer(_ answers: [String: String]) async {
        guard let (key, e) = ask, case .questionsAsked(let r) = e.payload else { return }
        await store.answer(key, requestId: r.requestId, answers: answers)
    }

    var key: SessionKey? {
        if case .session(let k) = target { return k }
        return nil
    }

    /// Each file stands in the text where it sits in the draft — `[Image 1]`,
    /// or a file's name — so the model can tell which words are about which
    /// image when they arrive as blocks of their own.
    var prompt: String {
        (rows.map { $0.file == nil ? $0.text : "[\(label($0))]" } + [typing])
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
            .joined(separator: " ")
    }

    /// An image numbered by its place among the draft's images, the order its
    /// block reaches the model in; any other file by its name, which the model
    /// sees as a path.
    func label(_ row: Row) -> String {
        guard let file = row.file else { return "" }
        guard Self.isImage(file) else { return URL(fileURLWithPath: file).lastPathComponent }
        // By row, not by path: one image dropped twice is two blocks on the wire.
        let before = rows.prefix { $0.id != row.id }.filter { $0.file.map(Self.isImage) == true }
        return "Image \(before.count + 1)"
    }

    /// Holds the next screenshot's place at the end of the draft.
    func reserveShot() -> UUID {
        let row = Row(text: "", said: false, pending: true)
        rows.append(row)
        return row.id
    }

    /// Puts the shot in its held place, or gives the place up for a cancel.
    func fillShot(_ id: UUID, _ path: String?) {
        guard let i = rows.firstIndex(where: { $0.id == id }) else { return }
        if let path {
            rows[i].file = path
            rows[i].pending = false
        } else {
            rows.remove(at: i)
        }
    }

    /// What Dray sends as pixels (`attachments.rs`): these types, up to 5MB.
    /// Anything else rides as a path the model opens itself.
    static func isImage(_ path: String) -> Bool {
        ["png", "jpg", "jpeg", "gif", "webp"].contains(URL(fileURLWithPath: path).pathExtension.lowercased())
            && ((try? FileManager.default.attributesOfItem(atPath: path)[.size] as? Int) ?? .max) <= 5 * 1024 * 1024
    }

    /// Paths for `send_msg`, which reads each and sends an image as pixels, anything else as a path.
    var attachments: [String] { rows.compactMap(\.file) }

    /// An image alone is a message, as it is in Dray's own composer.
    var canSend: Bool { !capturing && !retryingCut && !rows.contains(where: \.pending) && (!prompt.isEmpty || !attachments.isEmpty) }

    var modelId: String {
        Picks.usableModel(models[harness] ?? [], modelPicks[harness] ?? Picks.defaultModel[harness] ?? "", harness)
    }

    var model: Model? { models[harness]?.first { $0.id == modelId } }
    var effort: String? { model.flatMap { Picks.usableEffort($0, effortPicks[modelId]) } }

    /// Newest first, narrowed by the search, set-aside sessions left out by the
    /// sidebar's rule: flagged, or untouched for three days.
    /// ponytail: the sidebar keeps a stale parent while a child still moves; this does not.
    var listed: [(key: SessionKey, item: SessionItem)] {
        let q = search.trimmingCharacters(in: .whitespaces).lowercased()
        // `modified` is RFC3339 UTC with milliseconds, so it orders as a string.
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let stale = formatter.string(from: Date().addingTimeInterval(-3 * 24 * 3600))
        return store.items
            .filter { _, item in item.hidden != true && item.archived != true && item.aside != true && item.modified > stale }
            .map { (key: $0.key, item: $0.value) }
            .filter { q.isEmpty || $0.item.title.lowercased().contains(q) || $0.item.project.lowercased().contains(q) }
            .sorted { $0.item.modified > $1.item.modified }
    }

    // MARK: Opening

    /// With nothing picked, the last session picked, else the newest.
    func opened() {
        // Cleared here rather than at the close, which would flash the draft back mid-shrink.
        sent = false
        opens += 1
        notice = nil
        listShown = false
        if target == nil || key.map({ store.items[$0] == nil }) == true {
            target = listed.first { $0.key.id == lastUsed }.map { .session($0.key) }
                ?? listed.first.map { .session($0.key) }
                ?? .new
        }
        if target == .new { Task { await loadPicks() } }
    }

    func pick(_ t: Target) {
        target = t
        openMenu = nil
        switch t {
        case .new:
            listShown = false
            opens += 1
            Task { await loadPicks() }
        case .session(let k):
            lastUsed = k.id
            UserDefaults.standard.set(k.id, forKey: "notch.lastSession")
        }
    }

    /// ↑/↓ through the list; from a new session, ↓ lands on the first row.
    func move(_ delta: Int) {
        listShown = true
        let list = listed
        guard !list.isEmpty else { return }
        let at = key.flatMap { k in list.firstIndex { $0.key == k } }
        let next = at.map { min(max($0 + delta, 0), list.count - 1) } ?? (delta > 0 ? 0 : nil)
        if let next { pick(.session(list[next].key)) }
    }

    /// Return in the list: the highlighted row, else the search's best match, then back to the input.
    func choose() {
        let list = listed
        if let first = list.first, !list.contains(where: { $0.key == key }) { pick(.session(first.key)) }
        listShown = false
        opens += 1
    }

    func escape() {
        if openMenu != nil {
            openMenu = nil
            return
        }
        if listShown {
            listShown = false
            return
        }
        // Mid-sentence Esc does nothing (the key monitor's rule), so a recording never ends here.
        hide()
    }

    /// Throws away what is being said: ⌘Esc, or quitting. A start still in
    /// flight sees `.idle` on landing and cancels itself, since this cancel may
    /// reach the server first.
    func cancelDictation() async {
        dictation = .idle
        _ = try? await store.call(server, "cancel_transcription", as: JSON.self)
    }

    // MARK: New session

    /// Read on every new task: the notch outlives Dray, where projects get attached.
    func loadPicks() async {
        do {
            async let p: [Project] = store.call(server, "list_projects")
            async let a: [AgentAvailability] = store.call(server, "agent_availability")
            (projects, agents) = try await (p, a)
            if !projects.contains(where: { $0.path == projectPath }) {
                projectPath = projects.max { $0.lastSelected < $1.lastSelected }?.path
            }
            // The track draws the first installed agent for a missing pick, so send that one too.
            if let first = agents.first(where: \.available), !agents.contains(where: { $0.harness == harness && $0.available }) {
                harness = first.harness
            }
            await loadModels()
        } catch {
            notice = error.localizedDescription
        }
    }

    func loadModels() async {
        let h = harness
        guard models[h] == nil else { return }
        // A failure caches nothing, or a read made before the socket was up
        // would leave the picker empty for the life of the process.
        do {
            models[h] = try await store.call(server, "list_models", ["harness": .string(h)])
        } catch {
            notice = error.localizedDescription
        }
    }

    func pickModel(_ id: String) {
        modelPicks[harness] = id
        Prefs.set(modelPicks, "models")
    }

    /// The desktop's shortlist before the reader stars anything: every row not
    /// marked secondary, and the current pick whatever it is.
    var shortlist: [Model] {
        (models[harness] ?? []).filter { !($0.secondary ?? false) || $0.id == modelId }
    }

    func pickEffort(_ level: String, for model: String) {
        effortPicks[model] = level
        Prefs.set(effortPicks, "efforts")
    }

    // MARK: Sending

    @discardableResult
    func send() async -> Bool {
        // The words still being spoken belong to this message, so a failed
        // transcription keeps the draft open, its notice and Retry with it.
        if dictation == .recording, !(await stopDictation()) { return false }
        // Closing the microphone takes the drawing still on screen; its image lands a moment later.
        // ponytail: polls for up to 30s; an awaitable per held row if this ever needs to be exact.
        var waited = 0
        while rows.contains(where: \.pending), waited < 300 {
            try? await Task.sleep(for: .milliseconds(100))
            waited += 1
        }
        // After the wait: a dictation started meanwhile holds words this send would leave behind.
        guard dictation == .idle else { return false }
        let text = prompt, files = attachments
        guard canSend, !sending, let target else { return false }
        sending = true
        defer { sending = false }
        // Only what went out is cleared: the draft stays editable while the request runs.
        let sentRows = Set(rows.map(\.id)), sentTyping = typing
        let sent: SessionKey?
        switch target {
        case .session(let k):
            sent = await store.send(k, text, attachments: files) ? k : nil
            if sent == nil { notice = store.lastError }
        case .new:
            sent = await create(text, files)
        }
        guard let sent else { return false }
        rows.removeAll { sentRows.contains($0.id) }
        if typing == sentTyping { typing = "" }
        lastUsed = sent.id
        UserDefaults.standard.set(sent.id, forKey: "notch.lastSession")
        self.target = .session(sent)
        self.sent = true
        let visit = opens
        Task {
            try? await Task.sleep(for: .milliseconds(900))
            // A reopened panel is another visit, and a recording begun meanwhile is the reader's.
            if opens == visit, self.sent, !listening { hide() }
        }
        return true
    }

    /// `useSessions.ts`'s argument set for a new session, from the bar's picks.
    private func create(_ text: String, _ files: [String]) async -> SessionKey? {
        guard let cwd = projectPath else {
            notice = "Pick a project first."
            return nil
        }
        let id = UUID().uuidString.lowercased()
        do {
            let outcome: SendOutcome = try await store.call(server, "send_msg", [
                "sessionId": .string(id),
                "prompt": .string(text),
                "attachmentPaths": .array(files.map { .string($0) }),
                "harness": .string(harness),
                "model": .string(modelId),
                "effort": JSON(effort),
                "permissionMode": .string(Picks.stanceFor(harness, stance)),
                "fast": .bool(false),
                "cwd": .string(cwd),
                // No branch picker here, so the server reads the checkout's own at creation.
                "branch": nil,
                "useWorktree": .bool(worktree),
                "worktreeName": nil,
                "baseRef": nil,
                "isNewSession": true,
            ])
            if let item = outcome.snapshot { store.created(server, item) }
            return SessionKey(server: server, id: id)
        } catch {
            notice = error.localizedDescription
            return nil
        }
    }

    func addTyped() {
        let text = typing.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        rows.append(Row(text: text, said: false))
        typing = ""
    }

    // MARK: Dictation

    private struct Refusal: Decodable { let kind: String }
    private struct Outcome: Decodable {
        let kind: String
        let value: JSON?
    }

    /// Through the server to Dray's own recorder and model: one place sets up dictation.
    func startDictation() async {
        guard dictation == .idle else { return }
        dictation = .starting
        do {
            let refusal: Refusal? = try await store.call(server, "start_transcription")
            guard dictation == .starting else {
                if refusal == nil { _ = try? await store.call(server, "cancel_transcription", as: JSON.self) }
                return
            }
            if let refusal {
                dictation = .idle
                notice = refusal.kind == "needsModel"
                    ? "Pick a dictation model in Dray → Settings → Transcription."
                    : "Dray needs the microphone. Allow it in System Settings → Privacy & Security → Microphone."
                return
            }
            dictation = .recording
            listShown = false
            Sound.start?.play()
            Task { await pollLevel() }
        } catch {
            dictation = .idle
            notice = error.localizedDescription
        }
    }

    /// Whether the model answered: words, or a verdict that there were none.
    @discardableResult
    func stopDictation() async -> Bool {
        guard dictation == .recording else { return false }
        return await transcribe("stop_transcription", [:])
    }

    /// Runs the model again over the recording a failed run kept, so the words need not be said twice.
    func retryDictation() async {
        guard dictation == .idle, let path = retryPath else { return }
        await transcribe("retry_transcription", ["path": .string(path)])
    }

    @discardableResult
    private func transcribe(_ cmd: String, _ args: [String: JSON]) async -> Bool {
        dictation = .transcribing
        defer { dictation = .idle }
        do {
            return place(try await store.call(server, cmd, args, timeout: .seconds(180)))
        } catch {
            notice = error.localizedDescription
        }
        return false
    }

    /// The words so far, as a row before the screenshot about to join the
    /// draft; the microphone stays open for what is said about it. Silence
    /// before the shot is ordinary, so it says nothing.
    func cutDictation(before shot: UUID) async {
        guard dictation == .recording else { return }
        await cut("cut_transcription", [:], before: shot)
    }

    /// Runs a failed cut's recording again, into the place it was cut from.
    func retryCut() async {
        guard let lost = lostCut, !retryingCut else { return }
        retryingCut = true
        defer { retryingCut = false }
        await cut("retry_transcription", ["path": .string(lost.path)], before: lost.before)
    }

    private func cut(_ cmd: String, _ args: [String: JSON], before shot: UUID) async {
        do {
            let o: Outcome = try await store.call(server, cmd, args, timeout: .seconds(180))
            switch o.kind {
            case "text":
                lostCut = nil
                if let text = o.value?.string, !text.isEmpty {
                    rows.insert(Row(text: text, said: true), at: rows.firstIndex { $0.id == shot } ?? rows.endIndex)
                }
            case "empty", "noAudio":
                lostCut = nil
            default:
                if let path = o.value?["audioPath"]?.string {
                    lostCut = (path, shot)
                } else {
                    notice = o.value?["message"]?.string ?? "Dictation failed."
                }
            }
        } catch {
            notice = error.localizedDescription
        }
    }

    /// Whether the model answered: words become a row, every other outcome a notice.
    @discardableResult
    private func place(_ o: Outcome) -> Bool {
        switch o.kind {
        case "text":
            if let text = o.value?.string, !text.isEmpty {
                rows.append(Row(text: text, said: true))
                Sound.stop?.play()
            }
            return true
        case "empty":
            notice = "No words heard."
            return true
        case "needsModel": notice = "Pick a dictation model in Dray → Settings → Transcription."
        case "noAudio": notice = "Dray heard nothing. Check the microphone."
        default: notice = o.value?["message"]?.string ?? "Dictation failed."
        }
        // Set after the notice, whose own setter clears it.
        retryPath = o.value?["audioPath"]?.string
        return false
    }

    func toggleDictation() async {
        if dictation == .recording { await stopDictation() } else { await startDictation() }
    }

    /// Polled rather than pushed, as the composer's is: a missed reading is a dropped frame.
    private func pollLevel() async {
        while dictation == .recording {
            level = (try? await store.call(server, "transcription_level", as: Float.self)) ?? 0
            try? await Task.sleep(for: .milliseconds(50))
        }
        level = 0
    }
}

/// Dray's own dictation tones, so the two dictate alike.
enum Sound {
    static let start = NSSound(named: "dictate-start")
    static let stop = NSSound(named: "dictate-stop")
    static let done = NSSound(named: "notification")
}
