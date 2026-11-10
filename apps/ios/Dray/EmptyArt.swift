import SwiftUI

/// The 180×120 drawing above an empty state's title: a server, its link, and what is on the other end.
struct EmptyArt: View {
    enum Kind { case connect, connecting, unreachable, tasks, project }

    let kind: Kind
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private static let loop: TimeInterval = 1.6
    private static let link = Color(hex: 0xC3C5FF)

    var body: some View {
        Group {
            if kind == .connecting {
                TimelineView(.animation(paused: reduceMotion)) { context in
                    let t = context.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: Self.loop) / Self.loop
                    canvas(head: reduceMotion ? 86 : 30 + 90 * t)
                }
            } else {
                canvas(head: 86)
            }
        }
        .frame(width: 180, height: 120)
        .accessibilityHidden(true)
    }

    private func canvas(head: CGFloat) -> some View {
        Canvas { ctx, _ in
            func rect(_ x: CGFloat, _ y: CGFloat, _ w: CGFloat, _ h: CGFloat, _ c: Color) {
                ctx.fill(Path(CGRect(x: x, y: y, width: w, height: h)), with: .color(c))
            }
            func line(_ from: CGFloat, _ to: CGFloat, _ c: Color, dash: [CGFloat] = [], phase: CGFloat = 0) {
                var p = Path()
                p.move(to: CGPoint(x: from, y: 60))
                p.addLine(to: CGPoint(x: to, y: 60))
                ctx.stroke(p, with: .color(c), style: StrokeStyle(lineWidth: 1, dash: dash, dashPhase: phase))
            }
            func bars(_ xs: some Sequence<Int>, _ fill: (Int) -> Color = { _ in Theme.tile }) {
                for (i, x) in xs.enumerated() { rect(CGFloat(x), 30, 1.5, 60, fill(i)) }
            }
            func server() {
                rect(0, 30, 30, 60, Color(hex: 0x1612F8))
                rect(0, 60, 30, 30, Color(hex: 0x0C0C9E))
            }
            func ends() {
                rect(28, 58, 4, 4, Theme.text)
                rect(118, 58, 4, 4, Theme.text)
            }

            switch kind {
            case .connect:
                bars(stride(from: 121, through: 175, by: 6))
                server()
                line(30, 120, Self.link.opacity(0.6), dash: [3, 5])
                ends()
            case .connecting:
                let lit = [Color(hex: 0x4A46FF), Color(hex: 0x4A46FF).opacity(0.7), Color(hex: 0x4A46FF).opacity(0.4)]
                bars(stride(from: 121, through: 175, by: 6)) { $0 < lit.count ? lit[$0] : Theme.tile }
                server()
                line(30, head, Self.link.opacity(0.8))
                // Phase anchors the dashes to x 30, so they hold still while the head runs over them.
                line(head, 120, Self.link.opacity(0.4), dash: [3, 5], phase: head - 30)
                ends()
                rect(head - 3, 57, 6, 6, Color(hex: 0x2D29FF))
            case .unreachable:
                bars(stride(from: 121, through: 175, by: 6))
                server()
                line(30, 66, Self.link.opacity(0.6))
                line(94, 120, Self.link.opacity(0.6))
                ends()
                var x = Path()
                x.move(to: CGPoint(x: 75, y: 55)); x.addLine(to: CGPoint(x: 85, y: 65))
                x.move(to: CGPoint(x: 85, y: 55)); x.addLine(to: CGPoint(x: 75, y: 65))
                ctx.stroke(x, with: .color(Theme.destructive), style: StrokeStyle(lineWidth: 1.5, lineCap: .square))
            case .tasks, .project:
                if kind == .tasks {
                    bars(stride(from: 33, through: 81, by: 6))
                    bars(stride(from: 99, through: 147, by: 6))
                }
                rect(89.25, 15, 1.5, 90, Color(hex: 0x4A46FF))
                rect(88, 11, 4, 4, Theme.text)
            }
        }
    }
}

/// An empty list's whole body: art, title and message, optional actions, and with `pointsAtOrb` a dashed line down to the orb.
struct EmptyScreen<Art: View, Actions: View>: View {
    let art: Art
    let title: String
    let message: String
    var pointsAtOrb = false
    @ViewBuilder var actions: Actions

