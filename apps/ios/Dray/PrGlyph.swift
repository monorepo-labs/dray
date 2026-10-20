import SwiftUI

/// A branch's pull request glyph, the desktop's `PrStateIcon`: lucide's
/// shapes in GitHub's colours, red while checks fail on an open one.
struct PrGlyph: View {
    let mark: PrMark
    var size: CGFloat = 14

    var body: some View {
        Canvas { ctx, box in
            ctx.scaleBy(x: box.width / 24, y: box.height / 24)
            ctx.stroke(path, with: .color(tone), style: StrokeStyle(lineWidth: 1.5, lineCap: .round, lineJoin: .round))
        }
        .frame(width: size, height: size)
        .accessibilityElement()
        .accessibilityLabel(label)
    }

    private var merged: Bool { mark.state == "MERGED" }
    private var failing: Bool { !merged && mark.checksState == "FAILING" }

    private var tone: Color {
        failing ? .red : merged ? .purple : mark.isDraft ? .secondary : .green
    }

    private var label: String {
        let state = merged ? "Merged" : mark.isDraft ? "Draft" : "Open"
        return "Pull request #\(mark.number), \(state.lowercased())\(failing ? ", checks failing" : "")"
    }

    private var path: Path {
        var p = Path()
        p.addEllipse(in: CGRect(x: 15, y: 15, width: 6, height: 6))
        p.addEllipse(in: CGRect(x: 3, y: 3, width: 6, height: 6))
        if merged {
            p.move(to: CGPoint(x: 6, y: 21))
            p.addLine(to: CGPoint(x: 6, y: 9))
            p.addArc(center: CGPoint(x: 15, y: 9), radius: 9, startAngle: .degrees(180), endAngle: .degrees(90), clockwise: true)
            return p
        }
        p.move(to: CGPoint(x: 6, y: 9))
        p.addLine(to: CGPoint(x: 6, y: 21))
        if mark.isDraft {
            p.move(to: CGPoint(x: 18, y: 6))
            p.addLine(to: CGPoint(x: 18, y: 5))
            p.move(to: CGPoint(x: 18, y: 11))
            p.addLine(to: CGPoint(x: 18, y: 10))
        } else {
            p.move(to: CGPoint(x: 13, y: 6))
            p.addLine(to: CGPoint(x: 16, y: 6))
            p.addArc(center: CGPoint(x: 16, y: 8), radius: 2, startAngle: .degrees(270), endAngle: .degrees(0), clockwise: false)
            p.addLine(to: CGPoint(x: 18, y: 15))
        }
        return p
    }
}

/// Checks still running: the desktop's dashed circle in command yellow,
/// one turn every 3s.
struct ChecksSpinner: View {
    @Environment(\.accessibilityReduceMotion) private var still

    var body: some View {
        TimelineView(.animation(paused: still)) { timeline in
            Circle()
                .inset(by: 1.5)
                .stroke(.yellow, style: StrokeStyle(lineWidth: 1.5, lineCap: .round, dash: [2.4, 3]))
                .rotationEffect(.degrees(timeline.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 3) * 120))
        }
        .frame(width: 14, height: 14)
        .accessibilityElement()
        .accessibilityLabel("Checks running")
    }
}
