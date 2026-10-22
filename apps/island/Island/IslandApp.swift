import AppKit
import Carbon
import SwiftUI

// The status demo compiles the island's views with a `@main` of its own.
#if !ISLAND_DEMO
@main
struct IslandApp: App {
    @NSApplicationDelegateAdaptor(Delegate.self) private var delegate
    var body: some Scene { Settings { EmptyView() } }
}
#endif

/// This Mac's server, as `serve-port` and `serve-token` in Dray's home name it.
/// Read at every connect, since a restarted server listens on a fresh port.
/// Dray hands its home over as `DRAY_HOME`, so a dev build's island reaches the dev server.
func localServer() -> (url: String, token: String)? {
    let home = ProcessInfo.processInfo.environment["DRAY_HOME"].map { URL(fileURLWithPath: $0) }
        ?? FileManager.default.homeDirectoryForCurrentUser.appending(path: ".dray")
    guard let port = (try? String(contentsOf: home.appending(path: "serve-port"), encoding: .utf8))?
            .split(separator: "\n").first,
          let token = try? String(contentsOf: home.appending(path: "serve-token"), encoding: .utf8)
    else { return nil }
    return ("ws://127.0.0.1:\(port)", token.trimmingCharacters(in: .whitespacesAndNewlines))
}

enum Placement: String, CaseIterable {
    case notch, bottom

    var label: String { self == .notch ? "Notch" : "Bottom" }
}

/// Answers the first click, so the pill opens on one press while the panel is not key.
final class FirstClickHostingView<Content: View>: NSHostingView<Content> {
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

/// A panel that takes keys without making Dray Island the active app, so the
/// app the reader is working in keeps its place in the window order.
final class IslandPanel: NSPanel {
    override var canBecomeKey: Bool { true }
}

@MainActor
final class Delegate: NSObject, NSApplicationDelegate {
    private var panel: IslandPanel?
    /// The pills' own window, beside the panel and never key; see `PillsView`.
    private var pills: NSPanel?
    private var composer: Composer?
    private var hotkey: ModifierTap?
    private var keys: Any?
    /// ⌘Esc from anywhere, held while the panel is open: bare Esc only reaches it while it has focus,
    /// and AppKit never hands ⌘Esc to the key monitor at all.
    private var closeKey: HotKey?
    /// ⌘⇧2, beside macOS's own ⌘⇧3/4/5: a screenshot into the draft from anywhere.
    private var captureKey: HotKey?
    /// ⌘⏎ from anywhere, held while the done pill is up: Open in app on the newest.
    private var openKey: HotKey?
    private static weak var shared: Delegate?
    /// The first of a double tap, while the panel is shut.
    private var lastTap: Date?
    /// A tap is waiting on Dray's selection; another meanwhile must not open twice.
    private var askingApp = false
    /// A tap landed while asking, which is the double tap that opens listening.
    private var dictateOnOpen = false
    private var annotation: Annotation?
    /// Over a capture's or a drawing's overlay, so dictation stays in sight and in reach.
    private static let overOverlay = NSWindow.Level(rawValue: NSWindow.Level.screenSaver.rawValue + 1)

    func applicationDidFinishLaunching(_ notification: Notification) {
        waitForServer()
        // Open PRs' checks move on their own; read them while the panel is up, as the phone does on screen.
        Timer.scheduledTimer(withTimeInterval: 30, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let composer = self?.composer, composer.shown else { return }
                Task { await composer.store.pollMarks() }
            }
        }
    }

