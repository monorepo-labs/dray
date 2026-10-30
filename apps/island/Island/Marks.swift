import SwiftUI
import ThinkingOrbs

/// What a session's row says about it, the desktop sidebar's marks: the rail
/// dot, the pull request, and what is in flight.
struct Marks: Equatable {
    var asking = false
    var unread = false
    var busy = false
    var pr: PrMark?

    var checksRunning: Bool { pr?.state == "OPEN" && pr?.checksState == "RUNNING" }
}

/// The sidebar's rail mark: yellow waits on the reader, green is finished and
/// unread. Dark mode's `--accent-command` and `--accent-add`, since the panel is always dark.
struct StatusDot: View {
    let marks: Marks
    static let waiting = Color(red: 0.897, green: 0.753, blue: 0.34)
    static let unread = Color(red: 0.036, green: 0.732, blue: 0.514)

    var body: some View {
        Rail(color: marks.asking ? Self.waiting : marks.unread ? Self.unread : .clear)
    }
}

/// A 2×6 bar in a fixed 8pt slot, so the title never moves when it comes and goes.
struct Rail: View {
    let color: Color

    var body: some View {
        RoundedRectangle(cornerRadius: 1).fill(color)
            .frame(width: 2, height: 6)
            .frame(width: 8)
    }
}

/// The one mark ahead of a title: running checks, else the turn working, else
/// the pull request. Each at its own width, so the title sits close behind it.
struct LeadMark: View {
    let marks: Marks
    /// Off where the title shimmers instead, which says the same.
    var orb = true

    var body: some View {
        if marks.checksRunning {
            ChecksSpinner()
        } else if marks.busy && orb {
            Orb(state: .working, size: 16).foregroundStyle(.white.opacity(0.7))
        } else if let pr = marks.pr {
            PrGlyph(mark: pr, size: 13)
        }
    }

    var shown: Bool { marks.checksRunning || (marks.busy && orb) || marks.pr != nil }
}

/// The selected session's title row: the title opens the task list behind its
/// lead mark, ⌘-click opens the session in Dray, and the hints teach the keys.
struct TitleRow: View {
    let title: String
    let marks: Marks
    let close: String
    let list: () -> Void
    let openInApp: () -> Void
    @State private var hovered = false

