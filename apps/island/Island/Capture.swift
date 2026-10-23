import AppKit
import ScreenCaptureKit
import SwiftUI

/// A screenshot marked up before it joins the draft. The screen stays live
/// under a clear overlay until the reader lets go of a region drag: that is
/// the shot, taken then and there with the shutter sound. The region then
/// holds the still and takes ink; Done writes it with its marks to an image
/// file — a path, which is all `send_msg` takes.
@MainActor
enum Capture {
    private static var overlay: IslandPanel?
    private static var keys: Any?
    /// The sound macOS makes for its own screenshots.
    private static let shutter = NSSound(contentsOfFile: "/System/Library/Components/CoreAudio.component/Contents/SharedSupport/SystemSounds/system/Screen Capture.aif", byReference: true)

    /// A finished capture: the file the draft sends, and the picture with the
    /// spot on screen it was taken from, for its flight into the notch.
    struct Shot {
        let path: String
        let image: CGImage
        let frame: NSRect
    }

    /// `nil` for a cancel.
    static func run() async throws -> Shot? {
        guard let screen = screenUnderPointer() else { throw DrayError("No display to capture.") }
        let grab = try await reader(of: screen)
        let model = Marking(size: screen.frame.size) { rect in
            let image = await grab(rect)
            if image != nil { shutter?.playInBackground() }
            return image
        }
        model.notchHeight = screen.safeAreaInsets.top
        let marked: (CGImage, CGRect)? = await withCheckedContinuation { done in
            show(model, on: screen) { done.resume(returning: $0) }
        }
        guard let (image, region) = marked else { return nil }
        return Shot(path: try write(image), image: image, frame: frame(region, on: screen))
    }

    static func screenUnderPointer() -> NSScreen? {
        let mouse = NSEvent.mouseLocation
        return NSScreen.screens.first { NSMouseInRect(mouse, $0.frame, false) } ?? NSScreen.main
    }

    /// A reader of any region of `screen` as it is right now, in its top-down
    /// points. This app's windows are left out: an overlay's dimming, its ink,
    /// and the island kept up over it.
    static func reader(of screen: NSScreen) async throws -> (CGRect) async -> CGImage? {
        guard CGPreflightScreenCaptureAccess() else {
            _ = CGRequestScreenCaptureAccess()
            throw DrayError("Allow Dray Island in System Settings → Privacy & Security → Screen Recording, then try again.")
        }
        let id = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? CGDirectDisplayID
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        guard let display = content.displays.first(where: { $0.displayID == id }) else { throw DrayError("No display to capture.") }
        let filter = SCContentFilter(display: display, excludingApplications: content.applications.filter { $0.processID == getpid() }, exceptingWindows: [])
        let scale = screen.backingScaleFactor
        return { rect in
            let config = SCStreamConfiguration()
            config.sourceRect = rect
            config.width = Int(rect.width * scale)
            config.height = Int(rect.height * scale)
            config.showsCursor = false
            return try? await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
        }
    }

    /// A top-down region of `screen` as a bottom-up window frame across every display.
    static func frame(_ region: CGRect, on screen: NSScreen) -> NSRect {
        NSRect(x: screen.frame.minX + region.minX, y: screen.frame.maxY - region.maxY,
               width: region.width, height: region.height)
    }

    /// `still`, the screen's `region` as captured, with `marks` drawn over it at
    /// the still's own resolution. Marks are in screen points, like the region.
    static func inked(_ still: CGImage, _ marks: [Mark], in region: CGRect) -> CGImage? {
        let scale = CGFloat(still.width) / region.width
        let renderer = ImageRenderer(content: ZStack(alignment: .topLeading) {
            Image(decorative: still, scale: scale)
            Strokes(marks: marks).offset(x: -region.minX, y: -region.minY)
        }
        .frame(width: region.width, height: region.height, alignment: .topLeading)
        .clipped())
        renderer.scale = scale
        return renderer.cgImage
    }

    /// The picture shrinks from where it was taken into the panel, so the
    /// reader sees where it went. Done once it lands.
    static func fly(_ image: CGImage, from: NSRect, to center: NSPoint) async {
        let window = NSPanel(contentRect: from, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        window.level = .screenSaver
        window.isOpaque = false
        window.backgroundColor = .clear
        window.ignoresMouseEvents = true
        let view = NSImageView(image: NSImage(cgImage: image, size: from.size))
        view.imageScaling = .scaleAxesIndependently
        view.wantsLayer = true
        view.layer?.cornerRadius = 10
        view.layer?.masksToBounds = true
        window.contentView = view
        window.orderFrontRegardless()
        let scale = min(96 / max(from.width, 1), 72 / max(from.height, 1))
        let size = CGSize(width: from.width * scale, height: from.height * scale)
        await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in
            NSAnimationContext.runAnimationGroup { ctx in
                ctx.duration = 0.5
                ctx.timingFunction = CAMediaTimingFunction(controlPoints: 0.3, 0, 0.2, 1)
                window.animator().setFrame(NSRect(x: center.x - size.width / 2, y: center.y - size.height / 2,
                                                  width: size.width, height: size.height), display: true)
                window.animator().alphaValue = 0.5
            } completionHandler: {
                window.orderOut(nil)
                done.resume()
            }
        }
    }

