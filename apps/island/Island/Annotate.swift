import AppKit
import SwiftUI

/// Drawing on the live screen, up whenever dictation records. The overlay lets the mouse
/// through until ⇧ is held, so the page under it still scrolls and clicks.
/// Strokes made close together are one moment: once the pen has rested, the
/// area around them is captured with the ink, the ink fades, and the image
/// takes the place held for it when the moment began — after the words said
/// before it, ahead of the words said while drawing.
@MainActor
final class Annotation {
    /// How long the pen rests before a moment is taken.
    static let pause: Duration = .milliseconds(1500)
    /// Room around the marks, so the image shows what they point at.
    static let padding: CGFloat = 160

    private let composer: Composer
    private let screen: NSScreen
    /// Read on the first moment taken, so dictating never asks for Screen Recording.
    private var grab: ((CGRect) async -> CGImage?)?
    /// Where a taken moment goes on screen: its flight into the notch.
    private let land: (Capture.Shot) async -> Void
    private let window: IslandPanel
    private let ink = Ink()
    private var poll: Timer?
    private var rest: Task<Void, Never>?
    /// The moment being drawn: its held row, and the cut placing the words said before it.
    private var moment: (slot: UUID, cut: Task<Void, Never>)?
    /// Marks a taken moment still holds on screen while it captures and fades;
    /// the next moment leaves them out.
    private var claimed: Set<UUID> = []

    init?(composer: Composer, land: @escaping (Capture.Shot) async -> Void) {
        guard let screen = Capture.screenUnderPointer() else { return nil }
        self.composer = composer
        self.screen = screen
        self.land = land
        window = IslandPanel(contentRect: screen.frame, styleMask: [.nonactivatingPanel, .borderless], backing: .buffered, defer: false)
        window.level = .screenSaver
        window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        window.isOpaque = false
        window.backgroundColor = .clear
        window.hasShadow = false
        window.ignoresMouseEvents = true
        // A stroke must not take the keyboard from the page it is drawn on.
        window.becomesKeyOnlyIfNeeded = true
        window.contentView = NSHostingView(rootView: InkView(ink: ink, frame: screen.frame))
        window.setFrame(screen.frame, display: true)
        // Never key: the page keeps the keyboard.
        window.orderFrontRegardless()

        ink.began = { [weak self] in self?.strokeBegan() }
        ink.ended = { [weak self] in self?.strokeEnded() }
        // ⇧ alone arms the pen. Polled off the keyboard's own state, needing no
        // grant: `flagsChanged` monitors could miss a press and leave ⇧ looking dead.
        let arm = { [weak self] in
            guard let self else { return }
            let flags = NSEvent.ModifierFlags(rawValue: UInt(CGEventSource.flagsState(.hidSystemState).rawValue))
            let armed = flags.intersection([.shift, .command, .option, .control]) == .shift
            guard armed != ink.armed else { return }
            ink.armed = armed
            // A stroke in progress keeps the mouse until it lets go.
            if !ink.drawing { window.ignoresMouseEvents = !armed }
        }
        // ⇧ may already be down from before the microphone opened.
        arm()
        let poll = Timer(timeInterval: 1.0 / 30, repeats: true) { _ in MainActor.assumeIsolated { arm() } }
        RunLoop.main.add(poll, forMode: .common)
        self.poll = poll
    }

    /// Takes any moment still being drawn, then leaves the screen.
    func end() async {
        poll?.invalidate()
        poll = nil
        window.ignoresMouseEvents = true
        rest?.cancel()
        await take()
        window.orderOut(nil)
    }

    private func strokeBegan() {
        rest?.cancel()
        composer.drawHint = false
        guard moment == nil else { return }
        let slot = composer.reserveShot()
        moment = (slot, Task { [composer] in await composer.cutDictation(before: slot) })
    }

    private func strokeEnded() {
        window.ignoresMouseEvents = !ink.armed
        rest = Task { [weak self] in
            try? await Task.sleep(for: Self.pause)
            guard !Task.isCancelled else { return }
            await self?.take()
        }
    }

    /// The moment's area with its ink, into the place held for it. Strokes
    /// begun after this point belong to the next moment.
    private func take() async {
        guard let m = moment else { return }
        moment = nil
        let marks = ink.marks.filter { !claimed.contains($0.id) }
        let taken = Set(marks.map(\.id))
        claimed.formUnion(taken)
        let bounds = CGRect(origin: .zero, size: screen.frame.size)
        let region = marks.map(\.bounds).reduce(CGRect.null) { $0.union($1) }
            .insetBy(dx: -Self.padding, dy: -Self.padding)
            .intersection(bounds)
            .integral
        var shot: Capture.Shot?
        var failed: String?
        if !region.isEmpty {
            do {
                if grab == nil { grab = try await Capture.reader(of: screen) }
                if let still = await grab?(region), let image = Capture.inked(still, marks, in: region) {
                    shot = Capture.Shot(path: try Capture.write(image), image: image, frame: Capture.frame(region, on: screen))
                }
            } catch {
                failed = error.localizedDescription
            }
        }
        withAnimation(.easeOut(duration: 0.4)) { ink.marks.removeAll { taken.contains($0.id) } }
        claimed.subtract(taken)
        if let shot { await land(shot) }
        await m.cut.value
        withAnimation(.spring(duration: 0.4, bounce: 0.5)) { composer.fillShot(m.slot, shot?.path) }
        // After the row, which retires a notice.
        if let failed { composer.notice = failed }
    }
}

@MainActor @Observable
final class Ink {
    var marks: [Mark] = []
    /// ⇧ is held, so the overlay takes the mouse and a drag draws.
    var armed = false
    var drawing = false
    @ObservationIgnored var began: () -> Void = {}
    @ObservationIgnored var ended: () -> Void = {}
}

/// Ink over the live screen, and the pen's tip while ⇧ is held. Each
/// moment's marks fade as it is taken.
private struct InkView: View {
    let ink: Ink
    let frame: CGRect
    @State private var pointer: CGPoint?
    private var size: CGSize { frame.size }

    var body: some View {
        ZStack(alignment: .topLeading) {
            // Faint enough to see through, solid enough to take the mouse while armed;
            // any fainter rounds to an alpha of zero and clicks fall through.
            Color.black.opacity(ink.armed ? 0.01 : 0)
            ForEach(ink.marks) { mark in
                Strokes(marks: [mark]).transition(.opacity)
            }
            if ink.armed, let pointer {
                Circle().fill(.red).overlay(Circle().stroke(.white, lineWidth: 2))
                    .frame(width: 12, height: 12)
                    .position(pointer)
                    .allowsHitTesting(false)
            }
        }
        .frame(width: size.width, height: size.height, alignment: .topLeading)
        .contentShape(Rectangle())
        .onContinuousHover { phase in
            if case .active(let p) = phase { pointer = p } else { pointer = nil }
        }
        // The tip shows where the cursor already is: a hover only arrives once it moves.
        .onChange(of: ink.armed) { _, armed in
            guard armed else { return }
            let m = NSEvent.mouseLocation
            pointer = CGPoint(x: m.x - frame.minX, y: frame.maxY - m.y)
        }
        .gesture(
            DragGesture(minimumDistance: 0)
                .onChanged { g in
                    pointer = g.location
                    if !ink.drawing {
                        ink.drawing = true
                        ink.marks.append(Mark(points: [g.startLocation]))
                        ink.began()
                    }
                    if let last = ink.marks.indices.last { ink.marks[last].points.append(g.location) }
                }
                .onEnded { _ in
                    ink.drawing = false
                    ink.ended()
                }
        )
    }
}
