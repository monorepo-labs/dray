import AppKit
import Carbon
import SwiftUI

@main
struct NotchApp: App {
    @NSApplicationDelegateAdaptor(Delegate.self) private var delegate
    var body: some Scene { Settings { EmptyView() } }
}

/// This Mac's server, as `serve-port` and `serve-token` in Dray's home name it.
/// Read at every connect, since a restarted server listens on a fresh port.
/// Dray hands its home over as `DRAY_HOME`, so a dev build's notch reaches the dev server.
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

/// A panel that takes keys without making Dray Notch the active app, so the
/// app the reader is working in keeps its place in the window order.
final class NotchPanel: NSPanel {
    override var canBecomeKey: Bool { true }
}

@MainActor
final class Delegate: NSObject, NSApplicationDelegate {
    private var panel: NotchPanel?
    private var composer: Composer?
    private var hotkey: ModifierTap?
    private var keys: Any?
    /// ⌥Esc closes the panel from anywhere: bare Esc only reaches it while it has focus.
    private var closeKey: HotKey?
    /// ⌘⇧2, beside macOS's own ⌘⇧3/4/5: a screenshot into the draft from anywhere.
    private var captureKey: HotKey?
    private var annotation: Annotation?
    /// Over a capture's or a drawing's overlay, so dictation stays in sight and in reach.
    private static let overOverlay = NSWindow.Level(rawValue: NSWindow.Level.screenSaver.rawValue + 1)

    func applicationDidFinishLaunching(_ notification: Notification) {
        waitForServer()
        restartWhenReplaced()
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

    /// An update swaps the bundle under a running notch, and Dray's `open` only
    /// finds this one still up, so it moves itself onto the new binary — while
    /// hidden, never under the reader's hands.
    private func restartWhenReplaced() {
        let modified = { (try? Bundle.main.executableURL?.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate }
        let started = modified()
        Timer.scheduledTimer(withTimeInterval: 300, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated {
                guard self?.panel?.isVisible != true, let now = modified(), now != started else { return }
                let config = NSWorkspace.OpenConfiguration()
                config.createsNewApplicationInstance = true
                config.environment = ProcessInfo.processInfo.environment
                NSWorkspace.shared.openApplication(at: Bundle.main.bundleURL, configuration: config) { _, error in
                    if error == nil { DispatchQueue.main.async { NSApp.terminate(nil) } }
                }
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
            // After the close animation, and only if nothing reopened it meanwhile.
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) {
                if composer?.shown == false { self?.panel?.orderOut(nil) }
            }
        }
        composer.reposition = { [weak self] in self?.place() }
        composer.capture = { [weak self] in self?.capture() }

        // One size for good, the cards drawn inside it: SwiftUI can animate a
        // card growing and shrinking, where a window resized under it jumps.
        // Its empty, clear part lets clicks through to whatever is beneath.
        let panel = NotchPanel(
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
        panel.contentView = NSHostingView(rootView: NotchView(composer: composer).environment(composer.store))
        self.panel = panel
        // The panel's keys, here rather than on views, which answer only
        // while focus sits inside them. Key codes: Escape 53, N 45, F 3, ↓ 125, ↑ 126.
        keys = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak composer, weak panel] e in
            // A capture's overlay holds the keys while it runs: Esc there cancels it, not the panel.
            guard panel?.isVisible == true, let composer, composer.shown, !composer.capturing else { return e }
            let mods = e.modifierFlags.intersection([.command, .shift, .option, .control])
            switch (e.keyCode, mods) {
            // Throwing away speech takes ⌘Esc, the hot key below: a bare Esc is too easy a slip mid-sentence.
            case (53, _) where composer.listening: break
            case (53, _): composer.escape()
            case (45, .command): composer.pick(.new)
            case (3, .command): composer.searches += 1
            case (36, .command): composer.addTyped()
            // A closed list opens on an arrow only over an empty input; over
            // text, the arrows belong to the caret.
            case (125, []) where composer.openMenu == nil && (composer.listShown || composer.typing.isEmpty): composer.move(1)
            case (126, []) where composer.openMenu == nil && (composer.listShown || composer.typing.isEmpty): composer.move(-1)
            default: return e
            }
            return nil
        }

        hotkey = ModifierTap { [weak self] in self?.pressed() }
        // ⌘Esc, which AppKit never hands the panel's key monitor.
        let cancel = HotKey(key: kVK_Escape, mods: cmdKey) { [weak composer] in Task { await composer?.cancelDictation() } }
        closeKey = HotKey(key: kVK_Escape, mods: optionKey) { [weak composer] in
            // Mid-sentence it is as inert as bare Esc.
            guard let composer, !composer.listening else { return }
            composer.hide()
        }
        composer.listeningChanged = { cancel.held = $0 }
        composer.recordingChanged = { [weak self] recording in
            if recording { self?.startAnnotation() } else { self?.endAnnotation() }
        }
        captureKey = HotKey(key: kVK_ANSI_2, mods: cmdKey | shiftKey) { [weak self] in
            self?.capture()
        }
        captureKey?.held = true
        // The tap's twin for other processes: Dray.app, or a script driving the panel.
        DistributedNotificationCenter.default().addObserver(forName: .init("com.yogesh.dray.notch.tap"), object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.pressed() }
        }
    }

