import SwiftUI
import ThinkingOrbs

/// What the app is waiting on wherever an orb is drawn. Each maps to the orb
/// the desktop draws for the same wait, so the two apps read alike.
enum Activity {
    /// A turn running: the row's slot, the transcript's working line (`WorkingIndicator`).
    case working
    /// A subagent or delegated run (`SubagentRow`, `ToolCall`).
    case delegating
    /// Background tasks outliving the turn (`BackgroundTasksIndicator`).
    case background
    /// A server being reached again (`ServerOfflineNotice`).
    case reconnecting
    /// Reading something in: a transcript, a list. No desktop twin; searching is the nearest.
    case loading
}

extension Orb {
    /// The orb for an activity, in the page's ink, at the package's tuned 20pt unless asked.
    init(_ activity: Activity, size: CGFloat = 20, label: String? = nil) {
        switch activity {
        case .working: self.init(state: .working, size: size, label: label)
        case .delegating: self.init(state: .working, variant: .gyro, size: size, label: label)
        case .background: self.init(state: .background, variant: .spiral, size: size, label: label)
        case .reconnecting: self.init(state: .searching, variant: .lighthouse, size: size, speed: 3, label: label)
        case .loading: self.init(state: .searching, size: size, label: label)
        }
    }
}