    /// The recorder is Dray's, so quitting mid-dictation would leave its
    /// microphone open; cancel it first. A `pkill` gets past this.
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard let composer, composer.dictation != .idle else { return .terminateNow }
        Task {
            await composer.cancelDictation()
            sender.reply(toApplicationShouldTerminate: true)
        }
        return .terminateLater
    }

    private static func binaryDate() -> Date? {
        (try? Bundle.main.executableURL?.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate
    }
    private let startedOn = Delegate.binaryDate()
    /// Dray launched while the panel was open or a screenshot ran; the restart waits for it to end.
    private var updatePending = false
    /// The replacement is launching; a second ping meanwhile would start a second one.
    private var restarting = false

    /// An update swaps the bundle under a running island, and Dray's `open` only
    /// finds this one still up, so every Dray launch pings it and it moves itself
    /// onto the new binary — while hidden, never under the reader's hands. A
    /// screenshot hides the panel without being done with it, so it waits too.
    private func updateIfReplaced() {
        guard !restarting, let now = Self.binaryDate(), now != startedOn else { return }
        guard panel?.isVisible != true, composer?.capturing != true else {
            updatePending = true
            return
        }
        updatePending = false
        restarting = true
        let config = NSWorkspace.OpenConfiguration()
        config.createsNewApplicationInstance = true
        config.environment = ProcessInfo.processInfo.environment
        NSWorkspace.shared.openApplication(at: Bundle.main.bundleURL, configuration: config) { _, error in
            DispatchQueue.main.async {
                if error == nil { NSApp.terminate(nil) } else { self.restarting = false }
            }
        }
    }

    /// Dray starts its server before this, but a server mid-restart has no
    /// `serve-port` yet; nothing works without one, so keep looking.
    private func waitForServer() {
        guard localServer() != nil else {
            DispatchQueue.main.asyncAfter(deadline: .now() + 2) { self.waitForServer() }
            return
        }
        let server = Server(id: UUID(), name: "This Mac", url: "")
        let composer = Composer(store: Store(local: server, read: localServer), server: server.id)
        self.composer = composer
        composer.hide = { [weak self, weak composer] in
            composer?.shown = false
            self?.closeKey?.held = false
            self?.showPills()
            self?.settle()
        }
        composer.present = { [weak self] in self?.show() }
        composer.pillChanged = { [weak self] in
            guard let self, let composer = self.composer, !composer.shown else { return }
            if composer.hasPill { place() }
            showPills()
        }
        composer.reposition = { [weak self] in self?.place() }
        composer.capture = { [weak self] in self?.capture() }

        // One size for good, the cards drawn inside it: SwiftUI can animate a
        // card growing and shrinking, where a window resized under it jumps.
        // Its empty, clear part lets clicks through to whatever is beneath.
        let panel = IslandPanel(
            contentRect: NSRect(origin: .zero, size: Self.size),
            styleMask: [.nonactivatingPanel, .borderless, .fullSizeContentView],
            backing: .buffered, defer: false
        )
        // Above the menu bar, so the notch placement can sit over it.
        panel.level = .statusBar
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
        panel.isOpaque = false
        panel.backgroundColor = .clear
        // The cards draw their own; a window shadow would trace the clear window.
        panel.hasShadow = false
        panel.contentView = FirstClickHostingView(rootView: IslandView(composer: composer).environment(composer.store))
        self.panel = panel
        // A plain borderless panel cannot become key, which is the point of it.
        let pills = NSPanel(contentRect: NSRect(origin: .zero, size: Self.size),
                            styleMask: [.nonactivatingPanel, .borderless, .fullSizeContentView],
                            backing: .buffered, defer: false)
        pills.level = .statusBar
        pills.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
        pills.isOpaque = false
        pills.backgroundColor = .clear
        pills.hasShadow = false
        pills.contentView = FirstClickHostingView(rootView: PillsView(composer: composer).environment(composer.store))
        self.pills = pills
        // Only losing the keys moves the hint; getting them back waits for the next open, so it never flickers.
        NotificationCenter.default.addObserver(forName: NSWindow.didResignKeyNotification, object: panel, queue: .main) { [weak composer] _ in
            MainActor.assumeIsolated { composer?.keyed = false }
        }
        // The panel's keys, here rather than on views, which answer only
        // while focus sits inside them. Key codes: Escape 53, N 45, F 3, ↓ 125, ↑ 126, A 0, E 14, T 17, P 35, Tab 48.
        keys = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak composer, weak panel] e in
            // A capture's overlay holds the keys while it runs: Esc there cancels it, not the panel.
            guard panel?.isVisible == true, let composer, composer.shown, !composer.capturing else { return e }
            let mods = e.modifierFlags.intersection([.command, .shift, .option, .control])
            switch (e.keyCode, mods) {
            // Throwing away speech takes ⌘Esc, the hot key below: a bare Esc is too easy a slip mid-sentence.
            case (53, _) where composer.listening: break
            case (53, _): composer.escape()
            // A card takes Return to submit its answers, and digits to pick a permission option.
            case (36, []) where composer.isQuestions: composer.submits += 1
            case (36, []) where composer.ask == nil:
                if composer.listShown { composer.choose() } else { Task { await composer.send() } }
            // Unless the caret is in a card's text box, where a digit is typed.
            case (let code, []) where composer.ask != nil && Self.digits[code] != nil && !(panel?.firstResponder is NSText):
                composer.pickOption(Self.digits[code]!)
            case (45, .command): composer.pick(.new)
            case (3, .command): composer.searches += 1
            case (36, .command): composer.addTyped()
            case (1, .command) where composer.ask == nil: Task { await composer.saveDraft() }
            // The app's composer chords, only where the bar they drive is drawn.
            case (0, [.command, .shift]) where composer.target == .new: composer.nextAgent()
            case (14, [.command, .shift]) where composer.target == .new: composer.nextEffort()
            case (17, [.command, .shift]) where composer.target == .new: composer.worktree.toggle()
            case (35, [.command, .shift]) where composer.target == .new: composer.nextProject()
            case (48, .shift) where composer.target == .new: composer.nextModel()
            // A closed list opens on an arrow only over an empty input; over
            // text, the arrows belong to the caret.
            case (125, []) where composer.openMenu == nil && (composer.listShown || composer.typing.isEmpty): composer.move(1)
            case (126, []) where composer.openMenu == nil && (composer.listShown || composer.typing.isEmpty): composer.move(-1)
            default: return e
            }
            return nil
        }

        hotkey = ModifierTap { [weak self] in self?.pressed() }
        // One chord to remember: mid-recording it throws the speech away, and
        // the next press closes the panel.
        closeKey = HotKey(key: kVK_Escape, mods: cmdKey) { [weak composer] in
            guard let composer else { return }
            if composer.listening { Task { await composer.cancelDictation() } } else { composer.hide() }
        }
        openKey = HotKey(key: kVK_Return, mods: cmdKey) { [weak composer] in
            guard let composer, composer.donePillUp, let key = composer.done.last else { return }
            composer.openDoneInApp(key)
        }
        composer.recordingChanged = { [weak self] recording in
            if recording { self?.startAnnotation() } else { self?.endAnnotation() }
        }
        composer.takeKeys = { [weak self] in self?.panel?.makeKeyAndOrderFront(nil) }
        registerCapture()
        // Dray's Settings writes the picks and then says so, through `notifyutil -p`.
        // A C callback captures nothing, so it finds the delegate through a static;
        // `NSApp.delegate` is SwiftUI's adaptor, not this.
        Self.shared = self
        CFNotificationCenterAddObserver(CFNotificationCenterGetDarwinNotifyCenter(), nil, { _, _, _, _, _ in
            DispatchQueue.main.async {
                MainActor.assumeIsolated { Delegate.shared?.prefsChanged() }
            }
        }, "com.yogesh.dray.island.prefs" as CFString, nil, .deliverImmediately)
        CFNotificationCenterAddObserver(CFNotificationCenterGetDarwinNotifyCenter(), nil, { _, _, _, _, _ in
            DispatchQueue.main.async {
                MainActor.assumeIsolated {
                    Delegate.shared?.prefsChanged()
                    Delegate.shared?.show()
                }
            }
        }, "com.yogesh.dray.island.show" as CFString, nil, .deliverImmediately)
        // A session finished where Dray would have posted its banner. The ids
        // queue under `island.done`, since a Darwin notification carries none.
        CFNotificationCenterAddObserver(CFNotificationCenterGetDarwinNotifyCenter(), nil, { _, _, _, _, _ in
            DispatchQueue.main.async {
                MainActor.assumeIsolated { Delegate.shared?.sessionsDone() }
            }
        }, "com.yogesh.dray.island.done" as CFString, nil, .deliverImmediately)
        CFNotificationCenterAddObserver(CFNotificationCenterGetDarwinNotifyCenter(), nil, { _, _, _, _, _ in
            DispatchQueue.main.async {
                MainActor.assumeIsolated { Delegate.shared?.updateIfReplaced() }
            }
        }, "com.yogesh.dray.island.update" as CFString, nil, .deliverImmediately)
        // The tap's twin for other processes: Dray.app, or a script driving the panel.
        DistributedNotificationCenter.default().addObserver(forName: .init("com.yogesh.dray.island.tap"), object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.pressed() }
        }
    }

    /// Dray's inbox of finished sessions, one empty file each; `island_done_dir` in apps.rs names it too.
    static let doneDir = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent("Library/Caches/com.yogesh.dray.island/done")

    /// Takes the finished sessions Dray dropped, oldest first, deleting only
    /// the files read, so one landing meanwhile waits for its own notification.
    func sessionsDone() {
        let fm = FileManager.default
        let files = (try? fm.contentsOfDirectory(at: Self.doneDir, includingPropertiesForKeys: [.contentModificationDateKey])) ?? []
        func stamp(_ url: URL) -> Date { (try? url.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate ?? .distantPast }
        for file in files.sorted(by: { stamp($0) < stamp($1) }) {
            try? fm.removeItem(at: file)
            composer?.finished(file.lastPathComponent)
        }
    }

    /// The screenshot chord Settings picked: a Carbon key code and modifier
    /// mask, `none` for no chord, ⌘⇧2 when nothing is stored.
    private func registerCapture() {
        captureKey?.held = false
        captureKey = nil
        let stored = UserDefaults.standard.string(forKey: "island.captureKey")
        guard stored != "none" else {
            UserDefaults.standard.set(false, forKey: "island.captureTaken")
            return
        }
        let parts = (stored ?? "").split(separator: " ").compactMap { Int($0) }
        let (key, mods) = parts.count == 2 ? (parts[0], parts[1]) : (kVK_ANSI_2, cmdKey | shiftKey)
        let hotKey = HotKey(key: key, mods: mods) { [weak self] in self?.capture() }
        hotKey.held = true
        captureKey = hotKey
        // Settings reads this back to say the chord does nothing.
        UserDefaults.standard.set(!hotKey.registered, forKey: "island.captureTaken")
    }

    func prefsChanged() {
        composer?.reloadPrefs()
        registerCapture()
        place()
    }

    /// A tap opens the panel; a tap on an open one starts or stops dictating.
    /// So a double tap opens it listening, with no timer to wait out. Settings'
    /// double-tap pick opens only on a second tap close behind the first, read
    /// at every press like the key, so a stray tap never puts the panel up.
    private func pressed() {
        guard let composer else { return }
        if composer.shown, composer.sent {
            // Under Sent the panel is on its way out, so a tap opens it afresh
            // rather than dictating; the new visit cancels the pending close.
            composer.opened()
            panel?.makeKeyAndOrderFront(nil)
        } else if composer.shown {
            Task { await composer.toggleDictation() }
        } else if askingApp {
            // The panel is on its way up, so this is the tap that dictates.
            dictateOnOpen.toggle()
        } else if UserDefaults.standard.string(forKey: "island.tap") == "double",
                  lastTap.map({ Date().timeIntervalSince($0) > 0.4 }) ?? true {
            lastTap = Date()
        } else {
            lastTap = nil
            open()
        }
    }

    /// A tap over Dray's window opens on the session that window has open,
    /// asked before the panel shows so the title never flips under the reader.
    /// The app answers nothing unless its window has focus, so every tap asks.
    private func open() {
        guard let composer, !askingApp else { return }
        askingApp = true
        Task {
            await composer.adoptAppSelection()
            askingApp = false
            show()
            if dictateOnOpen {
                dictateOnOpen = false
                await composer.toggleDictation()
            }
        }
    }

    /// The shot flies into the notch and joins the draft. Mid-recording the
    /// panel stays up over the overlay, so dictation can be seen running on,
    /// and the words so far are cut off ahead of the shot with the microphone
    /// left open, so speech and shots land in the order they came. Otherwise
    /// the panel steps aside, and comes back only if it was open.
    private func capture() {
        // Claimed here, before the first await: a second ⌘⇧2 while the first
        // is still reading the displays would otherwise start a second overlay.
        guard let composer, let panel, !composer.capturing, [.idle, .recording].contains(composer.dictation) else { return }
        composer.capturing = true
        let recording = composer.dictation == .recording, wasShown = composer.shown
        let slot = composer.reserveShot()
        let cut = recording ? Task { await composer.cutDictation(before: slot) } : nil
        if recording {
            panel.level = Self.overOverlay
            // Shown, not touched: its frame is far wider than its card, and over
            // it its own arrow beat the overlay's crosshair.
            panel.ignoresMouseEvents = true
        } else if wasShown {
            composer.hide()
        }
        Task {
            defer {
                composer.capturing = false
                // Dictation may have stopped during the flight or the cut, where `endAnnotation` left the level to this.
                panel.level = annotation == nil ? .statusBar : Self.overOverlay
                if updatePending { updateIfReplaced() }
            }
            var shot: Capture.Shot?
            var failed: String?
            do {
                shot = try await Capture.run()
            } catch {
                failed = error.localizedDescription
            }
            panel.level = annotation == nil ? .statusBar : Self.overOverlay
            panel.ignoresMouseEvents = false
            if recording { panel.makeKeyAndOrderFront(nil) } else if wasShown { show() } else { place() }
            if let shot { await Capture.fly(shot.image, from: shot.frame, to: flyTarget()) }
            // The cut transcribes while the overlay is up; its words go first.
            await cut?.value
            withAnimation(.spring(duration: 0.4, bounce: 0.5)) { composer.fillShot(slot, shot?.path) }
            // After the row, which retires a notice.
            if let failed { composer.notice = failed }
        }
    }

    func show() {
        guard let panel, let composer, !composer.shown else { return }
        composer.opened()
        place()
        panel.makeKeyAndOrderFront(nil)
        composer.shown = true
        closeKey?.held = true
        openKey?.held = false
    }

    /// Takes the window down once the close animation has run, unless
    /// something reopened it meanwhile; leaving is what hands the keys back.
    private func settle() {
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) { [weak self] in
            guard let self, let panel, let composer, !composer.shown else { return }
            panel.orderOut(nil)
            if updatePending { updateIfReplaced() }
        }
    }

    /// The pill window up while there is a pill to draw, and away otherwise.
    /// Drawn, never key: a pill must not take keys from the app being typed in.
    private func showPills() {
        guard let pills, let composer else { return }
        openKey?.held = composer.donePillUp
        if composer.hasPill {
            pills.orderFrontRegardless()
        } else {
            // After the pill's own exit, which the view animates.
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) { [weak self] in
                guard let self, let composer = self.composer, !composer.hasPill else { return }
                self.pills?.orderOut(nil)
            }
        }
    }

    /// Key codes of 1 through 9, which are not in order on the keyboard.
    private static let digits: [UInt16: Int] = [18: 0, 19: 1, 20: 2, 21: 3, 23: 4, 22: 5, 26: 6, 28: 7, 25: 8]

    /// Where a shot flies: into the open card's rows, or into the notch itself
    /// while the panel is away.
    private func flyTarget() -> NSPoint {
        guard let panel, let composer else { return .zero }
        let f = panel.frame
        return switch (composer.placement, composer.shown) {
        case (.notch, true): NSPoint(x: f.midX, y: f.maxY - composer.notchHeight - 40)
        case (.notch, false): NSPoint(x: f.midX, y: f.maxY - composer.notchHeight / 2)
        case (.bottom, true): NSPoint(x: f.midX, y: f.minY + Composer.shadowRoom + 60)
        case (.bottom, false): NSPoint(x: f.midX, y: f.minY + Composer.shadowRoom)
        }
    }

    /// Drawing on the screen is part of dictating: the overlay is up while the
    /// microphone records, and holding ⇧ draws on it.
    private func startAnnotation() {
        guard let composer, let panel, annotation == nil else { return }
        annotation = Annotation(composer: composer) { [weak self] shot in
            guard let self else { return }
            await Capture.fly(shot.image, from: shot.frame, to: flyTarget())
        }
        if annotation != nil { panel.level = Self.overOverlay }
    }

    /// Takes the moment still being drawn, if any, and puts the screen back.
    private func endAnnotation() {
        guard let a = annotation else { return }
        annotation = nil
        // A screenshot still open keeps the island over its overlay; it puts the level back itself.
        if composer?.capturing != true { panel?.level = .statusBar }
        Task { await a.end() }
    }

    /// Room for the composer, the task list and an open dropdown, plus shadow.
    static let size = CGSize(width: Composer.width + 48, height: 680)

    /// Anchors the panel to its placement: hanging from the notch, or centred
    /// above the Dock. A notch pick on a display with none falls to top centre.
    private func place() {
        guard let panel, let composer else { return }
        let notched = NSScreen.screens.first { $0.safeAreaInsets.top > 0 }
        let screen = (composer.placement == .notch ? notched : nil) ?? NSScreen.main ?? NSScreen.screens[0]
        let size = Self.size
        let origin = switch composer.placement {
        case .notch: NSPoint(x: screen.frame.midX - size.width / 2, y: screen.frame.maxY - size.height)
        case .bottom: NSPoint(x: screen.visibleFrame.midX - size.width / 2, y: screen.visibleFrame.minY + Self.hiddenDock(screen) - Composer.shadowRoom)
        }
        composer.notchHeight = composer.placement == .notch ? screen.safeAreaInsets.top : 0
        panel.setFrame(NSRect(origin: origin, size: size), display: true)
        pills?.setFrame(NSRect(origin: origin, size: size), display: true)
    }

    /// A Dock that hides itself reserves nothing in `visibleFrame`, so the panel
    /// sat on the screen's edge and the Dock slid up over it. Its height is
    /// read off its own icon size.
    /// ponytail: tile size plus the Dock's margins, measured at 63pt; magnification
    /// and a Dock on another display are not read.
    private static func hiddenDock(_ screen: NSScreen) -> CGFloat {
        let dock = "com.apple.dock" as CFString
        guard screen.visibleFrame.minY == screen.frame.minY,
              CFPreferencesCopyAppValue("autohide" as CFString, dock) as? Bool == true,
              (CFPreferencesCopyAppValue("orientation" as CFString, dock) as? String ?? "bottom") == "bottom"
        else { return 0 }
        let tile = CFPreferencesCopyAppValue("tilesize" as CFString, dock) as? CGFloat ?? 48
        return tile + 20
    }
}

