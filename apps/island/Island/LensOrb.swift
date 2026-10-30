import AppKit
import CoreImage
import ScreenCaptureKit
import SwiftUI

/// Expanded mode's orb: the prism's light in a ball of real glass, the screen
/// behind it refracted through (`lens` in LensOrb.metal). The screen is a
/// capture stream of the patch behind the orb, run only while recording; idle,
/// or without the Screen Recording grant, it is the prism orb exactly.
struct LensOrb: View {
    let size: CGFloat
    let level: Float
    let state: Dictation
    @State private var backdrop = Backdrop()

    var body: some View {
        OrbDriver(size: size, level: level, state: state) { f in
            Rectangle()
                .colorEffect(Shader(function: ShaderLibrary.default.lens,
                                    arguments: f.args + PrismOrb.rainbow.map { .color($0) } + [
                                        .float(Float(f.spin)), .float(Float(f.curl)),
                                        .image(backdrop.image ?? Backdrop.blank),
                                        .float(backdrop.image == nil ? 0 : 1), .float(Float(Backdrop.span)),
                                    ]))
                .frame(width: f.size, height: f.size)
        }
        .shadow(color: .black.opacity(0.3), radius: size * 0.12, y: size * 0.08)
        .background(WindowReader { backdrop.window = $0 })
        .onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: { backdrop.follow($0) }
        .onChange(of: [.starting, .recording].contains(state), initial: true) { _, on in backdrop.want(on) }
        .onDisappear { backdrop.want(false) }
    }
}

/// The screen behind the orb, a frame at a time, leaving out this app's own windows.
@Observable private final class Backdrop: NSObject, SCStreamOutput {
    /// How much of the screen around the orb is captured, in orb widths: the
    /// rim reads a little past itself.
    static let span: CGFloat = 1.2
    static let blank = Image(size: CGSize(width: 1, height: 1)) { _ in }

    var image: Image?
    @ObservationIgnored weak var window: NSWindow? {
        // Set from `viewDidMoveToWindow`, on the main thread.
        didSet { if let frame { MainActor.assumeIsolated { follow(frame) } } }
    }
    @ObservationIgnored private var frame: CGRect?
    @ObservationIgnored private var rect = CGRect.null
    @ObservationIgnored private var scale: CGFloat = 2
    @ObservationIgnored private var stream: SCStream?
    @ObservationIgnored private var live = false
    @ObservationIgnored private var wanted = false
    @ObservationIgnored private let context = CIContext()
    /// macOS shows its prompt once, so asking again only costs a call.
    @MainActor private static var asked = false

    /// Points the stream at the orb's `frame`, in its window's top-down points.
    @MainActor func follow(_ frame: CGRect) {
        self.frame = frame
        guard wanted else { return }
        guard CGPreflightScreenCaptureAccess() else {
            if !Self.asked { Self.asked = true; _ = CGRequestScreenCaptureAccess() }
            return
        }
        guard let window, let screen = window.screen else { return }
        let w = window.frame, s = screen.frame
        // AppKit is bottom-up; the stream wants the display's top-down points.
        let mid = CGPoint(x: w.minX + frame.midX - s.minX, y: s.maxY - (w.maxY - frame.midY))
        let side = (frame.width * Self.span).rounded()
        let next = CGRect(x: (mid.x - side / 2).rounded(), y: (mid.y - side / 2).rounded(), width: side, height: side)
        guard next != rect else { return }
        rect = next
        scale = screen.backingScaleFactor
        if let stream {
            stream.updateConfiguration(config()) { _ in }
        } else if !live {
            live = true
            start(on: screen)
        }
    }

    /// Starts the stream, or stops it and drops what it saw.
    @MainActor func want(_ on: Bool) {
        wanted = on
        if !on { stop() } else if let frame { follow(frame) }
    }

    @MainActor private func stop() {
        live = false
        stream?.stopCapture { _ in }
        stream = nil
        image = nil
        rect = .null
    }

    @MainActor private func start(on screen: NSScreen) {
        let id = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? CGDirectDisplayID
        Task { @MainActor in
            guard let content = try? await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true),
                  let display = content.displays.first(where: { $0.displayID == id }) else { live = false; return }
            // By window: excluding the app let the orb capture its own glow, a frame late.
            let filter = SCContentFilter(display: display,
                                         excludingWindows: content.windows.filter { $0.owningApplication?.processID == getpid() })
            let stream = SCStream(filter: filter, configuration: config(), delegate: nil)
            guard (try? stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: .global(qos: .userInteractive))) != nil,
                  (try? await stream.startCapture()) != nil else { live = false; return }
            // Stopped while it was starting.
            guard live else { stream.stopCapture { _ in }; return }
            self.stream = stream
        }
    }

    // ponytail: a rect past the display's edge is left to the stream; clamp and offset the lens if the island ever sits there.
    private func config() -> SCStreamConfiguration {
        let c = SCStreamConfiguration()
        c.sourceRect = rect
        c.width = Int(rect.width * scale)
        c.height = Int(rect.height * scale)
        c.minimumFrameInterval = CMTime(value: 1, timescale: 30)
        c.showsCursor = false
        return c
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer buffer: CMSampleBuffer, of type: SCStreamOutputType) {
        // An idle frame, nothing having moved, carries no pixels.
        guard type == .screen, let pixels = buffer.imageBuffer else { return }
        let still = CIImage(cvPixelBuffer: pixels)
        guard let cg = context.createCGImage(still, from: still.extent) else { return }
        DispatchQueue.main.async { [scale] in
            if self.live { self.image = Image(decorative: cg, scale: scale) }
        }
    }
}

/// The window a view sits in, which SwiftUI does not say.
private struct WindowReader: NSViewRepresentable {
    let found: (NSWindow?) -> Void
    func makeNSView(context: Context) -> NSView { Reader(found: found) }
    func updateNSView(_ view: NSView, context: Context) {}

    final class Reader: NSView {
        let found: (NSWindow?) -> Void
        init(found: @escaping (NSWindow?) -> Void) {
            self.found = found
            super.init(frame: .zero)
        }
        required init?(coder: NSCoder) { nil }
        override func viewDidMoveToWindow() { found(window) }
    }
}
