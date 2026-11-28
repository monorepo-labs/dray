import XCTest
@testable import Dray

/// Images ride two payloads and must never cost the event they arrive on.
final class ImageTests: XCTestCase {
    private func payload(_ json: String) throws -> Payload {
        try JSONDecoder().decode(Payload.self, from: Data(json.utf8))
    }

    func testPromptImagesDecodeLeniently() throws {
        guard case .userMessage(_, _, _, _, let images, _, _) = try payload(
            #"{"type":"user_message","text":"hi","images":[{"path":"/a.png","url":null,"mimeType":"image/png"},{"path":5},"x"]}"#)
        else { return XCTFail("not a prompt") }
        XCTAssertEqual(images.map(\.path), ["/a.png"])
        for bad in [#""images":7,"#, #""images":null,"#, ""] {
            guard case .userMessage(let text, _, _, _, let images, _, _) = try payload(#"{"type":"user_message",\#(bad)"text":"hi"}"#)
            else { return XCTFail("not a prompt: \(bad)") }
            XCTAssertEqual(text, "hi")
            XCTAssertTrue(images.isEmpty)
        }
    }

    func testToolResultImages() throws {
        guard case .toolCompleted(_, let result) = try payload(
            #"{"type":"tool_call_completed","callId":"c","result":{"text":"","isError":false,"images":[{"path":"/b.png"}]}}"#)
        else { return XCTFail("not a result") }
        XCTAssertEqual(result.images.first?.path, "/b.png")
    }

    func testMarkdownImageBlock() {
        guard case .image(let alt, let url)? = markdownBlocks("Here:\n\n![shot](https://x.test/a.png \"t\")\n\nDone").dropFirst().first
        else { return XCTFail("no image block") }
        XCTAssertEqual(alt, "shot")
        XCTAssertEqual(url, "https://x.test/a.png")
        // Inside a sentence it stays prose.
        guard case .prose? = markdownBlocks("see ![a](b.png) here").first else { return XCTFail("not prose") }
    }

    /// A reply's viewer pages in the order `MarkdownText` draws: image lines, then named paths, once each.
    func testMessageShotsOrder() {
        let text = "Saved /tmp/c.png and /tmp/d.png\n\n![one](/tmp/a.png)\n\nthen\n\n![two](https://x.test/b.png)\n\n![again](/tmp/a.png)"
        XCTAssertEqual(messageShots(text).map { $0.ref.path ?? $0.ref.url }, ["/tmp/a.png", "https://x.test/b.png", "/tmp/c.png", "/tmp/d.png"])
        XCTAssertEqual(messageShots(text).first?.target, "one")
        XCTAssertTrue(messageShots("no pictures").isEmpty)
    }
}
