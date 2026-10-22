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

    /// `--radius` 10pt and its rungs. Everything is a rounded square: never a
    /// sharp rectangle, never a pill.
    enum Radius {
        /// Menu items, small tiles, chips.
        static let sm: CGFloat = 8
        /// Buttons, code wells.
        static let md: CGFloat = 10
        /// Cards and sheets' groups.
        static let lg: CGFloat = 14
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

    /// SF Pro through Dynamic Type, so the reader's text size moves all of it.
    enum Font {
        static let title = SwiftUI.Font.title2.weight(.semibold)
        static let headline = SwiftUI.Font.headline
        /// Prose: answers, prompts.
        static let body = SwiftUI.Font.body
        /// A list row's title.
        static let row = SwiftUI.Font.body.weight(.medium)
        /// Tool rows, labels beside a control.
        static let callout = SwiftUI.Font.subheadline
        /// What sits under a title: project, server, time.
        static let meta = SwiftUI.Font.footnote
        static let micro = SwiftUI.Font.caption
        /// A path or a command inside a sentence.
        static let mono = SwiftUI.Font.system(.subheadline, design: .monospaced)
        /// A block of code or output.
        static let code = SwiftUI.Font.system(.footnote, design: .monospaced)
    }

    /// Quick and settling, never bouncy: what moves is a row arriving, not a toy.
    static let motion = Animation.snappy(duration: 0.28)
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
            .font(.body.weight(.semibold))
            .foregroundStyle(enabled ? ink : Theme.tertiary)
            .padding(.horizontal, Theme.Space.l)
            .frame(minHeight: height)
            .background(enabled ? fill : Theme.raised, in: .rect(cornerRadius: Theme.Radius.md, style: .continuous))
            .shadow(color: .black.opacity(enabled ? 0.4 : 0), radius: 2, y: 1)
            .pressed(configuration.isPressed)
    }
}

/// The second action: a fill one step above its surface, no shadow.
struct SecondaryButtonStyle: ButtonStyle {
    var ink = Theme.text
    @Environment(\.isEnabled) private var enabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.body.weight(.medium))
            .foregroundStyle(enabled ? ink : Theme.tertiary)
            .padding(.horizontal, Theme.Space.l)
            .frame(minHeight: 44)
            .background(Theme.raised, in: .rect(cornerRadius: Theme.Radius.md, style: .continuous))
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
            .font(Theme.Font.meta.weight(.medium))
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
                Text(message).font(Theme.Font.callout).foregroundStyle(Theme.secondary)
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