    private static func show(_ model: Marking, on screen: NSScreen, finish: @escaping ((CGImage, CGRect)?) -> Void) {
        let panel = IslandPanel(contentRect: screen.frame, styleMask: [.nonactivatingPanel, .borderless], backing: .buffered, defer: false)
        // Over the menu bar; the island is lifted over this while it runs.
        panel.level = .screenSaver
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        panel.isOpaque = false
        panel.backgroundColor = .clear
        // Set outright, or the clear parts of a live screen would pass the drag through.
        panel.ignoresMouseEvents = false
        panel.acceptsMouseMovedEvents = true
        // macOS honours a cursor change from the active app alone, so the
        // capture takes the front for its run and hands it back after.
        let previous = NSWorkspace.shared.frontmostApplication
        let close = { (image: (CGImage, CGRect)?) in
            // A second finish would resume the continuation twice, which traps.
            guard overlay != nil else { return }
            if let keys { NSEvent.removeMonitor(keys) }
            keys = nil
            overlay?.orderOut(nil)
            overlay = nil
            if previous?.processIdentifier != getpid() { previous?.activate() }
            finish(image)
        }
        model.finish = close
        panel.contentView = NSHostingView(rootView: MarkingView(model: model))
        panel.setFrame(screen.frame, display: true)
        overlay = panel
        NSApp.activate()
        panel.makeKeyAndOrderFront(nil)
        // Key codes: Escape 53, Return 36, Z 6, Delete 51, Forward Delete 117.
        keys = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { e in
            switch (e.keyCode, e.modifierFlags.intersection([.command, .shift, .option, .control])) {
            case (53, _): close(nil)
            case (36, []): model.region == nil ? model.wholeScreen() : model.done()
            case (6, .command): model.undo()
            case (51, []), (117, []): model.deleteSelected()
            default: return e
            }
            return nil
        }
    }

    /// PNG, unless that passes the API's 5MB image ceiling — over it Dray sends
    /// the file as a path the model has to open — so a big region steps down
    /// through JPEG qualities until it fits.
    static func write(_ image: CGImage) throws -> String {
        let cap = 5 * 1024 * 1024
        let rep = NSBitmapImageRep(cgImage: image)
        var (data, ext) = (rep.representation(using: .png, properties: [:]), "png")
        for quality in [0.85, 0.7, 0.5, 0.3] where (data?.count ?? 0) > cap {
            (data, ext) = (rep.representation(using: .jpeg, properties: [.compressionFactor: quality]), "jpg")
        }
        guard let data else { throw DrayError("Could not encode the screenshot.") }
        let dir = FileManager.default.temporaryDirectory.appending(path: "dray-island")
        sweep(dir)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let url = dir.appending(path: "Screenshot \(UUID().uuidString.prefix(8)).\(ext)")
        try data.write(to: url)
        return url.path
    }

    /// Captures a week old, on the next write: a sent one is already copied into
    /// the session's attachments, and a queued one is copied at its flush, so
    /// neither can go the moment it leaves. The desktop's rule for pastes.
    private static func sweep(_ dir: URL) {
        let old = Date().addingTimeInterval(-7 * 24 * 3600)
        let files = (try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: [.contentModificationDateKey])) ?? []
        for f in files where ((try? f.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate ?? .distantFuture) < old {
            try? FileManager.default.removeItem(at: f)
        }
    }
}

/// One pen stroke.
struct Mark: Identifiable {
    var id = UUID()
    var points: [CGPoint]

    /// The area the stroke covers, its line's width included.
    var bounds: CGRect {
        let xs = points.map(\.x), ys = points.map(\.y)
        guard let x0 = xs.min(), let x1 = xs.max(), let y0 = ys.min(), let y1 = ys.max() else { return .null }
        return CGRect(x: x0, y: y0, width: x1 - x0, height: y1 - y0).insetBy(dx: -4, dy: -4)
    }
}

@MainActor @Observable
final class Marking {
    /// The screen in points.
    let size: CGSize
    var region: CGRect?
    /// The region as it was the moment it was picked; `nil` while that read is out.
    var still: CGImage?
    var marks: [Mark] = []
    /// The marks before each draw, move or delete, for ⌘Z.
    var history: [[Mark]] = []
    /// Clicked or just moved; Delete removes it.
    var selected: Int?
    /// How far down the notch reaches, which the toolbar keeps clear of.
    var notchHeight: CGFloat = 0
    @ObservationIgnored let grab: (CGRect) async -> CGImage?
    @ObservationIgnored var finish: ((CGImage, CGRect)?) -> Void = { _ in }