    var body: some View {
        HStack(spacing: 12) {
            Button {
                if NSEvent.modifierFlags.contains(.command) { openInApp() } else { list() }
            } label: {
                HStack(spacing: 4) {
                    let lead = LeadMark(marks: marks, orb: false)
                    if lead.shown { lead }
                    Text(title).lineLimit(1)
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(.white.opacity(hovered ? 1 : 0.7))
                        .shimmer(marks.busy, period: 1.4)
                    Spacer(minLength: 0)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .onHover { hovered = $0 }
            .animation(.easeOut(duration: 0.12), value: hovered)
            .help("Tasks, ⌘-click to open in Dray")
            KeyHints(new: true, close: close)
        }
    }
}

/// The panel's keys, dimmed. `close` is the composer's `closeHint`, since Esc
/// only reaches a panel holding the keys.
struct KeyHints: View {
    let new: Bool
    let close: String

    var body: some View {
        HStack(spacing: 10) {
            if new { Text("⌘N New") }
            Text("↑↓ Tasks")
            Text(close)
        }
        .font(.system(size: 12))
        .foregroundStyle(.white.opacity(0.3))
        .fixedSize()
    }
}

/// A task in the list, marked the way the desktop sidebar marks its rows.
struct SessionRow: View {
    let title: String
    let project: String
    let marks: Marks
    let selected: Bool
    @State private var hover = false
    static let height: CGFloat = 32

    var body: some View {
        HStack(spacing: 4) {
            let lead = LeadMark(marks: marks)
            if lead.shown { lead }
            Text(title.isEmpty ? "Untitled" : title).lineLimit(1)
            Spacer(minLength: 8)
            Text(project).lineLimit(1).foregroundStyle(.secondary)
        }
        .font(.system(size: 13))
        .padding(.horizontal, 8)
        // In the padding at the row's edge, the sidebar's place, so the slot costs the title nothing.
        .overlay(alignment: .leading) { StatusDot(marks: marks) }
        .frame(height: Self.height)
        .background(selected ? .white.opacity(0.12) : hover ? .white.opacity(0.06) : .clear, in: RoundedRectangle(cornerRadius: 8))
        .contentShape(Rectangle())
        .onHover { hover = $0 }
    }
}

/// The sessions waiting on the reader, oldest first, scrolling sideways past
/// the card's width.
struct AskTabs: View {
    let titles: [String]
    let active: Int
    let pick: (Int) -> Void
    let openInApp: (Int) -> Void

    var body: some View {
        ScrollView(.horizontal) {
            HStack(spacing: 4) {
                ForEach(Array(titles.enumerated()), id: \.offset) { i, title in
                    AskTab(title: title, active: i == active) {
                        if NSEvent.modifierFlags.contains(.command) { openInApp(i) } else { pick(i) }
                    }
                }
            }
        }
        .scrollIndicators(.never)
    }
}

/// One waiting session over the card, as a browser tab: the active one names
/// itself, the others are clipped short. ⌘-click opens it in Dray.
struct AskTab: View {
    let title: String
    let active: Bool
    let pick: () -> Void
    @State private var hovered = false

    var body: some View {
        Button(action: pick) {
            Text(title).lineLimit(1)
                .font(.system(size: 12, weight: active ? .semibold : .regular))
                .foregroundStyle(.white.opacity(active || hovered ? 0.9 : 0.5))
                .padding(.horizontal, 8)
            .frame(maxWidth: active ? 200 : 72, alignment: .leading)
            .frame(height: 24)
            .background(.white.opacity(active ? 0.12 : hovered ? 0.08 : 0.04), in: RoundedRectangle(cornerRadius: 7))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .fixedSize(horizontal: active, vertical: false)
        // A clipped title reads in full on hover, without the strip moving under the cursor.
        .help(active ? "" : title)
        .onHover { hovered = $0 }
        .animation(.snappy(duration: 0.2), value: hovered)
    }
}

/// Hangs from the notch while the panel is shut and sessions wait on the
/// reader, until every one is answered. Resting the pointer on it opens the
/// panel on the cards; a short dwell keeps a pointer passing by from doing so.
struct AttentionPill: View {
    let notch: Bool
    let notchHeight: CGFloat
    let count: Int
    var glowing = false
    let action: () -> Void
    @State private var dwell: Task<Void, Never>?

    var body: some View {
        Button(action: action) {
            PillShell(notch: notch, notchHeight: notchHeight, glow: glowing ? StatusDot.waiting : nil) {
                HStack(spacing: 8) {
                    Circle().fill(StatusDot.waiting).frame(width: 6, height: 6)
                    Text("\(count) \(count == 1 ? "task needs" : "tasks need") attention")
                        .font(.system(size: 13, weight: .semibold)).lineLimit(1)
                }
            }
        }
        .buttonStyle(.plain)
        .onHover { inside in
            dwell?.cancel()
            guard inside else { return }
            dwell = Task {
                try? await Task.sleep(for: .milliseconds(150))
                if !Task.isCancelled { action() }
            }
        }
    }
}

/// Sessions finished, in place of Dray's banner, newest first. One names
/// itself and offers Open in app; several are a count that, under the pointer,
/// grows a row each, five tall and then scrolling. A title opens the island on it.
struct DonePill: View {
    let notch: Bool
    let notchHeight: CGFloat
    let items: [(key: SessionKey, title: String)]
    var glowing = false
    let open: (SessionKey) -> Void
    let openInApp: (SessionKey) -> Void
    var hover: (Bool) -> Void = { _ in }
    @State private var expanded = false
    @State private var collapse: Task<Void, Never>?
    private static let row: CGFloat = 26

    var body: some View {
        PillShell(notch: notch, notchHeight: notchHeight, glow: glowing ? StatusDot.unread : nil) {
            // One structure, open or shut, so the pill grows rather than swapping layouts.
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 8) {
                    Circle().fill(StatusDot.unread).frame(width: 6, height: 6)
                    Text(items.count == 1 ? "Done" : "\(items.count) tasks done").font(.system(size: 13, weight: .semibold))
                    // Several are a count alone; their titles wait for the pointer.
                    if items.count == 1, let first = items.first {
                        DoneTitle(title: first.title, cap: 240)
                        OpenInAppButton(chord: true) { openInApp(first.key) }
                    }
                }
                .contentShape(Rectangle())
                .onTapGesture { if let first = items.first { open(first.key) } }
                if expanded {
                    ScrollView {
                        VStack(spacing: 0) {
                            ForEach(items, id: \.key) { item in
                                HStack(spacing: 8) {
                                    Button { open(item.key) } label: { DoneTitle(title: item.title, cap: 240) }
                                        .buttonStyle(.plain)
                                    Spacer(minLength: 0)
                                    OpenInAppButton { openInApp(item.key) }
                                }
                                .frame(height: Self.row)
                            }
                        }
                    }
                    .scrollIndicators(.never)
                    .frame(height: CGFloat(min(items.count, 5)) * Self.row)
                    .transition(.opacity)
                }
            }
            .frame(width: expanded ? 360 : nil, alignment: .leading)
        }
        .onHover { inside in
            hover(inside)
            collapse?.cancel()
            guard items.count > 1 else { return }
            if inside {
                withAnimation(.spring(duration: 0.3, bounce: 0.12)) { expanded = true }
            } else {
                // A beat before shutting, so a pointer grazing the edge it just grew past does not flicker it.
                collapse = Task {
                    try? await Task.sleep(for: .milliseconds(150))
                    guard !Task.isCancelled else { return }
                    withAnimation(.spring(duration: 0.25, bounce: 0)) { expanded = false }
                }
            }
        }
    }
}

private struct DoneTitle: View {
    let title: String
    let cap: CGFloat
    @State private var hover = false

