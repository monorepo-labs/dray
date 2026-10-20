import AppKit
import ScreenCaptureKit
import SwiftUI

/// A screenshot marked up before it joins the draft. The screen under the
/// pointer is frozen first, so what is marked cannot move under the pen; the
/// reader drags a region over it, draws, and Done crops the region with its
/// marks to an image file — a path, which is all `send_msg` takes.
@MainActor
enum Capture {
    private static var overlay: NotchPanel?
    private static var keys: Any?

    /// The written image's path, or `nil` for a cancel.
    static func run() async throws -> String? {
        let mouse = NSEvent.mouseLocation
        guard let screen = NSScreen.screens.first(where: { NSMouseInRect(mouse, $0.frame, false) }) ?? NSScreen.main
        else { return nil }
        let shot = try await snapshot(screen)
        let marked: CGImage? = await withCheckedContinuation { done in
            show(shot, on: screen) { done.resume(returning: $0) }
        }
        return try marked.map(write)
    }

    /// The whole display, minus this app's own windows, so the panel closing
    /// beside it never lands in the shot.
    private static func snapshot(_ screen: NSScreen) async throws -> CGImage {
        guard CGPreflightScreenCaptureAccess() else {
            _ = CGRequestScreenCaptureAccess()
            throw DrayError("Allow Dray Notch in System Settings → Privacy & Security → Screen Recording, then try again.")
        }
        let id = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? CGDirectDisplayID
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        guard let display = content.displays.first(where: { $0.displayID == id }) else { throw DrayError("No display to capture.") }
        let me = content.applications.filter { $0.processID == getpid() }
        let config = SCStreamConfiguration()
        config.width = Int(CGFloat(display.width) * screen.backingScaleFactor)
        config.height = Int(CGFloat(display.height) * screen.backingScaleFactor)
        config.showsCursor = false
        return try await SCScreenshotManager.captureImage(
            contentFilter: SCContentFilter(display: display, excludingApplications: me, exceptingWindows: []),
            configuration: config
        )
    }

    private static func show(_ shot: CGImage, on screen: NSScreen, finish: @escaping (CGImage?) -> Void) {
        let model = Marking(shot: shot, size: screen.frame.size)
        let panel = NotchPanel(contentRect: screen.frame, styleMask: [.nonactivatingPanel, .borderless], backing: .buffered, defer: false)
        // Over the menu bar and the notch panel both.
        panel.level = .screenSaver
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        let close = { (image: CGImage?) in
            // A second finish would resume the continuation twice, which traps.
            guard overlay != nil else { return }
            if let keys { NSEvent.removeMonitor(keys) }
            keys = nil
            overlay?.orderOut(nil)
            overlay = nil
            finish(image)
        }
        model.finish = close
        panel.contentView = NSHostingView(rootView: MarkingView(model: model))
        panel.setFrame(screen.frame, display: true)
        overlay = panel
        panel.makeKeyAndOrderFront(nil)
        // Key codes: Escape 53, Return 36, Z 6.
        keys = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { e in
            switch (e.keyCode, e.modifierFlags.intersection([.command, .shift, .option, .control])) {
            case (53, _): close(nil)
            case (36, []): model.done()
            case (6, .command): _ = model.marks.popLast()
            default: return e
            }
            return nil
        }
    }

    /// PNG, unless that passes the API's 5MB image ceiling — over it Dray sends
    /// the file as a path the model has to open, so a big region goes as JPEG.
    private static func write(_ image: CGImage) throws -> String {
        let rep = NSBitmapImageRep(cgImage: image)
        var (data, ext) = (rep.representation(using: .png, properties: [:]), "png")
        if (data?.count ?? 0) > 5 * 1024 * 1024 {
            (data, ext) = (rep.representation(using: .jpeg, properties: [.compressionFactor: 0.85]), "jpg")
        }
        guard let data else { throw DrayError("Could not encode the screenshot.") }
        let dir = FileManager.default.temporaryDirectory.appending(path: "dray-notch")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let url = dir.appending(path: "Screenshot \(UUID().uuidString.prefix(8)).\(ext)")
        try data.write(to: url)
        return url.path
    }
}

struct Mark {
    enum Tool { case pen, arrow }
    let tool: Tool
    /// An arrow keeps two: tail and head.
    var points: [CGPoint]
}

@MainActor @Observable
final class Marking {
    let shot: CGImage
    /// The screen in points; the shot is the same in pixels.
    let size: CGSize
    var region: CGRect?
    var marks: [Mark] = []
    var tool = Mark.Tool.pen
    @ObservationIgnored var finish: (CGImage?) -> Void = { _ in }

    init(shot: CGImage, size: CGSize) {
        self.shot = shot
        self.size = size
    }

    /// The region with its marks, at the shot's own resolution. No region is the whole screen.
    func done() {
        let r = (region ?? CGRect(origin: .zero, size: size)).intersection(CGRect(origin: .zero, size: size))
        let scale = CGFloat(shot.width) / size.width
        guard !r.isEmpty, let cropped = shot.cropping(to: CGRect(x: r.minX * scale, y: r.minY * scale, width: r.width * scale, height: r.height * scale).integral)
        else { return finish(nil) }
        let renderer = ImageRenderer(content: ZStack(alignment: .topLeading) {
            Image(decorative: cropped, scale: scale)
            Strokes(marks: marks).offset(x: -r.minX, y: -r.minY)
        }
        .frame(width: r.width, height: r.height, alignment: .topLeading)
        .clipped())
        renderer.scale = scale
        finish(renderer.cgImage)
    }
}

