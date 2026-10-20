import AppKit
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

    func applicationDidFinishLaunching(_ notification: Notification) {
        waitForServer()
        restartWhenReplaced()
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
        composer.hide = { [weak self] in self?.panel?.orderOut(nil) }
        composer.resized = { [weak self] size in self?.place(size) }

        let panel = NotchPanel(
            contentRect: NSRect(x: 0, y: 0, width: Composer.width, height: 120),
            styleMask: [.nonactivatingPanel, .borderless, .fullSizeContentView],
            backing: .buffered, defer: false
        )
        // Above the menu bar, so the notch placement can sit over it.
        panel.level = .statusBar
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.contentView = NSHostingView(rootView: NotchView(composer: composer).environment(composer.store))
        self.panel = panel
        // The panel's keys, here rather than on views, which answer only
        // while focus sits inside them. Key codes: Escape 53, N 45, F 3, ↓ 125, ↑ 126.
        keys = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak composer, weak panel] e in
            guard panel?.isVisible == true, let composer else { return e }
            let mods = e.modifierFlags.intersection([.command, .shift, .option, .control])
            switch (e.keyCode, mods) {
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
        // The tap's twin for other processes: Dray.app, or a script driving the panel.
        DistributedNotificationCenter.default().addObserver(forName: .init("com.yogesh.dray.notch.tap"), object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.pressed() }
        }
    }

    /// A tap opens the panel; a tap on an open one starts or stops dictating.
    /// So a double tap opens it listening, with no timer to wait out.
    private func pressed() {
        guard let panel, let composer else { return }
        if panel.isVisible {
            Task { await composer.toggleDictation() }
        } else {
            composer.opened()
            place(panel.frame.size)
            panel.makeKeyAndOrderFront(nil)
        }
    }

    /// Anchors the panel to its placement: hanging from the notch, or centred
    /// above the Dock. A notch pick on a display with none falls to top centre.
    private func place(_ size: CGSize) {
        guard let panel, let composer else { return }
        let notched = NSScreen.screens.first { $0.safeAreaInsets.top > 0 }
        let screen = (composer.placement == .notch ? notched : nil) ?? NSScreen.main ?? NSScreen.screens[0]
        let origin = switch composer.placement {
        case .notch: NSPoint(x: screen.frame.midX - size.width / 2, y: screen.frame.maxY - size.height)
        case .bottom: NSPoint(x: screen.visibleFrame.midX - size.width / 2, y: screen.visibleFrame.minY + 12)
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
