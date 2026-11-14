import JavaScriptCore
import SwiftUI

/// A bot's face, or a bot task's, drawn by the app's own code: the Island's
/// `botface.js` (Blobatar and `botAvatar.ts`, bundled) run once in
/// JavaScriptCore. Its SVG is a few filled circles and paths, read here into
/// SwiftUI paths, since UIKit draws no SVG.
struct BotFace: View {
    /// A bot's id, or a task's session id: what the face is seeded from.
    let seed: String
    var avatar: BotAvatar?
    var size: CGFloat = 20

    init(bot: Bot, size: CGFloat = 20) {
        seed = bot.id
        avatar = bot.avatar
        self.size = size
    }

    /// A bot's task wears a face seeded from its session id, as the desktop's `seededAvatar`.
    init(seed: String, avatar: BotAvatar? = nil, size: CGFloat = 20) {
        self.seed = seed
        self.avatar = avatar
        self.size = size
    }

    var body: some View {
        let shapes = Self.shapes(seed, avatar)
        Canvas { ctx, box in
            // The sidebar's scale: the shape sits inside its box with room to spare.
            let k = box.width / 100 * 1.18
            ctx.translateBy(x: box.width / 2, y: box.height / 2)
            ctx.scaleBy(x: k, y: k)
            ctx.translateBy(x: -50, y: -50)
            for s in shapes { ctx.fill(s.path, with: .color(s.color)) }
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }

    private struct Shape { let color: Color; let path: Path }

    @MainActor private static let draw: JSValue? = {
        guard let url = Bundle.main.url(forResource: "botface", withExtension: "js"),
              let js = try? String(contentsOf: url, encoding: .utf8),
              let context = JSContext() else { return nil }
        context.evaluateScript(js)
        return context.objectForKeyedSubscript("botFace")
    }()
    @MainActor private static var cache: [String: [Shape]] = [:]

    @MainActor private static func shapes(_ seed: String, _ avatar: BotAvatar?) -> [Shape] {
        let key = "\(seed)|\(avatar?.shape ?? "")|\(avatar?.hue ?? -1)"
        if let hit = cache[key] { return hit }
        let pick: Any = avatar.map { ["shape": $0.shape, "hue": $0.hue] } ?? NSNull()
        let svg = draw?.call(withArguments: [seed, pick, 64])?.toString() ?? ""
        let read = parseFace(svg)
        cache[key] = read
        return read
    }

    /// Reads `<g fill>`, `<circle>` and `<path d>` in a 0–100 viewBox: all Blobatar writes.
    private static func parseFace(_ svg: String) -> [Shape] {
        var out: [Shape] = []
        var fill = Color.white
        let tags = svg.matches(of: /<(\/?)(\w+)([^>]*)>/)
        for tag in tags {
            let (closing, name, attrs) = (tag.output.1, String(tag.output.2), String(tag.output.3))
            guard closing.isEmpty else { continue }
            func attr(_ key: String) -> String? {
                attrs.firstMatch(of: try! Regex("\(key)=\"([^\"]*)\"")).map { String($0.output[1].substring ?? "") }
            }
            switch name {
            case "g":
                if let hex = attr("fill") { fill = color(hex) }
            case "circle":
                guard let cx = attr("cx").flatMap(Double.init), let cy = attr("cy").flatMap(Double.init),
                      let r = attr("r").flatMap(Double.init) else { continue }
                out.append(Shape(color: attr("fill").map(color) ?? fill,
                                 path: Path(ellipseIn: CGRect(x: cx - r, y: cy - r, width: 2 * r, height: 2 * r))))
            case "path":
                guard let d = attr("d") else { continue }
                out.append(Shape(color: attr("fill").map(color) ?? fill, path: path(d)))
            default:
                break
            }
        }
        return out
    }

    /// Absolute M, L, H, V, C, Q and Z, the commands Blobatar's paths use.
    static func path(_ d: String) -> Path {
        let tokens = d.matches(of: /[A-Za-z]|-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/).map { String($0.output) }
        var p = Path()
        var i = 0
        var cmd = "M"
        var at = CGPoint.zero
        func num() -> CGFloat? {
            guard i < tokens.count, let v = Double(tokens[i]) else { return nil }
            i += 1
            return CGFloat(v)
        }
        func point() -> CGPoint? {
            guard let x = num(), let y = num() else { return nil }
            return CGPoint(x: x, y: y)
        }
        while i < tokens.count {
            if tokens[i].first!.isLetter {
                cmd = tokens[i]
                i += 1
                if cmd == "Z" || cmd == "z" { p.closeSubpath(); continue }
            }
            let before = i
            switch cmd {
            case "M": if let q = point() { p.move(to: q); at = q; cmd = "L" }
            case "L": if let q = point() { p.addLine(to: q); at = q }
            case "H": if let x = num() { at = CGPoint(x: x, y: at.y); p.addLine(to: at) }
            case "V": if let y = num() { at = CGPoint(x: at.x, y: y); p.addLine(to: at) }
            case "C":
                if let c1 = point(), let c2 = point(), let q = point() { p.addCurve(to: q, control1: c1, control2: c2); at = q }
            case "Q":
                if let c = point(), let q = point() { p.addQuadCurve(to: q, control: c); at = q }
            default: break
            }
            // An unknown command or a short run of numbers: skip a token rather than spin.
            if i == before { i += 1 }
        }
        return p
    }

    private static func color(_ hex: String) -> Color {
        let v = UInt32(hex.trimmingCharacters(in: CharacterSet(charactersIn: "#")), radix: 16) ?? 0xFFFFFF
        return Color(red: Double((v >> 16) & 0xFF) / 255, green: Double((v >> 8) & 0xFF) / 255, blue: Double(v & 0xFF) / 255)
    }
}

/// The app's `TypingDots`: what a bot shows while it works, in place of the task orb.
struct TypingDots: View {
    @Environment(\.accessibilityReduceMotion) private var still

    var body: some View {
        TimelineView(.animation(minimumInterval: 1 / 30, paused: still)) { context in
            let t = context.date.timeIntervalSinceReferenceDate
            HStack(spacing: 2) {
                ForEach(0..<3) { i in
                    let k = still ? 0 : Self.lift(t - Double(i) * 0.16)
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