    var body: some View {
        VStack(spacing: 0) {
            // Two equal halves around the content keep it in the middle; a padded Spacer
            // stops counting as one and takes all the room.
            Color.clear
            VStack(spacing: pointsAtOrb ? 20 : 28) {
                art
                VStack(spacing: 8) {
                    Text(title).font(Theme.Font.title).tracking(-0.2).foregroundStyle(Theme.text)
                    Text(message).font(Theme.Font.subhead).foregroundStyle(Theme.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: 280)
                }
                .multilineTextAlignment(.center)
                actions
            }
            Color.clear.overlay {
                if pointsAtOrb {
                    VerticalLine()
                        .stroke(Theme.tertiary, style: StrokeStyle(lineWidth: 1.5, dash: [4, 4]))
                        .frame(width: 1.5)
                        .padding(.top, 20)
                        .padding(.bottom, 8)
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

extension EmptyScreen where Actions == EmptyView {
    init(art: Art, title: String, message: String, pointsAtOrb: Bool = false) {
        self.init(art: art, title: title, message: message, pointsAtOrb: pointsAtOrb) { EmptyView() }
    }
}

/// The empty states' capsule buttons: frame 01's full-width 50pt pair (`light`, `dark`) and frame 03's 40pt `retry`.
struct EmptyCapsuleStyle: ButtonStyle {
    enum Kind { case light, dark, retry }
    var kind: Kind

    func makeBody(configuration: Configuration) -> some View {
        Group {
            if kind == .retry {
                configuration.label.font(Theme.Font.pill).padding(.horizontal, 20).frame(height: 40)
            } else {
                configuration.label.font(Theme.Font.headline).frame(maxWidth: .infinity).frame(height: 50)
            }
        }
        .foregroundStyle(kind == .light ? Theme.page : Theme.text)
        .background(kind == .light ? Theme.text : Theme.raised, in: Capsule())
        .contentShape(Capsule())
        .pressed(configuration.isPressed)
    }
}

/// Frame 01's 18pt QR mark, inked in the foreground style; sits 8pt before "Scan QR code".
struct QRCodeIcon: View {
    var body: some View {
        Glyph(path: Glyph.qr)
            .stroke(style: StrokeStyle(lineWidth: 1.5, lineCap: .round))
            .frame(width: 18, height: 18)
            .accessibilityHidden(true)
    }
}

/// Frame 06's art: the last settled task as a card, with two slivers of the ones under it.
struct SettledStack: View {
    let title: String
    let time: String

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 10) {
                Glyph(path: Glyph.checkCheck)
                    .stroke(Theme.add, style: StrokeStyle(lineWidth: 1.35, lineCap: .round, lineJoin: .round))
                    .frame(width: 18, height: 18)
                Text(title).font(Theme.Font.body).foregroundStyle(Theme.text).lineLimit(1)
                    .frame(maxWidth: .infinity, alignment: .leading)
                Text(time).font(Theme.Font.footnote).foregroundStyle(Theme.tertiary)
            }
            .padding(.vertical, 12)
            .padding(.horizontal, 14)
            .background(Theme.card, in: .rect(cornerRadius: Theme.Radius.lg))
            sliver(Color(hex: 0x141414), height: 7, width: 0.92, radius: 10)
            sliver(Color(hex: 0x101010), height: 6, width: 0.84, radius: 9)
        }
        .frame(maxWidth: 300)
    }

    private func sliver(_ fill: Color, height: CGFloat, width: CGFloat, radius: CGFloat) -> some View {
        GeometryReader { g in
            UnevenRoundedRectangle(bottomLeadingRadius: radius, bottomTrailingRadius: radius)
                .fill(fill)
                .frame(width: (g.size.width * width).rounded())
                .frame(maxWidth: .infinity)
        }
        .frame(height: height)
    }
}

/// A 24-unit icon path scaled to whatever frame it is given.
private struct Glyph: Shape {
    let path: Path

    func path(in r: CGRect) -> Path {
        path.applying(CGAffineTransform(translationX: r.minX, y: r.minY).scaledBy(x: r.width / 24, y: r.height / 24))
    }

    static let qr: Path = {
        var p = Path()
        for (from, corner, to) in [((3, 8), (3, 3), (8, 3)), ((16, 3), (21, 3), (21, 8)),
                                   ((21, 16), (21, 21), (16, 21)), ((8, 21), (3, 21), (3, 16))] {
            p.move(to: CGPoint(x: from.0, y: from.1))
            p.addArc(tangent1End: CGPoint(x: corner.0, y: corner.1), tangent2End: CGPoint(x: to.0, y: to.1), radius: 2)
            p.addLine(to: CGPoint(x: to.0, y: to.1))
        }
        p.addRect(CGRect(x: 8, y: 8, width: 3, height: 3))
        p.addRect(CGRect(x: 13, y: 13, width: 3, height: 3))
        p.move(to: CGPoint(x: 13, y: 8)); p.addLine(to: CGPoint(x: 16, y: 8))
        p.move(to: CGPoint(x: 8, y: 13)); p.addLine(to: CGPoint(x: 8, y: 16))
        return p
    }()

    static let checkCheck: Path = {
        var p = Path()
        p.addLines([CGPoint(x: 2, y: 12.5), CGPoint(x: 6.5, y: 17), CGPoint(x: 15, y: 8.5)])
        p.addLines([CGPoint(x: 13, y: 16), CGPoint(x: 14, y: 17), CGPoint(x: 22.5, y: 8.5)])
        return p
    }()
}

private struct VerticalLine: Shape {
    func path(in r: CGRect) -> Path {
        Path { p in
            p.move(to: CGPoint(x: r.midX, y: r.minY))
            p.addLine(to: CGPoint(x: r.midX, y: r.maxY))
        }
    }
}
