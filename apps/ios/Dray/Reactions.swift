import SwiftUI
import UIKit

/// The reactions there are, the bot's and the reader's alike: `EMOJI` in react.rs, which refuses any other.
let reactions = ["👍", "❤️", "😂", "🎉", "✅", "👀", "😢"]

private let reactionLabels = ["👀": "Seen", "✅": "Done", "🎉": "Celebrating", "👍": "Like", "❤️": "Love", "😂": "Laughing", "😢": "Sad"]

/// A reaction, as a messenger draws one: a round chip in the chat's own colour, a hairline edge and
/// a ring of that colour again outside it, so it reads as cut out of the bubble under it. The
/// desktop's `ReactionBadge`, and Android's.
struct ReactionBadge: View {
    let emoji: String
    /// The reader's, on a bot's message; a bot's otherwise.
    var mine = false

    var body: some View {
        Image(uiImage: reactionGlyph(emoji))
            .background(Theme.page, in: .circle)
            .overlay(Circle().strokeBorder(Theme.border, lineWidth: 1))
            // The ring: behind the badge and past its edge, taking no room.
            .background(Circle().fill(Theme.page).padding(-3))
            .accessibilityLabel("\(mine ? "You" : "Bot") reacted: \(reactionLabels[emoji] ?? emoji)")
    }
}

extension View {
    /// Hangs a reaction beside a corner of this bubble: the bottom one on a bot's message (`mine`),
    /// the top one on the reader's.
    ///
    /// A reaction lands on a message already read, so it must move nothing: the badge is an
    /// overlay out to the side, in the room no bubble reaches, and inside the bubble's own
    /// height, which one line of text gives it. Hung over the corner it needed padding to clear
    /// the next row, and the chat jumped. It laps the bubble by less than its padding, so no text
    /// is under it.
    func reaction(_ emoji: String?, mine: Bool = false) -> some View {
        overlay(alignment: mine ? .bottomTrailing : .topLeading) {
            ZStack {
                if let emoji { ReactionBadge(emoji: emoji, mine: mine).transition(.scale(scale: 0.5).combined(with: .opacity)) }
            }
            .offset(x: mine ? 32 : -32)
            .animation(Theme.motion, value: emoji)
        }
    }

    /// A long press on a bot's message opens the reactions over it, as a messenger does, and
    /// nothing else with them: a reaction and a copy are two different things. Nothing where
    /// `react` is nil.
    func reactable(current: String?, _ react: ((String) -> Void)?) -> some View {
        modifier(Reactable(current: current, react: react))
    }
}

private struct Reactable: ViewModifier {
    let current: String?
    let react: ((String) -> Void)?
    @State private var picking = false

    func body(content: Content) -> some View {
        if let react {
            content
                .onLongPressGesture { picking = true }
                .sensoryFeedback(.impact, trigger: picking) { _, open in open }
                .accessibilityAction(named: "React") { picking = true }
                .popover(isPresented: $picking, arrowEdge: .bottom) {
                    HStack(spacing: 2) {
                        ForEach(reactions, id: \.self) { emoji in
                            Button {
                                picking = false
                                if emoji != current { react(emoji) }
                            } label: {
                                Text(emoji).font(.system(size: 24)).frame(width: 42, height: 42)
                            }
                            .buttonStyle(Pick(current: emoji == current))
                            .accessibilityLabel(reactionLabels[emoji] ?? emoji)
                        }
                    }
                    .padding(.horizontal, 6)
                    .padding(.vertical, 4)
                    // A popover on a phone too, where the default is a sheet.
                    .presentationCompactAdaptation(.popover)
                    .presentationBackground(Theme.raised)
                }
        } else {
            content
        }
    }
}

/// An emoji in the set: the pick already made and the one under the finger sit on a squircle,
/// the popover's own corner shape, where a circle read as a second shape inside it.
private struct Pick: ButtonStyle {
    let current: Bool

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .background(current || configuration.isPressed ? Theme.tile : .clear, in: .rect(cornerRadius: Theme.Radius.lg, style: .continuous))
    }
}

// MARK: The emoji, centred by its ink

private let badgeSide: CGFloat = 40
private let glyphSize: CGFloat = 18
private let pixels = UIGraphicsImageRendererFormat.preferred().scale
private var glyphs: [String: UIImage] = [:]

/// `emoji` in the badge's box: centred sideways by its advance, upright by its ink.
///
/// The emoji font places each glyph at its own spot in the line, so a `Text` centred by its box
/// sits high or low by the emoji. The ink is measured where it draws, as the desktop's `emojiInk`
/// does, then nudged by eye: every emoji rises 0.028em and the heart sinks as far, its point
/// leaving its box's middle above its mass. Upright alone: an emoji is lopsided sideways by
/// design (a thumb, a party popper), and centring that ink reads as a shift.
func reactionGlyph(_ emoji: String) -> UIImage {
    if let drawn = glyphs[emoji] { return drawn }
    let text = NSAttributedString(string: emoji, attributes: [.font: UIFont.systemFont(ofSize: glyphSize)])
    let line = text.size()
    let drop = (emoji == "❤️" ? 0.028 : -0.028) * glyphSize
    let top = badgeSide / 2 + drop - (inkMiddle(text) ?? line.height / 2)
    let image = UIGraphicsImageRenderer(size: CGSize(width: badgeSide, height: badgeSide)).image { _ in
        // To a device pixel, or the bitmap blurs.
        text.draw(at: CGPoint(x: ((badgeSide - line.width) / 2 * pixels).rounded() / pixels, y: (top * pixels).rounded() / pixels))
    }
    glyphs[emoji] = image
    return image
}

/// How far below its line's top the middle of `text`'s ink is, or nil where nothing drew.
private func inkMiddle(_ text: NSAttributedString) -> CGFloat? {
    let line = text.size()
    // A line of room above and below, so overhang either way is kept.
    let wide = Int((line.width * pixels).rounded(.up)), tall = Int((line.height * 3 * pixels).rounded(.up))
    guard wide > 0, tall > 0,
          let ctx = CGContext(data: nil, width: wide, height: tall, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(),
                              bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue),
          let data = ctx.data else { return nil }
    // UIKit's y runs down from the top row, which is also where the buffer starts.
    ctx.translateBy(x: 0, y: CGFloat(tall))
    ctx.scaleBy(x: pixels, y: -pixels)
    UIGraphicsPushContext(ctx)
    text.draw(at: CGPoint(x: 0, y: line.height))
    UIGraphicsPopContext()
    let alpha = data.assumingMemoryBound(to: UInt8.self), stride = ctx.bytesPerRow
    // Alpha at or under 24 is anti-aliasing haze, not ink.
    let inked = (0..<tall).filter { y in (0..<wide).contains { alpha[y * stride + $0 * 4 + 3] > 24 } }
    guard let first = inked.first, let last = inked.last else { return nil }
    return CGFloat(first + last + 1) / 2 / pixels - line.height
}
