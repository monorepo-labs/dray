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
    /// Above the Dock the window reaches this far below the cards, or their
    /// shadows stop in a straight line at its edge.
    static let shadowRoom: CGFloat = 12

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
            if dictation == .starting { sent = false; notice = nil; drawHint = UserDefaults.standard.integer(forKey: "island.drawHints") < Self.drawHints }
            if !listening { drawHint = false }
            if (dictation == .recording) != (oldValue == .recording) {
                recordingSince = dictation == .recording ? Date() : nil
                recordingChanged(dictation == .recording)
                // Counted once the microphone is open, so a refused start spends nothing.
                if dictation == .recording, drawHint {
                    UserDefaults.standard.set(UserDefaults.standard.integer(forKey: "island.drawHints") + 1, forKey: "island.drawHints")
                }
            }
        }
    }
    var listening: Bool { dictation == .starting || dictation == .recording }
    /// Makes the panel key again. The drawing overlay lets clicks through while
    /// recording, so a click elsewhere takes the keys, and focus in a panel
    /// that is not key leaves ⏎ going to that other app.
    @ObservationIgnored var takeKeys: () -> Void = {}
    /// For the drawing overlay, up for exactly as long as the microphone records.
    @ObservationIgnored var recordingChanged: (Bool) -> Void = { _ in }
    /// When the microphone opened, for the timer; `nil` unless recording.
    var recordingSince: Date?
    var mode = InputMode(rawValue: UserDefaults.standard.string(forKey: "island.mode") ?? "") ?? .compact {
        didSet { UserDefaults.standard.set(mode.rawValue, forKey: "island.mode") }
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
    /// A ⌘S on its way; a second press meanwhile would save the same words twice.
    @ObservationIgnored private var saving = false
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
    var shown = false {
        didSet {
            if oldValue, !shown { released() } else if !oldValue, shown { leaving = nil; coverDone() }
        }
    }
    /// Whether the panel has held the keys since it opened, which is when a bare Esc reaches it.
    var keyed = false
    var closeHint: String { keyed ? "Esc" : "⌘Esc" }
    var notchHeight: CGFloat = 0
    var placement = Placement(rawValue: UserDefaults.standard.string(forKey: "island.placement") ?? "") ?? .notch {
        didSet { UserDefaults.standard.set(placement.rawValue, forKey: "island.placement") }
    }

    /// Takes what Dray's Settings wrote. Assigned only where it moved, or the write-back would bump the menu for nothing.
    func reloadPrefs() {
        let d = UserDefaults.standard
        if let p = Placement(rawValue: d.string(forKey: "island.placement") ?? ""), p != placement { placement = p }
        if let m = InputMode(rawValue: d.string(forKey: "island.mode") ?? ""), m != mode { mode = m }
    }

    // A new session's picks.
    var projects: [Project] = []
    var projectPath: String?
    var agents: [AgentAvailability] = []
    var models: [String: [Model]] = [:]
    var harness = UserDefaults.standard.string(forKey: "island.harness") ?? "claude_code" {
        didSet { UserDefaults.standard.set(harness, forKey: "island.harness") }
    }
    var modelPicks = Prefs.map("models")
    var effortPicks = Prefs.map("efforts")
    var stance = UserDefaults.standard.string(forKey: "island.stance") ?? "auto" {
        didSet { UserDefaults.standard.set(stance, forKey: "island.stance") }
    }
    /// The reader's worktree pick per project; a project never toggled takes one.
    private var worktreeByProject = UserDefaults.standard.dictionary(forKey: "island.worktreeByProject") as? [String: Bool] ?? [:]
    var worktree: Bool {
        get { projectPath.flatMap { worktreeByProject[$0] } ?? true }
        set {
            guard let projectPath else { return }
            worktreeByProject[projectPath] = newValue
            UserDefaults.standard.set(worktreeByProject, forKey: "island.worktreeByProject")
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
    /// What that moment says: Sent, Saved as draft, or what a card's answer did.
    private(set) var sentLabel = "Sent"
    /// Cards answered since the panel opened, so the last one can speak for the lot.
    @ObservationIgnored private var answered = 0
    /// Panel opens, so a refusal landing after a reopen leaves the new count alone.
    @ObservationIgnored private var visit = 0
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
    @ObservationIgnored private var lastUsed = UserDefaults.standard.string(forKey: "island.lastSession")

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
        // The answered card is gone to the reader already, so no pill waits on it.
        return store.asks.filter { $0.value.contains { $0.id != leaving?.event.id } }
            .sorted { (first($0.value), $0.key.id) < (first($1.value), $1.key.id) }
            .map(\.key)
    }

    /// The card the panel draws in place of the draft: the picked tab's oldest
    /// ask, so answering one moves to the next. Held back while the reader is
    /// busy in the panel, unless they came for the cards.
    var ask: (key: SessionKey, event: AgentEvent)? {
        if !shown, let leaving { return leaving }
        guard cardsFirst || !busy else { return nil }
        let keys = attention
        guard let key = askTab.flatMap({ keys.contains($0) ? $0 : nil }) ?? keys.first,
              let event = store.asks[key]?.first else { return nil }
        return (key, event)
    }

    /// Something under way in the panel that news must not interrupt: words
    /// being said, a draft not yet sent, the list or a menu open.
    var busy: Bool { dictation != .idle || !rows.isEmpty || !typing.isEmpty || listShown || openMenu != nil }
    /// Set by the attention pill, whose whole point is the cards.
    @ObservationIgnored var cardsFirst = false
    /// The last card, answered: drawn while the panel closes, since the
    /// answer's reply lands mid-close and the draft flashed in its place.
    private var leaving: (key: SessionKey, event: AgentEvent)?
    /// News that landed while the reader was busy in the panel, so nothing
    /// sounded; it sounds once, when it can first be seen.
    @ObservationIgnored private var heldAsk = false
    @ObservationIgnored private var heldDone = false

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
            if !fresh.isEmpty {
                // An idle open panel draws the card at once, which says enough.
                if !shown { announce() } else if busy || sent { heldAsk = true }
                coverDone()
                // Any still unseen waits, its clock stopped until it is.
                doneClock += 1
            }
            // The last card answered is the panel's job done.
            // Not while the reader is busy: a card answered elsewhere leaves them their draft.
            // Nor under a card's flash, which closes the panel itself once read,
            // nor on a new session, which the reader asked for with ⌘N.
            if ids.isEmpty, hadCards, shown, !busy, !sent, target != .new { hide() }
            // Answered elsewhere with the panel shut: the done pill is back in view, its clock with it.
            if ids.isEmpty, hadCards, !shown {
                unseenDone = []
                if !done.isEmpty { startDoneClock() }
            }
            pillChanged()
        }
    }

    /// The pill's edge lit for news, for a moment: kept here rather than in
    /// the pill, which is drawn afresh on every close and lit again with it.
    var glowing = false
    @ObservationIgnored private var glowClock = 0

    /// News reaching a shut panel: the sound and the glow, once.
    func announce(sound: Bool = true) {
        if sound { chime() }
        glowClock += 1
        let clock = glowClock
        glowing = true
        Task {
            try? await Task.sleep(for: .seconds(2))
            guard clock == glowClock else { return }
            glowing = false
        }
    }

    /// Dray in front sounds its own notice, so a chime here would double it.
    private func chime() {
        if !Self.drayInFront { Sound.done?.play() }
    }

    /// The panel shut: what was held is shown now, as the pill, with its one sound.
    private func released() {
        cardsFirst = false
        let ask = heldAsk && !attention.isEmpty, finished = heldDone && !done.isEmpty
        heldAsk = false
        heldDone = false
        if ask || finished { announce() }
        if attention.isEmpty { unseenDone = [] }
        // Expiry waits while the panel is open, so any pill left gets its clock back here.
        if !done.isEmpty { startDoneClock() }
    }

    /// A held card came into view once the reader was free: its sound now.
    func cardShown() {
        guard heldAsk, shown else { return }
        heldAsk = false
        chime()
    }

    /// The attention pill: the panel, on the cards, whatever the draft holds.
    func openCards() {
        cardsFirst = true
        present()
    }

    /// A dev build shares the release identifier, so this answers for both.
    static var drayInFront: Bool { NSWorkspace.shared.frontmostApplication?.bundleIdentifier == "com.yogesh.dray" }

    var isQuestions: Bool { if case .questionsAsked = ask?.event.payload { true } else { false } }

    /// Sessions that finished while Dray was out of sight, newest last: the
    /// done pill, in place of Dray's banner, until its clock runs out.
    var done: [SessionKey] = [] { didSet { pillChanged() } }
    /// Held while the pointer is on the pill, so it never goes from under a click.
    var doneHovered = false { didSet { if !doneHovered { startDoneClock() } } }
    @ObservationIgnored private var doneClock = 0
    /// Finished while the panel or the attention pill covered the done pill,
    /// so never seen; only these come back once it is uncovered.
    @ObservationIgnored private var unseenDone: Set<SessionKey> = []
    static let doneFor: Duration = .seconds(6)

    /// Something to draw while the panel is shut: a card waiting outranks news.
    var hasPill: Bool { !attention.isEmpty || !done.isEmpty }

    /// Dray says a session finished where its banner would have.
    func finished(_ id: String) {
        let key = SessionKey(server: server, id: id)
        done.removeAll { $0 == key }
        done.append(key)
        if shown || !attention.isEmpty { unseenDone.insert(key) } else { unseenDone.remove(key) }
        // Its pill only hangs while the panel is shut, so its clock starts then,
        // and one already running must not clear this with what it was timing.
        if shown {
            heldDone = true
            doneClock += 1
        } else {
            announce()
            startDoneClock()
        }
    }

    /// The panel or the attention pill now covers the done pill: what it
    /// already showed is spent, not brought back when it is uncovered.
    private func coverDone() {
        if done.contains(where: { !unseenDone.contains($0) }) { done.removeAll { !unseenDone.contains($0) } }
    }

    private func startDoneClock() {
        doneClock += 1
        let clock = doneClock
        Task {
            try? await Task.sleep(for: Self.doneFor)
            // Only a pill on screen runs out; one under the panel or the attention pill waits.
            if clock == doneClock, !doneHovered, !shown, attention.isEmpty { done = [] }
        }
    }

    /// A finished session's title clicked: the island opens on it, and the news is spent.
    func openDone(_ key: SessionKey) {
        done = []
        pick(.session(key))
        present()
    }

    /// The done pill's Open in app: Dray comes forward, and its sidebar already marks the rest unread.
    func openDoneInApp(_ key: SessionKey) {
        done = []
        Task { await showInApp(key) }
    }

    /// The pill drawn while the panel is shut is the done pill, which ⌘⏎ answers.
    var donePillUp: Bool { !shown && attention.isEmpty && !done.isEmpty }

    /// A number key on a card: a permission's option outright, a question's toggled.
    func pickOption(_ i: Int) {
        // The flash covers the card, so a key now would answer one the reader cannot see.
        guard !sent else { return }
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

    /// Open in app on the done pill, ⌘⏎ under it, or ⌘-click on the title: Dray's window, on this session. A closed app is
    /// launched and asked again once its window can answer.
    func showInApp(_ key: SessionKey) async {
        let args: [String: JSON] = ["sessionId": .string(key.id)]
        for attempt in 0..<16 {
            if (try? await store.call(server, "show_session", args, as: JSON.self)) != nil {
                hide()
                return
            }
            if attempt == 0 {
                // Bundled, the island sits at Dray.app/Contents/Helpers; in a dev build there is no Dray around it.
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
        let option = r.options.first { $0.id == optionId }
        let label = switch option?.kind {
        case "once"?: "Allowed once"
        case "always_rule"?, "always_directory"?, "switch_mode"?: "Always allowed"
        case "deny"?: "Denied"
        default: option?.behavior == "deny" ? "Denied" : "Allowed once"
        }
        let counted = visit
        closeOnLastCard(key, e, label)
        await store.respond(key, requestId: r.requestId, optionId: optionId)
        keepIfRefused(key, e, counted)
    }

    func answer(_ answers: [String: String]) async {
        guard let (key, e) = ask, case .questionsAsked(let r) = e.payload else { return }
        let counted = visit
        closeOnLastCard(key, e, "Sent")
        await store.answer(key, requestId: r.requestId, answers: answers)
        keepIfRefused(key, e, counted)
    }

    /// The last card answered says what was done, then the panel closes, all
    /// before the reply removes it, which drew the draft for a moment first.
    /// Several answered in one visit are told as a group.
    private func closeOnLastCard(_ key: SessionKey, _ e: AgentEvent, _ label: String) {
        answered += 1
        guard !busy, attention == [key], store.asks[key]?.count == 1 else { return }
        leaving = (key, e)
        flash(answered > 1 ? "\(answered) answered" : label)
    }

    /// An answer that did not land leaves the card waiting: back on screen, or its pill back.
    private func keepIfRefused(_ key: SessionKey, _ e: AgentEvent, _ counted: Int) {
        guard store.asks[key]?.contains(where: { $0.id == e.id }) == true else { return }
        // Uncounted, or answering it again on retry reads as two cards answered.
        if visit == counted { answered = max(answered - 1, 0) }
        guard leaving?.event.id == e.id else { return }
        leaving = nil
        sent = false
        pillChanged()
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

    /// The session Dray's window has open, taken as the pick. Silent on any
    /// failure — no app, the new-task page, a remote session — which leaves the pick as it was.
    func adoptAppSelection() async {
        guard case .string(let id)? = try? await store.call(server, "selected_session", as: JSON.self, timeout: .milliseconds(500))
        else { return }
        let k = SessionKey(server: server, id: id)
        if store.items[k] != nil { pick(.session(k)) }
    }

    /// With nothing picked, the last session picked, else the newest.
    func opened() {
        // Cleared here rather than at the close, which would flash the draft back mid-shrink.
        sent = false
        answered = 0
        visit += 1
        keyed = true
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
            // A new visit to the draft, so an answer's flash must not cover it.
            sent = false
            opens += 1
            Task { await loadPicks() }
        case .session(let k):
            lastUsed = k.id
            UserDefaults.standard.set(k.id, forKey: "island.lastSession")
        }
    }

    /// ↑/↓ through the list; from a new session, ↓ lands on the first row.
    func move(_ delta: Int) {
        let opening = !listShown
        listShown = true
        let list = listed
        guard !list.isEmpty else { return }
        // Opening the list, either arrow lands on its top row, wherever the panel was.
        let at = opening ? nil : key.flatMap { k in list.firstIndex { $0.key == k } }
        let next = at.map { min(max($0 + delta, 0), list.count - 1) } ?? 0
        pick(.session(list[next].key))
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

    /// Read on every new task: the island outlives Dray, where projects get attached.
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

    /// The desktop composer's chords on the new-session bar: ⌘⇧A, ⇧Tab, ⌘⇧E and ⌘⇧P
    /// step agent, model, effort and project the way the app's do; ⌘⇧T is the worktree switch.
    func nextAgent() { harness = after(agents.filter(\.available).map(\.harness), harness) ?? harness }
    func nextModel() { if let id = after(shortlist.map(\.id), modelId) { pickModel(id) } }
    func nextEffort() {
        if let m = model, let level = after(m.efforts, effort) { pickEffort(level, for: m.id) }
    }
    func nextProject() { projectPath = after(projects.map(\.path), projectPath) ?? projectPath }

    private func after<T: Equatable>(_ list: [T], _ current: T?) -> T? {
        guard !list.isEmpty else { return nil }
        let i = current.flatMap { list.firstIndex(of: $0) } ?? -1
        return list[(i + 1) % list.count]
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
        guard canSend, !sending, !saving, let target else { return false }
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
        UserDefaults.standard.set(sent.id, forKey: "island.lastSession")
        self.target = .session(sent)
        Sound.send?.play()
        flash("Sent")
        return true
    }

    /// Says it went, then closes the panel, or turns to a card held while the
    /// reader was writing, since they are already here.
    private func flash(_ label: String) {
        sentLabel = label
        sent = true
        let visit = opens
        Task {
            try? await Task.sleep(for: .milliseconds(900))
            // A reopened panel is another visit, and a recording begun meanwhile is the reader's.
            guard opens == visit, self.sent, !listening else { return }
            if attention.isEmpty { hide() } else { sent = false }
        }
    }

    /// The app's `toISOString`, which the drafts list orders by.
    private static let stamp = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    /// ⌘S: the text becomes a draft in Dray's sidebar, a new task on the bar's
    /// picks, or on the pinned session's own settings when one is up. Drafts hold
    /// text alone, so a draft with an image in it is refused rather than half kept.
    func saveDraft() async {
        let text = prompt
        guard dictation == .idle, !sending, !saving, !rows.contains(where: \.pending),
              !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, let target else { return }
        guard attachments.isEmpty else {
            notice = "Drafts hold text only. Remove the images to save one."
            return
        }
        saving = true
        defer { saving = false }
        var draft: [String: JSON] = [
            "id": .string(UUID().uuidString.lowercased()),
            "prompt": .string(text),
            "created": .string(Self.stamp.string(from: Date())),
        ]
        switch target {
        case .session(let k):
            guard let item = store.items[k] else { return }
            draft["projectPath"] = .string(item.projectPath)
            draft["harness"] = .string(item.harness)
            draft["model"] = .string(item.model)
            draft["effort"] = JSON(item.effort)
            draft["permissionMode"] = .string(item.permissionMode)
            draft["fast"] = .bool(item.fast ?? false)
            draft["useWorktree"] = .bool(item.worktreeName != nil || item.worktreeRemoved == true)
        case .new:
            guard let projectPath else {
                notice = "Pick a project first."
                return
            }
            draft["projectPath"] = .string(projectPath)
            draft["harness"] = .string(harness)
            draft["model"] = .string(modelId)
            draft["effort"] = JSON(effort)
            draft["permissionMode"] = .string(Picks.stanceFor(harness, stance))
            draft["fast"] = .bool(false)
            draft["useWorktree"] = .bool(worktree)
        }
        let savedRows = Set(rows.map(\.id)), savedTyping = typing
        do {
            let _: JSON = try await store.call(server, "create_draft", ["draft": .object(draft)])
        } catch {
            notice = error.localizedDescription
            return
        }
        rows.removeAll { savedRows.contains($0.id) }
        if typing == savedTyping { typing = "" }
        flash("Saved as draft")
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
        // Keys first, so the view's focus on going idle lands in a key window.
        defer {
            if shown { takeKeys() }
            dictation = .idle
        }
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

/// Dray's own dictation tones, so the two dictate alike, and the island's send.
enum Sound {
    static let start = NSSound(named: "dictate-start")
    static let stop = NSSound(named: "dictate-stop")
    static let done = NSSound(named: "notification")
    /// Shimmer lift from `demo/send-sound.html`, rendered at 25%.
    static let send = NSSound(named: "send")
}
