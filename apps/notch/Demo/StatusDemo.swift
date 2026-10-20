import SwiftUI

/// The task list's marks on the real rows, one made-up session per state, so
/// they can be read against each other and looked at again.
@main
struct StatusDemo: App {
    var body: some Scene {
        WindowGroup("Notch status") {
            DemoPage().frame(minWidth: 600, minHeight: 760)
        }
    }
}

private enum Turn { case idle, working, asking, done }

private enum Pull {
    case none, open, checks, failing, draft, merged

    var mark: PrMark? {
        switch self {
        case .none: nil
        case .open: PrMark(number: 573, headRefName: "b", isDraft: false, state: "OPEN", checksState: "CLEAR")
        case .checks: PrMark(number: 573, headRefName: "b", isDraft: false, state: "OPEN", checksState: "RUNNING")
        case .failing: PrMark(number: 573, headRefName: "b", isDraft: false, state: "OPEN", checksState: "FAILING")
        case .draft: PrMark(number: 573, headRefName: "b", isDraft: true, state: "OPEN", checksState: "CLEAR")
        case .merged: PrMark(number: 573, headRefName: "b", isDraft: false, state: "MERGED", checksState: "CLEAR")
        }
    }
}

private func marks(_ turn: Turn, _ pull: Pull) -> Marks {
    Marks(asking: turn == .asking, unread: turn == .done, busy: turn == .working || turn == .asking, pr: pull.mark)
}

private struct DemoPage: View {
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 28) {
                Text("Shut, from the notch").font(.headline)
                HStack(alignment: .top, spacing: 24) {
                    PillMock { AttentionPill(notch: true, notchHeight: 32, count: 1) {} }
                    PillMock { AttentionPill(notch: true, notchHeight: 32, count: 3) {} }
                }
                Text("Task list").font(.headline)
                ListMock()
                Text("Cards waiting, as tabs").font(.headline)
                ForEach([2, 3, 4, 5, 8], id: \.self) { n in TabsMock(count: n) }
            }
            .padding(28)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .background(Color(white: 0.16))
        .environment(\.colorScheme, .dark)
    }
}

/// One row per state, so the marks can be read against each other.
private struct ListMock: View {
    private let rows: [(String, String, Marks)] = [
        ("Fix the login redirect", "dray", marks(.asking, .none)),
        ("Notch status in the task list", "dray", marks(.working, .checks)),
        ("Paste images into the composer", "dray", marks(.done, .open)),
        ("Theme swatches in settings", "dray", marks(.idle, .failing)),
        ("Orb lab", "dray", marks(.working, .none)),
        ("Docs for remote access", "web", marks(.idle, .draft)),
        ("Changelog for 0.12", "web", marks(.done, .merged)),
        ("Spike: CEF memory", "dray", marks(.idle, .none)),
    ]

    var body: some View {
        VStack(spacing: 2) {
            ForEach(Array(rows.enumerated()), id: \.offset) { i, row in
                SessionRow(title: row.0, project: row.1, marks: row.2, selected: i == 1)
            }
        }
        .padding(6)
        .frame(width: 520)
        .background(.black, in: RoundedRectangle(cornerRadius: 16))
    }
}

/// The card's header with `count` sessions waiting; click a tab to switch.
private struct TabsMock: View {
    let count: Int
    @State private var active = 0
    private static let titles = [
        "Fix the login redirect loop", "Notch status in the task list", "Paste images into the composer",
        "Theme swatches in settings", "Orb lab", "Docs for remote access", "Changelog for 0.12", "Spike: CEF memory",
    ]

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                AskTabs(titles: Array(Self.titles.prefix(count)), active: active) { active = $0 }
                Spacer(minLength: 0)
                Text("⌘Esc").font(.system(size: 12)).foregroundStyle(.white.opacity(0.3))
            }
            Text("Bash  Run the test suite").font(.system(size: 13))
            Text("pnpm test --filter desktop").font(.system(size: 11).monospaced())
                .padding(8)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(.white.opacity(0.06), in: RoundedRectangle(cornerRadius: 8))
        }
        .padding(12)
        .frame(width: 520)
        .background(.black, in: RoundedRectangle(cornerRadius: 16))
    }
}

/// A strip of menu bar with the hardware notch outlined, and a pill hanging from it.
private struct PillMock<Pill: View>: View {
    @ViewBuilder let pill: Pill

    var body: some View {
        ZStack(alignment: .top) {
            Color(white: 0.28).frame(height: 32)
            pill
            UnevenRoundedRectangle(bottomLeadingRadius: 10, bottomTrailingRadius: 10)
                .stroke(.white.opacity(0.12))
                .frame(width: 190, height: 32)
        }
        .frame(width: 380, height: 110, alignment: .top)
    }
}