/// The reader's modifier tapped alone: down and up within 0.4s with no key or
/// click between, so ⌃C and a ⌃-click never count. Only modifier changes are
/// watched, which needs no Accessibility grant — one tied to the build was lost
/// on every rebuild. The keys and clicks between are read off the system's own
/// event counters, which need nothing either.
final class ModifierTap {
    private var downAt: Date?
    private var inputsAtDown: UInt32 = 0
    private var monitors: [Any] = []

    /// Dray's Settings writes `island.key`; read at every press, so a change lands without a restart.
    private static var key: NSEvent.ModifierFlags {
        switch UserDefaults.standard.string(forKey: "island.key") {
        case "option": .option
        case "command": .command
        default: .control
        }
    }

    /// The key's symbol, for the placeholder.
    static var symbol: String {
        switch key {
        case .option: "⌥"
        case .command: "⌘"
        default: "⌃"
        }
    }

    init(_ action: @escaping () -> Void) {
        let handle: (NSEvent) -> Void = { [weak self] e in
            guard let self else { return }
            let mods = e.modifierFlags.intersection(.deviceIndependentFlagsMask).subtracting([.capsLock, .numericPad, .function])
            if mods == Self.key {
                downAt = Date()
                inputsAtDown = Self.inputs()
            } else if mods.isEmpty, let d = downAt, Date().timeIntervalSince(d) < 0.4, Self.inputs() == inputsAtDown {
                downAt = nil
                action()
            } else {
                downAt = nil
            }
        }
        monitors = [
            NSEvent.addGlobalMonitorForEvents(matching: .flagsChanged, handler: handle) as Any,
            // Global monitors skip this app's own events, so the panel needs its own.
            NSEvent.addLocalMonitorForEvents(matching: .flagsChanged) { handle($0); return $0 } as Any,
        ]
    }

