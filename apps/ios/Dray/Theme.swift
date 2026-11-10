import SwiftUI
import UIKit

/// Dray's one look on the phone: the desktop's Default dark palette, its one
/// yellow and its radius scale, in sRGB. Dark only, forced at the root, so no
/// colour here has a light twin. Every screen reads from this file and from
/// nothing else, so a colour, size or radius is changed in one place.
enum Theme {
    // Surfaces, darkest first.
    /// `--background`: what everything sits on.
    static let page = Color(hex: 0x0A0A0A)
    /// `--surface-raised`: cut into a surface rather than raised from it — code and tool output.
    static let well = Color(hex: 0x141414)
    /// `--card`: a surface in the page — cards, grouped rows.
    static let card = Color(hex: 0x1A1A1A)
    /// `--muted`: one step above a card — the sent bubble, chips, second buttons.
    static let raised = Color(hex: 0x262626)
    /// `--surface-selected`: the current row.
    static let selected = Color(hex: 0x2B2B2B)
    /// An icon's tile or a control on a raised card: a server, Add server,
    /// Scan QR code, Local servers' round and pill buttons.
    static let tile = Color(hex: 0x333333)
    /// A switch's track when off.
    static let off = Color(hex: 0x3A3A3A)
    /// A server's dot while it is on its way: quieter than any word beside it.
    static let dim = Color(hex: 0x525252)

    // Ink.
    static let text = Color(hex: 0xFAFAFA)
    static let secondary = Color(hex: 0xA1A1A1)
    static let tertiary = Color(hex: 0x737373)
    /// `--primary`: a filled button's fill, near white as on the desktop's dark page.
    static let primary = Color(hex: 0xEBEBEB)
    static let onPrimary = Color(hex: 0x171717)

    // Edges: seams, never drawn rules.
    static let hairline = Color.white.opacity(0.06)
    static let border = Color.white.opacity(0.1)
    /// Claude's rust, on its mark in the picks row alone.
    static let claude = Color(hex: 0xD97757)
    /// A child session's elbow back to its parent.
    static let connector = Color(hex: 0x404040)

    // Meaning. Yellow is "this is for you", and spent on nothing else.
    /// `--accent-command`: a session waiting on the reader, a card asking.
    static let accent = Color(hex: 0xE5C057)
    /// `--accent-add`: added lines, an open PR, an unread session.
    static let add = Color(hex: 0x09BB83)
    /// `--destructive`: removed lines, failures.
    static let destructive = Color(hex: 0xFF6467)
    /// `--accent-merged`: a merged PR.
    static let merged = Color(hex: 0xA855F7)
    /// `--accent-merge`: GitHub's own green, on the merge button alone.
    static let merge = Color(hex: 0x238636)
    /// `--accent-mention`: a link in prose, far from the yellow so it never reads as a mark.
    static let link = Color(hex: 0x5AD3FF)

    /// `--radius` 10pt and its rungs: never a sharp rectangle. Pills are
    /// capsules, not a rung.
    enum Radius {
        /// Menu items, small tiles, chips.
        static let sm: CGFloat = 8
        /// Buttons, code wells.
        static let md: CGFloat = 10
        /// Cards and sheets' groups.
        static let lg: CGFloat = 14
        /// Icon tiles.
        static let tile: CGFloat = 12
        /// Settings' server cards and a server's own groups.
        static let group: CGFloat = 18
        /// The composer and the sent bubble.
        static let xl: CGFloat = 20
    }

    enum Space {
        static let xs: CGFloat = 4
        static let s: CGFloat = 8
        static let m: CGFloat = 12
        static let l: CGFloat = 16
        static let xl: CGFloat = 24
        static let xxl: CGFloat = 32
    }