    var body: some View {
        // Brightens under the pointer, since a click opens the island on it.
        Text(title.isEmpty ? "Untitled" : title).lineLimit(1)
            .font(.system(size: 13))
            .foregroundStyle(.white.opacity(hover ? 0.95 : 0.55))
            // A cap, not a fill: its own width up to the cap, then truncated.
            .frame(maxWidth: cap, alignment: .leading)
            .fixedSize(horizontal: true, vertical: false)
            .onHover { hover = $0 }
            .animation(.easeOut(duration: 0.12), value: hover)
    }
}

private struct OpenInAppButton: View {
    /// ⌘⏎ opens the newest alone, so only its button names the chord.
    var chord = false
    let action: () -> Void
    @State private var hover = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: 6) {
                Text("Open in app")
                if chord { Text("⌘⏎").foregroundStyle(.white.opacity(0.45)) }
            }
            .font(.system(size: 12, weight: .medium))
            .padding(.horizontal, 10)
            .frame(height: 22)
            .background(.white.opacity(hover ? 0.22 : 0.12), in: Capsule())
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .onHover { hover = $0 }
        .animation(.easeOut(duration: 0.12), value: hover)
    }
}

/// The shape every pill hangs in: from the notch, or a capsule above the Dock.
struct PillShell<Content: View>: View {
    let notch: Bool
    let notchHeight: CGFloat
    /// A soft edge in this colour while news is fresh; `Composer.glowing` says when.
    var glow: Color? = nil
    @ViewBuilder let content: Content

    var body: some View {
        content
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
            .padding(.top, notchHeight)
            // A floor to clear the notch, and no ceiling, so it hugs its words. Above the Dock there is nothing to clear.
            .frame(minWidth: notch ? 200 : 0)
            // Its own size, whatever the card it hangs from proposes; a narrower proposal centred the words in a clipped 200pt slot.
            .fixedSize()
            // Rows growing in stay inside the edge while it moves.
            .clipped()
            .background {
                Group {
                    if notch {
                        NotchShape(radius: 16).fill(.black)
                            .overlay { if let glow { NotchShape(radius: 16, closed: false).stroke(glow.opacity(0.25), lineWidth: 1) } }
                    } else {
                        RoundedRectangle(cornerRadius: 20, style: .continuous).fill(.black)
                            .overlay { if let glow { RoundedRectangle(cornerRadius: 20, style: .continuous).stroke(glow.opacity(0.25), lineWidth: 1) } }
                    }
                }
                .shadow(color: glow?.opacity(0.45) ?? .clear, radius: 12)
                .padding(.horizontal, notch ? -NotchShape.ear : 0)
            }
            .contentShape(Rectangle())
    }
}
