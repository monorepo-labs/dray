import XCTest
@testable import Dray

final class RecordingTests: XCTestCase {
    func testFindsRecordingsInAnyHomeOnceEach() {
        let text = """
        Watch /Users/me/.dray/browser/recordings/s1/flow.mp4 and
        [the other](/srv/dray/browser/recordings/s1/screen.mp4), then
        /Users/me/.dray/browser/recordings/s1/flow.mp4 again.
        """
        XCTAssertEqual(recordingPaths(in: text), [
            "/Users/me/.dray/browser/recordings/s1/flow.mp4",
            "/srv/dray/browser/recordings/s1/screen.mp4",
        ])
    }

    func testIgnoresWhatIsNotAnAbsoluteRecording() {
        XCTAssertEqual(recordingPaths(in: "see ~/.dray/browser/recordings/s1/a.mp4"), [])
        XCTAssertEqual(recordingPaths(in: "/Users/me/dray-test-videos/a.mp4"), [])
        XCTAssertEqual(recordingPaths(in: "/x/browser/recordings/s1/a.mov"), [])
    }
}