    /// The type scale, and every font the app draws: SF Pro, no monospace,
    /// regular and semibold only. Sizes are Dynamic Type's default and scale with it.
    enum Font {
        /// Empty-state titles, the PR title.
        static let title = TypeStyle(20, 26, .semibold, .title3)
        /// Nav titles, primary buttons.
        static let headline = TypeStyle(17, 22, .semibold, .headline)
        /// List rows, settings rows, the transcript, fields, the project strip.
        static let body = TypeStyle(16, 22, .regular, .body)
        /// Supporting lines. Status words stay regular: colour alone marks them.
        static let subhead = TypeStyle(15, 20, .regular, .subheadline)
        /// Compact pill buttons (Next, Retry now). Full-width buttons take `headline`.
        static let pill = TypeStyle(15, 20, .semibold, .subheadline)
        /// Meta, times, section labels, the picks row.
        static let footnote = TypeStyle(13, 18, .regular, .footnote)
        /// Words just spoken, large and dim at the top of the open voice dock.
        static let spoken = TypeStyle(20, 26, .regular, .title3)
        /// The model's name in the picks row, and nothing else.
        static let footnoteStrong = TypeStyle(13, 18, .semibold, .footnote)
    }

    /// The full-screen image viewer.
    enum Viewer {
        /// The strip's thumbnails, and the bar's round buttons.
        static let thumb: CGFloat = 44
        /// Around the current thumbnail: the page's colour, then a light ring.
        static let ringGap: CGFloat = 2
        static let ring: CGFloat = 1.5
        /// The strip's other thumbnails, and what the page keeps behind a dragged image.
        static let dim = 0.45
        /// A disabled bar button.
        static let off = 0.35
        /// The bar holding Close, the count and Share.
        static let bar: CGFloat = 56
        /// The bar's glyphs.
        static let glyph = SwiftUI.Font.system(size: 17, weight: .semibold)
        /// "Couldn't load image"'s picture, and a failed thumbnail's.
        static let mark = SwiftUI.Font.system(size: 32)
        static let thumbMark = SwiftUI.Font.system(size: 18)
        /// Try again's height.
        static let button: CGFloat = 40
        /// Strip to caption, and caption to the screen's foot past the home indicator.
        static let stripGap: CGFloat = 18
        static let foot: CGFloat = 10
        /// A dragged image's lift.
        static let shadow = Color.black.opacity(0.6)
        static let shadowRadius: CGFloat = 25
        static let shadowY: CGFloat = 20
        /// How far down a drag goes before letting go dismisses.
        static let dismissAt: CGFloat = 120
        static let maxZoom: CGFloat = 4
    }

    /// Quick and settling, never bouncy: what moves is a row arriving, not a toy.
    static let motion = Animation.snappy(duration: 0.28)
}

/// One rung of the type scale: a size, the line it sits on, a weight, and the
/// Dynamic Type style it scales with. Sized when drawn, never cached, so a
/// text-size change in Settings lands without a relaunch.
struct TypeStyle {
    let size: CGFloat
    let leading: CGFloat
    let weight: SwiftUI.Font.Weight
    let style: UIFont.TextStyle

    init(_ size: CGFloat, _ leading: CGFloat, _ weight: SwiftUI.Font.Weight, _ style: UIFont.TextStyle) {
        (self.size, self.leading, self.weight, self.style) = (size, leading, weight, style)
    }

    /// The font at a text size; the app's current one where none is given.
    func font(_ traits: UITraitCollection? = nil) -> SwiftUI.Font {
        .system(size: UIFontMetrics(forTextStyle: style).scaledValue(for: size, compatibleWith: traits), weight: weight)
    }

    /// Added between lines so wrapped text sits on the scale's line height.
    func spacing(_ traits: UITraitCollection? = nil) -> CGFloat {
        let metrics = UIFontMetrics(forTextStyle: style)
        let line = UIFont.systemFont(ofSize: metrics.scaledValue(for: size, compatibleWith: traits)).lineHeight
        return max(0, metrics.scaledValue(for: leading, compatibleWith: traits) - line)
    }

    var font: SwiftUI.Font { font() }
}

/// Sets a rung at the text size in the environment, so it follows a change live.
private struct TypeModifier: ViewModifier {
    let style: TypeStyle
    @Environment(\.dynamicTypeSize) private var dynamic

    func body(content: Content) -> some View {
        let traits = UITraitCollection(preferredContentSizeCategory: UIContentSizeCategory(dynamic))
        content.font(style.font(traits)).lineSpacing(style.spacing(traits))
    }
}

