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

/// Yellow waits on the reader, green is finished and unread.
struct StatusDot: View {
    let marks: Marks

    var body: some View {
        Circle()
            .fill(marks.asking ? Color.yellow : marks.unread ? .green : .clear)
            .frame(width: 6, height: 6)
    }
}

/// What is in flight, where the sidebar puts it: running checks outrank the turn.
struct FlightMark: View {
    let marks: Marks

    var body: some View {
        if marks.checksRunning {
            ChecksSpinner()
        } else if marks.busy {
            Orb(state: .working, size: 18).foregroundStyle(.white.opacity(0.7))
        }
    }
}

/// The selected session's title row: the title opens it in Dray, the hints
/// teach the keys. Where it stands is the list's to say, not this row's.
struct TitleRow: View {
    let title: String
    let close: String
    let open: () -> Void
    @State private var hovered = false

    var body: some View {
        HStack(spacing: 12) {
            Button(action: open) {
                Text(title).lineLimit(1)
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(.white.opacity(hovered ? 1 : 0.7))
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .onHover { hovered = $0 }
            .animation(.easeOut(duration: 0.12), value: hovered)
            .help("Open in Dray")
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
        HStack(spacing: 8) {
            StatusDot(marks: marks)
            if let pr = marks.pr { PrGlyph(mark: pr, size: 13) }
            Text(title.isEmpty ? "Untitled" : title).lineLimit(1)
            Spacer(minLength: 8)
            FlightMark(marks: marks)
            Text(project).lineLimit(1).foregroundStyle(.secondary)
        }
        .font(.system(size: 13))
        .padding(.horizontal, 8)
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

    var body: some View {
        ScrollView(.horizontal) {
            HStack(spacing: 4) {
                ForEach(Array(titles.enumerated()), id: \.offset) { i, title in
                    AskTab(title: title, active: i == active) { pick(i) }
                }
            }
        }
        .scrollIndicators(.never)
    }
}

/// One waiting session over the card, as a browser tab: the active one names
/// itself, the others are clipped short.
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
/// reader, until every one is answered. A click opens the panel on the cards.
/// A finished session says so in Dray's own banner, which can open it there.
struct AttentionPill: View {
    let notch: Bool
    let notchHeight: CGFloat
    let count: Int
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                Circle().fill(.yellow).frame(width: 6, height: 6)
                Text("\(count) \(count == 1 ? "task needs" : "tasks need") attention")
                    .font(.system(size: 13, weight: .semibold)).lineLimit(1)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
            .padding(.top, notchHeight)
            .frame(minWidth: 200, maxWidth: 360)
            .background {
                Group {
                    if notch { NotchShape(radius: 16).fill(.black) } else { Capsule().fill(.black) }
                }
                .padding(.horizontal, notch ? -NotchShape.ear : 0)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}
