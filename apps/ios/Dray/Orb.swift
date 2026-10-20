import SwiftUI

/// The thinking orb, wherever one belongs. A plain spinner stands in until
/// the Thinking Orbs Swift package lands; swapping it in is this file alone.
struct Orb: View {
    var body: some View {
        ProgressView()
            .controlSize(.small)
            .frame(width: 20, height: 20)
            .accessibilityHidden(true)
    }
}