extension View {
    /// A rung of the type scale, line height included.
    func font(_ style: TypeStyle) -> some View {
        modifier(TypeModifier(style: style))
    }
}

extension Text {
    /// The scale's font where a `Text` must stay one, to be joined with `+`.
    func font(_ style: TypeStyle) -> Text { font(style.font) }
}

extension Color {
    init(hex: UInt32) {
        self.init(red: Double((hex >> 16) & 0xFF) / 255, green: Double((hex >> 8) & 0xFF) / 255,
                  blue: Double(hex & 0xFF) / 255)
    }
}

/// Haptics where something happened the reader should feel: a send, a card
/// arriving, a merge landing, a failure. Never on a plain tap.
enum Haptic {
    static func tap() { UIImpactFeedbackGenerator(style: .light).impactOccurred() }
    static func firm() { UIImpactFeedbackGenerator(style: .medium).impactOccurred() }
    static func select() { UISelectionFeedbackGenerator().selectionChanged() }
    static func success() { UINotificationFeedbackGenerator().notificationOccurred(.success) }
    static func warning() { UINotificationFeedbackGenerator().notificationOccurred(.warning) }
    static func error() { UINotificationFeedbackGenerator().notificationOccurred(.error) }
}

// MARK: Buttons

/// The filled button: near-white with a straight-down shadow, the desktop's
/// `default` variant. One per surface, on the thing the surface is for.
struct PrimaryButtonStyle: ButtonStyle {
    var fill = Theme.primary
    var ink = Theme.onPrimary
    /// 44 standing alone; 36 inside a card's own row.
    var height: CGFloat = 44
    @Environment(\.isEnabled) private var enabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(Theme.Font.headline)
            .foregroundStyle(enabled ? ink : Theme.tertiary)
            .padding(.horizontal, Theme.Space.l)
            .frame(minHeight: height)
            .background(enabled ? fill : Theme.raised, in: .rect(cornerRadius: Theme.Radius.md, style: .continuous))
            .shadow(color: .black.opacity(enabled ? 0.4 : 0), radius: 2, y: 1)
            .pressed(configuration.isPressed)
    }
}

/// The full-width white capsule inside a server's status card: Update, Scan QR code.
struct CapsuleButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var enabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(Theme.Font.headline)
            .foregroundStyle(enabled ? Theme.page : Theme.tertiary)
            .frame(maxWidth: .infinity, minHeight: 44)
            .background(enabled ? Theme.text : Theme.raised, in: Capsule())
            .pressed(configuration.isPressed)
    }
}

/// The settings switch: the desktop's near-white track with a dark thumb when
/// on, which the system `Toggle` cannot draw.
struct SwitchStyle: ToggleStyle {
    func makeBody(configuration: Configuration) -> some View {
        Button {
            withAnimation(Theme.motion) { configuration.isOn.toggle() }
        } label: {
            HStack(spacing: Theme.Space.m) {
                configuration.label.frame(maxWidth: .infinity, alignment: .leading)
                Capsule()
                    .fill(configuration.isOn ? Theme.primary : Theme.off)
                    .frame(width: 51, height: 31)
                    .overlay(alignment: configuration.isOn ? .trailing : .leading) {
                        Circle().fill(configuration.isOn ? Theme.onPrimary : Theme.secondary)
                            .frame(width: 27, height: 27).padding(2)
                    }
            }
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityValue(configuration.isOn ? "On" : "Off")
        .accessibilityAddTraits(.isToggle)
    }
}

/// The second action: a fill one step above its surface, no shadow.
struct SecondaryButtonStyle: ButtonStyle {
    var ink = Theme.text
    @Environment(\.isEnabled) private var enabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(Theme.Font.headline)
            .foregroundStyle(enabled ? ink : Theme.tertiary)
            .padding(.horizontal, Theme.Space.l)
            .frame(minHeight: 44)
            .background(Theme.raised, in: .rect(cornerRadius: Theme.Radius.md, style: .continuous))
            .pressed(configuration.isPressed)
    }
}

