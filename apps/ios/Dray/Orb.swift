import SwiftUI

/// Wherever the desktop draws its thinking orb. A system spinner stands in
/// until Thinking Orbs ships its Swift package; swapping that in is this file
/// alone.
struct Orb: View {
    var size: CGFloat = 20
    var label: String?

    var body: some View {
        ProgressView()
            .controlSize(size < 20 ? .mini : .small)
            .frame(width: size, height: size)
            .accessibilityLabel(label ?? "")
            .accessibilityHidden(label == nil)
    }
}