    /// Keys pressed and clicks made since login, every source together.
    private static func inputs() -> UInt32 {
        [CGEventType.keyDown, .leftMouseDown, .rightMouseDown, .otherMouseDown].reduce(0) {
            $0 &+ CGEventSource.counterForEventType(.combinedSessionState, eventType: $1)
        }
    }
}

/// A Carbon hot key: it reaches the panel whether or not the panel has focus,
/// and needs no Accessibility grant. Held only while wanted, so the chord is
/// every other app's the rest of the time.
final class HotKey {
    private static var actions: [UInt32: () -> Void] = [:]
    private static var installed = false
    private let id: UInt32
    private let key: UInt32
    private let mods: UInt32
    private var ref: EventHotKeyRef?

    init(key: Int, mods: Int, _ action: @escaping () -> Void) {
        Self.install()
        id = UInt32(Self.actions.count + 1)
        self.key = UInt32(key)
        self.mods = UInt32(mods)
        Self.actions[id] = action
    }

    /// Whether the system took the chord; another app's hot key can hold it.
    private(set) var registered = false

    var held = false {
        didSet {
            guard held != oldValue else { return }
            if held {
                registered = RegisterEventHotKey(key, mods, EventHotKeyID(signature: 0x4452_4159, id: id), GetApplicationEventTarget(), 0, &ref) == noErr
            } else if let ref {
                UnregisterEventHotKey(ref)
                self.ref = nil
            }
        }
    }

    /// One handler for every hot key, told apart by the id each registered with.
    private static func install() {
        guard !installed else { return }
        installed = true
        var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        InstallEventHandler(GetApplicationEventTarget(), { _, event, _ in
            var hit = EventHotKeyID()
            GetEventParameter(event, EventParamName(kEventParamDirectObject), EventParamType(typeEventHotKeyID), nil, MemoryLayout<EventHotKeyID>.size, nil, &hit)
            let id = hit.id
            DispatchQueue.main.async { HotKey.actions[id]?() }
            return noErr
        }, 1, &spec, nil, nil)
    }
}