/// A compact capsule button: semibold `pill` text, dimmed rather than greyed when off.
struct PillButtonStyle: ButtonStyle {
    var fill = Theme.raised
    var height: CGFloat = 44
    @Environment(\.isEnabled) private var enabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(Theme.Font.pill)
            .foregroundStyle(Theme.text)
            .padding(.horizontal, 22)
            .frame(minHeight: height)
            .background(fill, in: Capsule())
            .opacity(enabled ? 1 : 0.4)
            .pressed(configuration.isPressed)
    }
}

/// A 32pt round icon button on a raised surface: copy, share, stop.
struct CircleButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(Theme.Font.pill.font)
            .foregroundStyle(Theme.text)
            .frame(width: 32, height: 32)
            .background(Theme.tile, in: Circle())
            .contentShape(Circle())
            .pressed(configuration.isPressed)
    }
}

/// A square icon button, 36pt, filled or bare: the composer's send, stop and mic.
struct IconButtonStyle: ButtonStyle {
    var filled = false
    @Environment(\.isEnabled) private var enabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 15, weight: .semibold))
            .foregroundStyle(filled ? (enabled ? Theme.onPrimary : Theme.tertiary) : (enabled ? Theme.secondary : Theme.tertiary))
            .frame(width: 36, height: 36)
            .background {
                if filled {
                    RoundedRectangle(cornerRadius: Theme.Radius.md, style: .continuous)
                        .fill(enabled ? Theme.primary : Theme.raised)
                }
            }
            .contentShape(.rect)
            .pressed(configuration.isPressed)
    }
}

/// A row that answers a press by dimming, with its own hit area.
struct RowButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .contentShape(.rect)
            .opacity(configuration.isPressed ? 0.55 : 1)
    }
}

extension View {
    /// The press every button here shares: a slight give, quick both ways.
    func pressed(_ on: Bool) -> some View {
        scaleEffect(on ? 0.97 : 1).opacity(on ? 0.85 : 1).animation(.snappy(duration: 0.18), value: on)
    }

    /// A surface in the page: card fill, hairline edge, `lg` radius.
    func card(padding: CGFloat = Theme.Space.l, edge: Color = Theme.hairline) -> some View {
        self.padding(padding)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.card, in: .rect(cornerRadius: Theme.Radius.lg, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: Theme.Radius.lg, style: .continuous).strokeBorder(edge))
    }

    /// Cut into whatever it sits on: code and tool output.
    func well() -> some View {
        background(Theme.well, in: .rect(cornerRadius: Theme.Radius.md, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: Theme.Radius.md, style: .continuous).strokeBorder(Theme.hairline))
    }

    /// The page behind a screen, edge to edge.
    func page() -> some View {
        background(Theme.page.ignoresSafeArea())
    }

    /// A grouped list on the page rather than on the system's grey.
    func themedList() -> some View {
        scrollContentBackground(.hidden).page()
    }
}

/// A small heading over a group: sentence case, never shouted.
struct GroupLabel: View {
    let text: String
    init(_ text: String) { self.text = text }

    var body: some View {
        Text(text)
            .font(Theme.Font.footnote)
            .foregroundStyle(Theme.tertiary)
            .padding(.horizontal, Theme.Space.xs)
    }
}

/// A screen with nothing to show yet, or nothing at all: a mark, one line,
/// a sentence, and what to do about it.
struct EmptyState<Mark: View, Actions: View>: View {
    let title: String
    let message: String
    @ViewBuilder let mark: Mark
    @ViewBuilder let actions: Actions

    var body: some View {
        VStack(spacing: Theme.Space.l) {
            mark.padding(.bottom, Theme.Space.xs)
            VStack(spacing: Theme.Space.s) {
                Text(title).font(Theme.Font.title).foregroundStyle(Theme.text)
                Text(message).font(Theme.Font.subhead).foregroundStyle(Theme.secondary)
                    .multilineTextAlignment(.center)
            }
            VStack(spacing: Theme.Space.s) { actions }
                .frame(maxWidth: 280)
                .padding(.top, Theme.Space.s)
        }
        .padding(Theme.Space.xxl)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

extension EmptyState where Actions == EmptyView {
    init(title: String, message: String, @ViewBuilder mark: () -> Mark) {
        self.init(title: title, message: message, mark: mark, actions: { EmptyView() })
    }
}