    init(size: CGSize, grab: @escaping (CGRect) async -> CGImage?) {
        self.size = size
        self.grab = grab
    }

    /// The shot: this region off the live screen, now. Ink made on an earlier
    /// region belonged to that picture, so it goes with it.
    func take(_ r: CGRect) {
        region = r
        still = nil
        marks = []
        history = []
        selected = nil
        Task {
            let image = await grab(r)
            // A newer pick landed first; its read is the one that counts.
            guard region == r else { return }
            still = image
            if image == nil { region = nil }
        }
    }

    func wholeScreen() { take(CGRect(origin: .zero, size: size)) }

    func checkpoint() { history.append(marks) }

    func undo() {
        guard let last = history.popLast() else { return }
        marks = last
        selected = nil
    }

    func deleteSelected() {
        guard let i = selected, marks.indices.contains(i) else { return }
        checkpoint()
        marks.remove(at: i)
        selected = nil
    }

    /// The topmost mark within reach of `p`, by any segment of its line.
    func hit(_ p: CGPoint) -> Int? {
        marks.indices.last { i in
            let pts = marks[i].points
            if pts.count == 1 { return hypot(p.x - pts[0].x, p.y - pts[0].y) <= 10 }
            return zip(pts, pts.dropFirst()).contains { a, b in
                let d = CGPoint(x: b.x - a.x, y: b.y - a.y)
                let t = max(0, min(1, ((p.x - a.x) * d.x + (p.y - a.y) * d.y) / max(d.x * d.x + d.y * d.y, 0.0001)))
                return hypot(p.x - a.x - t * d.x, p.y - a.y - t * d.y) <= 10
            }
        }
    }

    /// The still with its marks, at the still's own resolution.
    func done() {
        guard let r = region, let still else { return }
        finish(Capture.inked(still, marks, in: r).map { ($0, r) })
    }
}

/// Every mark, one red. Drawn the same on screen and into the written image;
/// a wider white pass under a mark is its hover and selection halo.
struct Strokes: View {
    let marks: [Mark]
    var color = Color.red
    var width: CGFloat = 4

    var body: some View {
        Path { p in
            for m in marks { p.addLines(m.points) }
        }
        .stroke(color, style: StrokeStyle(lineWidth: width, lineCap: .round, lineJoin: .round))
    }
}

/// The live screen under a clear sheet. A drag outside the region picks a new
/// one; inside it, it draws on the still, and a drag on a mark moves it.
private struct MarkingView: View {
    @Bindable var model: Marking
    /// A region being dragged out, not yet taken.
    @State private var picking: CGRect?
    @State private var pickStart: CGPoint?
    @State private var drawing = false
    @State private var moving: (index: Int, last: CGPoint)?
    @State private var hovered: Int?
    /// Over the picked region, where a drag draws; the dot cursor says so.
    @State private var overRegion = false

    /// The ink's red in a thin white ring, so it reads over any screen. macOS
    /// has no dot of its own: its shape pointer is iPad and visionOS only.
    private static let dot = Image(nsImage: NSImage(size: NSSize(width: 12, height: 12), flipped: false) { rect in
        NSColor.white.setFill()
        NSBezierPath(ovalIn: rect).fill()
        NSColor.systemRed.setFill()
        NSBezierPath(ovalIn: rect.insetBy(dx: 2, dy: 2)).fill()
        return true
    })

    var body: some View {
        ZStack(alignment: .topLeading) {
            // Clear to the eye, solid to the mouse. Any fainter rounds to an
            // alpha of zero, and the cursor goes to whatever app is beneath.
            Color.black.opacity(0.01)
            if let r = picking ?? model.region {
                Path { p in
                    p.addRect(CGRect(origin: .zero, size: model.size))
                    p.addRect(r)
                }
                .fill(.black.opacity(0.35), style: FillStyle(eoFill: true))
                if picking == nil, let still = model.still {
                    Image(decorative: still, scale: CGFloat(still.width) / r.width)
                        .offset(x: r.minX, y: r.minY)
                }
                Rectangle().stroke(.white.opacity(0.8), lineWidth: 1)
                    .frame(width: r.width, height: r.height)
                    .offset(x: r.minX, y: r.minY)
            }
            ForEach([model.selected, hovered].compactMap { $0 }.filter { model.marks.indices.contains($0) }, id: \.self) { i in
                Strokes(marks: [model.marks[i]], color: .white.opacity(i == model.selected ? 0.9 : 0.5), width: 10)
            }
            Strokes(marks: model.marks)
        }
        .frame(width: model.size.width, height: model.size.height, alignment: .topLeading)
        .contentShape(Rectangle())
        .gesture(drag)
        .onContinuousHover { phase in
            if case .active(let p) = phase {
                hovered = model.hit(p)
                overRegion = model.still != nil && model.region?.contains(p) == true
            } else {
                hovered = nil
            }
        }
        .pointerStyle(
            moving != nil ? .grabActive
                : hovered != nil ? .grabIdle
                : overRegion && picking == nil ? .image(Self.dot, hotSpot: .center)
                : .rectSelection
        )
        .overlay(alignment: .topLeading) { chrome }
        .environment(\.colorScheme, .dark)
    }

