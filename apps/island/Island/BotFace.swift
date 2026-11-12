import AppKit
import JavaScriptCore
import SwiftUI

/// A bot's face, drawn by the app's own code: `botface.js` is Blobatar and
/// `botAvatar.ts` bundled (Faces/bundle.sh), run once in JavaScriptCore.
struct BotFace: View {
    let bot: Bot
    var size: CGFloat = 20

    var body: some View {
        if let image = Self.image(bot) {
            // The sidebar's scale: the shape sits inside its box with room to spare.
            Image(nsImage: image).resizable().frame(width: size, height: size).scaleEffect(1.18)
        } else {
            Color.clear.frame(width: size, height: size)
        }
    }

    @MainActor private static let draw: JSValue? = {
        guard let url = Bundle.main.url(forResource: "botface", withExtension: "js"),
              let js = try? String(contentsOf: url, encoding: .utf8),
              let context = JSContext() else { return nil }
        context.evaluateScript(js)
        return context.objectForKeyedSubscript("botFace")
    }()
    @MainActor private static var cache: [Bot: NSImage] = [:]

    @MainActor private static func image(_ bot: Bot) -> NSImage? {
        if let hit = cache[bot] { return hit }
        let avatar: Any = bot.avatar.map { ["shape": $0.shape, "hue": $0.hue] } ?? NSNull()
        // Vector: an SVG image redraws at whatever size it is drawn, so one is enough.
        guard let svg = draw?.call(withArguments: [bot.id, avatar, 64])?.toString(),
              let image = NSImage(data: Data(svg.utf8)) else { return nil }
        cache[bot] = image
        return image
    }
}

/// The app's `TypingDots`: what a bot shows while it works, in place of the task orb.
struct TypingDots: View {
    @Environment(\.motionPaused) private var hidden

    var body: some View {
        TimelineView(.animation(paused: hidden)) { context in
            let t = context.date.timeIntervalSinceReferenceDate
            HStack(spacing: 2) {
                ForEach(0..<3) { i in
                    let k = Self.lift(t - Double(i) * 0.16)
                    Circle().fill(.white.opacity(0.5))
                        .frame(width: 4, height: 4)
                        .opacity(0.35 + 0.65 * k)
                        .offset(y: -2 * k)
                }
            }
        }
        .accessibilityLabel("Working")
    }

    /// The CSS `typing-dot` keyframes: up at 30% of a 1.2s cycle, back at 60%, rest after.
    private static func lift(_ t: Double) -> Double {
        let p = (t.truncatingRemainder(dividingBy: 1.2) + 1.2).truncatingRemainder(dividingBy: 1.2) / 1.2
        let k = p < 0.3 ? p / 0.3 : p < 0.6 ? (0.6 - p) / 0.3 : 0
        return k * k * (3 - 2 * k)
    }
}
