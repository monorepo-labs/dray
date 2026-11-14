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

    func testFindsScreenshotsApartFromRecordings() {
        let text = "Before /srv/dray/browser/recordings/s1/before.png, after (/srv/dray/browser/recordings/s1/after.jpg) and /srv/dray/browser/recordings/s1/flow.mp4"
        XCTAssertEqual(screenshotPaths(in: text), [
            "/srv/dray/browser/recordings/s1/before.png",
            "/srv/dray/browser/recordings/s1/after.jpg",
        ])
        XCTAssertEqual(recordingPaths(in: text), ["/srv/dray/browser/recordings/s1/flow.mp4"])
        XCTAssertEqual(screenshotPaths(in: "/Users/me/Desktop/shot.png"), [])
    }
}