    /// A tap opens the panel; a tap on an open one starts or stops dictating.
    /// So a double tap opens it listening, with no timer to wait out.
    private func pressed() {
        guard panel != nil, let composer else { return }
        if composer.shown {
            Task { await composer.toggleDictation() }
        } else {
            open()
        }
    }

    private func open() {
        guard let panel, let composer else { return }
        composer.opened()
        place()
        panel.makeKeyAndOrderFront(nil)
        composer.shown = true
        closeKey?.held = true
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
            defer { composer.capturing = false }
            var shot: Capture.Shot?
            var failed: String?
            do {
                shot = try await Capture.run()
            } catch {
                failed = error.localizedDescription
            }
            panel.level = annotation == nil ? .statusBar : Self.overOverlay
            panel.ignoresMouseEvents = false
            if recording { panel.makeKeyAndOrderFront(nil) } else if wasShown { open() } else { place() }
            if let shot { await Capture.fly(shot.image, from: shot.frame, to: flyTarget()) }
            // The cut transcribes while the overlay is up; its words go first.
            await cut?.value
            withAnimation(.spring(duration: 0.4, bounce: 0.5)) { composer.fillShot(slot, shot?.path) }
            // After the row, which retires a notice.
            if let failed { composer.notice = failed }
        }
    }

    /// Where a shot flies: into the open card's rows, or into the notch itself
    /// while the panel is away.
    private func flyTarget() -> NSPoint {
        guard let panel, let composer else { return .zero }
        let f = panel.frame
        return switch (composer.placement, composer.shown) {
        case (.notch, true): NSPoint(x: f.midX, y: f.maxY - composer.notchHeight - 40)
        case (.notch, false): NSPoint(x: f.midX, y: f.maxY - composer.notchHeight / 2)
        case (.bottom, true): NSPoint(x: f.midX, y: f.minY + 60)
        case (.bottom, false): NSPoint(x: f.midX, y: f.minY)
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
        // A screenshot still open keeps the notch over its overlay; it puts the level back itself.
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
        case .bottom: NSPoint(x: screen.visibleFrame.midX - size.width / 2, y: screen.visibleFrame.minY)
        }
        composer.notchHeight = composer.placement == .notch ? screen.safeAreaInsets.top : 0
        panel.setFrame(NSRect(origin: origin, size: size), display: true)
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

    /// Dray's Settings writes `notch.key`; read at every press, so a change lands without a restart.
    private static var key: NSEvent.ModifierFlags {
        switch UserDefaults.standard.string(forKey: "notch.key") {
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

    var held = false {
        didSet {
            guard held != oldValue else { return }
            if held {
                RegisterEventHotKey(key, mods, EventHotKeyID(signature: 0x4452_4159, id: id), GetApplicationEventTarget(), 0, &ref)
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
