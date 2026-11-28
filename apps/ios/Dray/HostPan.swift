import SwiftUI
import UIKit

/// A UIKit pan on the page or sheet this is laid behind, for the two drags a SwiftUI gesture
/// loses: one in from the screen's edge, which the chat's scroll begins before, and one on a
/// sheet's header, which the sheet's own drag takes. The recogniser goes on that page's view,
/// which sees every touch on it; this one sits under the content and is never touched.
struct HostPan: UIViewRepresentable {
    /// In from the screen's right edge, or anywhere in the view's top band this many points deep.
    enum Start { case rightEdge, top(CGFloat) }
    let start: Start
    /// Called once a drag, with how far it has gone: as an edge swipe begins, as a top drag ends.
    let action: (CGPoint) -> Void

    func makeUIView(context: Context) -> Marker { Marker(start) }
    func updateUIView(_ view: Marker, context: Context) { view.action = action }

    final class Marker: UIView, UIGestureRecognizerDelegate {
        var action: (CGPoint) -> Void = { _ in }
        private let start: Start
        private let pan: UIPanGestureRecognizer
        private var edge: Bool { pan is UIScreenEdgePanGestureRecognizer }

        init(_ start: Start) {
            self.start = start
            if case .rightEdge = start {
                // UIKit's own, which takes only a touch that starts at the edge: no code block or table reaches it.
                let edge = UIScreenEdgePanGestureRecognizer()
                edge.edges = .right
                pan = edge
            } else {
                pan = UIPanGestureRecognizer()
            }
            super.init(frame: .zero)
            pan.addTarget(self, action: #selector(panned))
            pan.delegate = self
        }

        required init?(coder: NSCoder) { fatalError("made in code") }

        override func didMoveToWindow() {
            pan.view?.removeGestureRecognizer(pan)
            guard window != nil else { return }
            var host = next
            while let r = host, !(r is UIViewController) { host = r.next }
            (host as? UIViewController)?.view.addGestureRecognizer(pan)
        }

        @objc private func panned() {
            if pan.state == (edge ? .began : .ended) { action(pan.translation(in: nil)) }
        }

        func gestureRecognizer(_ r: UIGestureRecognizer, shouldReceive touch: UITouch) -> Bool {
            if case .top(let depth) = start { return touch.location(in: r.view).y < depth }
            return true
        }

        /// A top drag runs beside the sheet's own, which still takes the sheet down to close.
        func gestureRecognizer(_ r: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool { !edge }

        /// Every other pan waits on an edge swipe, or the chat's scroll begins first and cancels it.
        func gestureRecognizer(_ r: UIGestureRecognizer, shouldBeRequiredToFailBy other: UIGestureRecognizer) -> Bool {
            edge && other is UIPanGestureRecognizer && !(other is UIScreenEdgePanGestureRecognizer)
        }
    }
}