/// Every mark, one red. Drawn the same on screen and into the written image.
private struct Strokes: View {
    let marks: [Mark]

    var body: some View {
        Path { p in
            for m in marks {
                switch m.tool {
                case .pen:
                    p.addLines(m.points)
                case .arrow:
                    guard let a = m.points.first, let b = m.points.last, a != b else { continue }
                    p.move(to: a)
                    p.addLine(to: b)
                    let angle = atan2(b.y - a.y, b.x - a.x)
                    for side in [CGFloat.pi * 0.8, -CGFloat.pi * 0.8] {
                        p.move(to: b)
                        p.addLine(to: CGPoint(x: b.x + 18 * cos(angle + side), y: b.y + 18 * sin(angle + side)))
                    }
                }
            }
        }
        .stroke(.red, style: StrokeStyle(lineWidth: 4, lineCap: .round, lineJoin: .round))
    }
}

/// The frozen screen, dimmed outside the region. A drag outside the region
/// picks a new one; inside it, it draws with the current tool.
private struct MarkingView: View {
    @Bindable var model: Marking
    @State private var selecting: CGPoint?
    @State private var drawing = false

    var body: some View {
        ZStack(alignment: .topLeading) {
            Image(decorative: model.shot, scale: CGFloat(model.shot.width) / model.size.width)
            Path { p in
                p.addRect(CGRect(origin: .zero, size: model.size))
                if let r = model.region { p.addRect(r) }
            }
            .fill(.black.opacity(0.45), style: FillStyle(eoFill: true))
            if let r = model.region {
                Rectangle().stroke(.white.opacity(0.8), lineWidth: 1)
                    .frame(width: r.width, height: r.height)
                    .offset(x: r.minX, y: r.minY)
            }
            Strokes(marks: model.marks)
        }
        .frame(width: model.size.width, height: model.size.height, alignment: .topLeading)
        .contentShape(Rectangle())
        .gesture(drag)
        .pointerStyle(.rectSelection)
        .overlay(alignment: .topLeading) { toolbar }
        .environment(\.colorScheme, .dark)
    }

    private var drag: some Gesture {
        DragGesture(minimumDistance: 0)
            .onChanged { g in
                if selecting == nil, !drawing {
                    if let r = model.region, r.contains(g.startLocation) {
                        drawing = true
                        model.marks.append(Mark(tool: model.tool, points: [g.startLocation]))
                    } else {
                        selecting = g.startLocation
                    }
                }
                if let start = selecting {
                    model.region = CGRect(x: min(start.x, g.location.x), y: min(start.y, g.location.y),
                                          width: abs(g.location.x - start.x), height: abs(g.location.y - start.y))
                } else if let last = model.marks.indices.last {
                    if model.tool == .arrow {
                        model.marks[last].points = [g.startLocation, g.location]
                    } else {
                        model.marks[last].points.append(g.location)
                    }
                }
            }
            .onEnded { _ in
                // A click rather than a drag is no region.
                if selecting != nil, let r = model.region, r.width < 4 || r.height < 4 { model.region = nil }
                selecting = nil
                drawing = false
            }
    }

    /// Under the region, or over it where the screen runs out; a hint before there is one.
    @ViewBuilder private var toolbar: some View {
        Group {
            if let r = model.region, selecting == nil {
                HStack(spacing: 4) {
                    tool(.pen, "scribble", "Pen")
                    tool(.arrow, "arrow.up.right", "Arrow")
                    Button { _ = model.marks.popLast() } label: { Image(systemName: "arrow.uturn.backward").frame(width: 28, height: 28) }
                        .disabled(model.marks.isEmpty)
                        .help("Undo (⌘Z)")
                    Divider().frame(height: 16)
                    Button("Cancel") { model.finish(nil) }.padding(.horizontal, 8).help("Esc")
                    Button("Done") { model.done() }.padding(.horizontal, 8).fontWeight(.semibold).help("⏎")
                }
                .padding(4)
                .background(.black, in: Capsule())
                .position(
                    x: min(max(r.midX, 160), model.size.width - 160),
                    y: r.maxY + 32 < model.size.height ? r.maxY + 24 : max(r.minY - 24, 24)
                )
            } else if model.region == nil {
                Text("Drag to pick a region   ⏎ Whole screen   Esc Cancel")
                    .padding(.horizontal, 12)
                    .padding(.vertical, 6)
                    .background(.black, in: Capsule())
                    .position(x: model.size.width / 2, y: model.size.height / 2)
                    .allowsHitTesting(false)
            }
        }
        .buttonStyle(.plain)
        .font(.system(size: 13))
        .foregroundStyle(.white)
    }

    private func tool(_ t: Mark.Tool, _ symbol: String, _ name: String) -> some View {
        Button { model.tool = t } label: {
            Image(systemName: symbol)
                .frame(width: 28, height: 28)
                .background(model.tool == t ? .white.opacity(0.18) : .clear, in: Circle())
        }
        .help(name)
    }
}
