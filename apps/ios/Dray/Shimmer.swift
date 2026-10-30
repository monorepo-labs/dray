import SwiftUI

extension View {
    /// The desktop's `shimmer-text`: a highlight sweeping across, the mark a
    /// live row wears, one sweep every `period` seconds. Holds still under Reduce Motion.
    func shimmer(_ on: Bool = true, period: Double = 2) -> some View { modifier(Shimmer(on: on, period: period)) }
}

private struct Shimmer: ViewModifier {
    let on: Bool
    let period: Double
    @Environment(\.accessibilityReduceMotion) private var still

    func body(content: Content) -> some View {
        if on && !still {
            TimelineView(.animation) { timeline in
                let phase = timeline.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: period) / period
                content.mask {
                    LinearGradient(
                        stops: [.init(color: .black.opacity(0.5), location: 0.35),
                                .init(color: .black, location: 0.5),
                                .init(color: .black.opacity(0.5), location: 0.65)],
                        startPoint: UnitPoint(x: phase * 2 - 1, y: 0),
                        endPoint: UnitPoint(x: phase * 2, y: 0))
                }
            }
        } else {
            content
        }
    }
}