    private var drag: some Gesture {
        DragGesture(minimumDistance: 0)
            .onChanged { g in
                if pickStart == nil, !drawing, moving == nil {
                    if let i = model.hit(g.startLocation) {
                        model.checkpoint()
                        model.selected = i
                        moving = (i, g.startLocation)
                    } else if model.still != nil, let r = model.region, r.contains(g.startLocation) {
                        model.checkpoint()
                        model.selected = nil
                        drawing = true
                        model.marks.append(Mark(points: [g.startLocation]))
                    } else {
                        model.selected = nil
                        pickStart = g.startLocation
                    }
                }
                if let start = pickStart {
                    picking = CGRect(x: min(start.x, g.location.x), y: min(start.y, g.location.y),
                                     width: abs(g.location.x - start.x), height: abs(g.location.y - start.y))
                } else if let (i, last) = moving {
                    // Delete or ⌘Z mid-drag can take the mark away under the pointer.
                    guard model.marks.indices.contains(i) else { return moving = nil }
                    let dx = g.location.x - last.x, dy = g.location.y - last.y
                    model.marks[i].points = model.marks[i].points.map { CGPoint(x: $0.x + dx, y: $0.y + dy) }
                    moving = (i, g.location)
                } else if let last = model.marks.indices.last {
                    model.marks[last].points.append(g.location)
                }
            }
            .onEnded { g in
                // Letting go is the shot; a click rather than a drag takes none.
                if let r = picking, r.width >= 4, r.height >= 4 { model.take(r) }
                // A click on a mark selects it; only a real move is worth an undo step.
                if moving != nil, g.translation == .zero { _ = model.history.popLast() }
                picking = nil
                pickStart = nil
                drawing = false
                moving = nil
                hovered = model.hit(g.location)
            }
    }

    /// Before a region: Full screen and Cancel, where macOS's own screenshot
    /// bar sits. While one is dragged: its size. Once taken: the toolbar,
    /// under the region, over it, or inside its foot where the screen runs out.
    @ViewBuilder private var chrome: some View {
        Group {
            if let r = picking {
                Text("\(Int(r.width)) × \(Int(r.height))")
                    .font(.system(size: 13, weight: .medium).monospacedDigit())
                    .foregroundStyle(.black)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 4)
                    .background(.white, in: RoundedRectangle(cornerRadius: 6))
                    .position(x: min(r.maxX, model.size.width - 50), y: min(r.maxY + 20, model.size.height - 14))
                    .allowsHitTesting(false)
            } else if let r = model.region {
                HStack(spacing: 4) {
                    Button { model.undo() } label: { Image(systemName: "arrow.uturn.backward").frame(width: 28, height: 28) }
                        .disabled(model.history.isEmpty)
                        .help("Undo (⌘Z)")
                    Button("Cancel") { model.finish(nil) }.padding(.horizontal, 8).help("Esc")
                    Button("Done") { model.done() }.padding(.horizontal, 8).fontWeight(.semibold).help("⏎")
                        .disabled(model.still == nil)
                }
                .padding(4)
                .background(.black, in: Capsule())
                .position(
                    x: min(max(r.midX, 120), model.size.width - 120),
                    y: r.maxY + 48 < model.size.height ? r.maxY + 24
                        : r.minY - 48 > model.notchHeight + 8 ? r.minY - 24
                        : r.maxY - 32
                )
            } else {
                HStack(spacing: 4) {
                    Button { model.wholeScreen() } label: {
                        Label("Full screen", systemImage: "macwindow").padding(.horizontal, 10).frame(height: 28)
                    }
                    .help("⏎")
                    Button("Cancel") { model.finish(nil) }.padding(.horizontal, 10).frame(height: 28).help("Esc")
                }
                .padding(4)
                .background(.black, in: Capsule())
                .position(x: model.size.width / 2, y: model.size.height - 48)
            }
        }
        .buttonStyle(.plain)
        .font(.system(size: 13))
        .foregroundStyle(.white)
    }
}
