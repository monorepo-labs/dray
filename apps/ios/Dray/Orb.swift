import SwiftUI

/// What the app draws wherever it waits. A spinner for now; a native Thinking
/// Orbs package replaces it later, in this one place.
struct Orb: View {
    var body: some View {
        ProgressView()
    }
}
