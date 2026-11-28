import SwiftUI
import UIKit

/// `EMOJI` in react.rs, which refuses any other.
let reactions = ["👍", "👎", "❤️", "😂", "🎉", "✅", "👀", "😢"]

private let reactionLabels = ["👀": "Seen", "✅": "Done", "🎉": "Celebrating", "👍": "Like", "👎": "Dislike", "❤️": "Love", "😂": "Laughing", "😢": "Sad"]

/// The desktop's `ReactionBadge`: the page's colour, edged and ringed in it again, so it reads as cut out of the bubble.
struct ReactionBadge: View {
    let emoji: String
    var mine = false

    var body: some View {
        Image(uiImage: reactionGlyph(emoji))
            .background(Theme.page, in: .circle)
            .overlay(Circle().strokeBorder(Theme.border, lineWidth: 1))
            .background(Circle().fill(Theme.page).padding(-3))
            .accessibilityLabel("\(mine ? "You" : "Bot") reacted: \(reactionLabels[emoji] ?? emoji)")
    }
}

extension View {
    /// A reaction beside this bubble's corner: the bottom one on a bot's message (`mine`), the top
    /// one on the reader's. An overlay, since a badge that takes room moves every row after it.
    func reaction(_ emoji: String?, mine: Bool = false) -> some View {
        overlay(alignment: mine ? .bottomTrailing : .topLeading) {
            ZStack {
                if let emoji { ReactionBadge(emoji: emoji, mine: mine).transition(.scale(scale: 0.5).combined(with: .opacity)) }
            }
            .offset(x: mine ? 32 : -32)
            .animation(Theme.motion, value: emoji)
        }
    }

    /// A long press opens the reactions, and nothing else with them. Nothing where `react` is nil.
    func reactable(current: String?, _ react: ((String) -> Void)?) -> some View {
        modifier(Reactable(current: current, react: react))
    }
}

private struct Reactable: ViewModifier {
    let current: String?
    let react: ((String) -> Void)?
    @State private var picking = false
    @State private var aim: CGFloat = 0

    func body(content: Content) -> some View {
        if let react {
            content
                .onLongPressGesture { picking = true }
                .sensoryFeedback(.impact, trigger: picking) { _, open in open }
                .accessibilityAction(named: "React") { picking = true }
                // The bubble's top while on screen, else the middle of what is, or a tall reply aims the
                // set at a top scrolled away. To a tenth, so a scroll moves it seldom.
                .onGeometryChange(for: CGFloat.self) { geo in
                    guard let seen = geo.bounds(of: .scrollView), seen.minY > 0, geo.size.height > 0 else { return 0 }
                    return ((seen.minY + min(seen.maxY, geo.size.height)) / 2 / geo.size.height * 10).rounded() / 10
                } action: { aim = $0 }
                .popover(isPresented: $picking, attachmentAnchor: .point(UnitPoint(x: 0.5, y: aim)), arrowEdge: .bottom) {
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
                    .presentationCompactAdaptation(.popover)
                    .presentationBackground(Theme.raised)
                }
        } else {
            content
        }
    }
}

/// The pick already made and the one under the finger, on the popover's own corner shape.
private struct Pick: ButtonStyle {
    let current: Bool

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .background(current || configuration.isPressed ? Theme.tile : .clear, in: .rect(cornerRadius: Theme.Radius.lg, style: .continuous))
    }
}

private let badgeSide: CGFloat = 40
private let glyphSize: CGFloat = 18
private let pixels = UIGraphicsImageRendererFormat.preferred().scale
private var glyphs: [String: UIImage] = [:]

/// `emoji` in the badge's box, upright by its measured ink (the desktop's `emojiInk`), since the font sets
/// each glyph at its own height; then the nudge judged by eye. Sideways by its advance alone.
func reactionGlyph(_ emoji: String) -> UIImage {
    if let drawn = glyphs[emoji] { return drawn }
    let text = NSAttributedString(string: emoji, attributes: [.font: UIFont.systemFont(ofSize: glyphSize)])
    let line = text.size()
    let drop = (emoji == "❤️" ? 0.028 : -0.028) * glyphSize
    let top = badgeSide / 2 + drop - (inkMiddle(text) ?? line.height / 2)
    let image = UIGraphicsImageRenderer(size: CGSize(width: badgeSide, height: badgeSide)).image { _ in
        text.draw(at: CGPoint(x: ((badgeSide - line.width) / 2 * pixels).rounded() / pixels, y: (top * pixels).rounded() / pixels))
    }
    glyphs[emoji] = image
    return image
}

/// How far below its line's top the middle of `text`'s ink is, or nil where nothing drew.
private func inkMiddle(_ text: NSAttributedString) -> CGFloat? {
    let line = text.size()
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
    // Alpha at or under 24 is haze, not ink.
    let inked = (0..<tall).filter { y in (0..<wide).contains { alpha[y * stride + $0 * 4 + 3] > 24 } }
    guard let first = inked.first, let last = inked.last else { return nil }
    return CGFloat(first + last + 1) / 2 / pixels - line.height
}
