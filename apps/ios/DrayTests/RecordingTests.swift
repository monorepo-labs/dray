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

    func testFindsImagesApartFromRecordings() {
        let text = "Before /srv/dray/browser/recordings/s1/before.png, after (/srv/dray/browser/recordings/s1/after.jpg) and /srv/dray/browser/recordings/s1/flow.mp4"
        XCTAssertEqual(imagePaths(in: text), [
            "/srv/dray/browser/recordings/s1/before.png",
            "/srv/dray/browser/recordings/s1/after.jpg",
        ])
        XCTAssertEqual(recordingPaths(in: text), ["/srv/dray/browser/recordings/s1/flow.mp4"])
        XCTAssertEqual(imagePaths(in: "Saved `/Users/me/Desktop/Shot.PNG`."), ["/Users/me/Desktop/Shot.PNG"])
    }

    func testIgnoresImagePathsInCodeAndUrls() {
        XCTAssertEqual(imagePaths(in: "```\ncp a.png /tmp/b.png\n```"), [])
        XCTAssertEqual(imagePaths(in: "https://example.com/a.png and /tmp/a.png.bak"), [])
    }

    func testLeavesAnImageWrittenAsAMarkdownLineToItsBlock() {
        let text = "Done.\n\n![After](/srv/dray/browser/recordings/s1/after.png)\n\nAlso /srv/dray/browser/recordings/s1/before.png"
        XCTAssertEqual(imagePaths(in: text), ["/srv/dray/browser/recordings/s1/before.png"])
    }

    func testHidesDrawnPathsFromTheText() {
        let video = "/Users/me/.dray/browser/recordings/s1/flow.mp4"
        let shot = "/tmp/shot.png"
        let text = """
        Recorded it: `\(video)`
        \(shot)
        Saved to \(shot).
        Outside: `\(shot)`.
        See [the shot](\(shot)) and ![x](\(shot)) here.
        ![Block](\(shot))
        ```
        open \(shot)
        ```
        """
        XCTAssertEqual(hiding([video, shot], in: text), """
        Recorded it:
        Saved to.
        Outside:
        See and here.
        ![Block](\(shot))
        ```
        open \(shot)
        ```
        """)
    }

    func testHidesOnlyWholePaths() {
        let text = "Shot /tmp/a.png, backup [old](/tmp/a.png.bak) and /tmp/a.png.bak"
        XCTAssertEqual(hiding(["/tmp/a.png"], in: text), "Shot, backup [old](/tmp/a.png.bak) and /tmp/a.png.bak")
    }
}
