import XCTest
@testable import Dray

/// Offline hides the toasts it explains, and only those (#1715).
final class OfflineFailureTests: XCTestCase {
    func testConnectionFailuresAreOfflines() {
        for e in ["Not connected", "Reconnecting", "Disconnected", "The server took too long to answer send_msg",
                  "The request timed out.", "The Internet connection appears to be offline.",
                  "Could not connect to the server.", "A server with the specified hostname could not be found.",
                  "The network connection was lost.", "cancelled",
                  "An SSL error has occurred and a secure connection to the server cannot be made."] {
            XCTAssertTrue(offlineFailure(e), e)
        }
    }

    func testServerAnswersStay() {
        for e in ["Session not found", "Wait for this turn to finish before switching to Codex.",
                  "The upload was refused (413)", "wrong token"] {
            XCTAssertFalse(offlineFailure(e), e)
        }
    }
}
