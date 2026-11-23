import SwiftUI
import XCTest
@testable import Dray

/// #1416: whose reaction lands on whose message, and each emoji sitting at its badge's middle.
final class ReactionTests: XCTestCase {
    private func events(_ lines: [(String, String)]) throws -> [AgentEvent] {
        try lines.map { id, payload in
            try JSONDecoder().decode(AgentEvent.self, from: Data(#"{"id":"\#(id)","sessionId":"s","ts":null,"subagent":null,"payload":\#(payload)}"#.utf8))
        }
    }

    func testEachSideKeepsItsOwnNewestReaction() throws {
        let items = botItems(try events([
            ("u", #"{"type":"user_message","text":"hi"}"#),
            ("a", #"{"type":"assistant_text","text":"hello"}"#),
            ("r1", #"{"type":"reaction","messageId":"u","emoji":"👀"}"#),
            ("r2", #"{"type":"reaction","messageId":"a","emoji":"👍","byUser":true}"#),
            ("r3", #"{"type":"reaction","messageId":"a","emoji":"❤️","byUser":true}"#),
            // The note that tells the bot: a kickoff, which draws nothing.
            ("k", #"{"type":"user_message","text":"The user reacted ❤️ (love) to your message:","kickoff":true}"#),
            ("r4", #"{"type":"reaction","messageId":"u","emoji":"✅"}"#),
        ]))
        XCTAssertEqual(items.count, 2)
        guard case .user(_, _, _, let bots, _) = items[0], case .assistant(_, _, let mine, let session, _) = items[1] else {
            return XCTFail("not a message and its reply")
        }
        XCTAssertEqual(bots, "✅")
        XCTAssertEqual(mine, "❤️")
        XCTAssertEqual(session, "s")
    }

    /// Every glyph's ink sits at the badge's middle but for the nudge, the heart lowest, and the
    /// strip of all seven is kept as the picture to judge them by.
    @MainActor func testEveryEmojiCentresUpright() throws {
        var middles: [String: CGFloat] = [:]
        for emoji in reactions {
            let middle = try XCTUnwrap(inkMiddle(reactionGlyph(emoji)), "\(emoji) drew nothing")
            XCTAssertEqual(middle, 20 + (emoji == "❤️" ? 0.5 : -0.5), accuracy: 0.5, "\(emoji) sits off its badge's middle")
            middles[emoji] = middle
        }
        XCTAssertGreaterThan(try XCTUnwrap(middles["❤️"]), try XCTUnwrap(middles.filter { $0.key != "❤️" }.values.max()))

        let strip = HStack(spacing: 12) { ForEach(reactions, id: \.self) { ReactionBadge(emoji: $0) } }
            .padding(16)
            .background(Theme.card)
        let renderer = ImageRenderer(content: strip)
        renderer.scale = 6
        let shot = XCTAttachment(image: try XCTUnwrap(renderer.uiImage))
        shot.name = "badges"
        shot.lifetime = .keepAlways
        add(shot)
    }

    /// The middle of `image`'s ink, in points from its top.
    private func inkMiddle(_ image: UIImage) -> CGFloat? {
        guard let cg = image.cgImage,
              let ctx = CGContext(data: nil, width: cg.width, height: cg.height, bitsPerComponent: 8, bytesPerRow: 0,
                                  space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue),
              let data = ctx.data else { return nil }
        ctx.draw(cg, in: CGRect(x: 0, y: 0, width: cg.width, height: cg.height))
        let alpha = data.assumingMemoryBound(to: UInt8.self)
        let inked = (0..<cg.height).filter { y in (0..<cg.width).contains { alpha[y * ctx.bytesPerRow + $0 * 4 + 3] > 24 } }
        guard let first = inked.first, let last = inked.last else { return nil }
        return CGFloat(first + last + 1) / 2 / image.scale
    }
}
