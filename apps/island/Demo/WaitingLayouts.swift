import SwiftUI

/// Ways to show several sessions waiting other than today's tabs, side by side
/// so one can be picked by looking. Each runs the real composer and the real
/// card body; only the part naming and switching sessions differs.
struct WaitingLayouts: View {
    let items: [SessionItem]
    let asks: [AgentEvent]

    var body: some View {
        ForEach(WaitingLayout.allCases) { layout in
            VStack(alignment: .leading, spacing: 8) {
                Text(layout.name).font(.headline)
                Text(layout.note).foregroundStyle(.secondary).lineLimit(2, reservesSpace: true)
                LayoutStage(layout: layout, items: items, asks: asks)
            }
        }
    }
}

enum WaitingLayout: String, CaseIterable, Identifiable {
    case tabs, pager, deck, list, menu, side
    var id: Self { self }

    var name: String {
        switch self {
        case .tabs: "Tabs (today)"
        case .pager: "Pager"
        case .deck: "Deck"
        case .list: "List"
        case .menu: "Menu"
        case .side: "Side list"
        }
    }

    var note: String {
        switch self {
        case .tabs: "What ships: a tab per session, the picked one named in full."
        case .pager: "One title, a count and arrows. Narrowest header; the others are a click away, unnamed."
        case .deck: "Cards stacked, the ones behind peeking out under it. Answer or dismiss and the next slides up."
        case .list: "Every session a row saying what it asks; the picked one opens in place. × on a row's hover."
        case .menu: "The title is a menu holding the others, a count beside it."
        case .side: "Sessions down the left, the card on the right. Every title in full, less room for the card."
        }
    }
}

private struct LayoutStage: View {
    let layout: WaitingLayout
    @State private var composer: Composer

    init(layout: WaitingLayout, items: [SessionItem], asks: [AgentEvent]) {
        self.layout = layout
        let store = Store()
        let server = UUID()
        store.seed(server, items: items, asks: asks)
        let composer = Composer(store: store, server: server)
        composer.shown = true
        composer.keyed = true
        composer.hide = { [weak composer] in composer?.shown = false }
        _composer = State(initialValue: composer)
    }

    var body: some View {
        VStack(spacing: 0) {
            if composer.shown, let ask = composer.ask {
                LayoutCard(layout: layout, composer: composer, key: ask.key, event: ask.event)
                    .environment(composer.store)
            } else {
                Text("Panel closed. Replay brings the cards back.").foregroundStyle(.secondary).padding(.top, 40)
            }
        }
        .frame(width: Composer.width + 48, alignment: .top)
        .frame(minHeight: 360, alignment: .top)
        .padding(.vertical, 16)
        .background(Color(white: 0.22), in: RoundedRectangle(cornerRadius: 12))
        .environment(\.colorScheme, .dark)
    }
}

private struct LayoutCard: View {
    @Environment(Store.self) private var store
    let layout: WaitingLayout
    let composer: Composer
    let key: SessionKey
    let event: AgentEvent

    private var keys: [SessionKey] { composer.attention }
    private var index: Int { keys.firstIndex(of: key) ?? 0 }

    var body: some View {
        VStack(spacing: 0) {
            Group {
                switch layout {
                case .tabs: AskCard(composer: composer, key: key, event: event)
                case .pager: pager
                case .deck: deck
                case .list: list
                case .menu: menu
                case .side: side
                }
            }
            .padding(12)
            .frame(width: Composer.width, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 16).fill(.black))
            .overlay { RoundedRectangle(cornerRadius: 16).stroke(.white.opacity(0.12), lineWidth: 0.5) }
            if layout == .deck { peeks }
        }
        .animation(.spring(duration: 0.3, bounce: 0.15), value: key)
    }

    // MARK: Layouts

    private var pager: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                title(key)
                Spacer(minLength: 0)
                dismissAll
                HStack(spacing: 4) {
                    arrow("chevron.left", disabled: index == 0) { composer.askTab = keys[index - 1] }
                    Text("\(index + 1) of \(keys.count)").font(.system(size: 12).monospacedDigit())
                        .foregroundStyle(.white.opacity(0.5))
                    arrow("chevron.right", disabled: index == keys.count - 1) { composer.askTab = keys[index + 1] }
                }
            }
            askBody(event)
        }
    }

    private var deck: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                title(key)
                Spacer(minLength: 0)
                dismissAll
                if keys.count > 1 {
                    plain("Next  \(keys.count - 1) more") { next() }
                }
            }
            askBody(event)
        }
    }

    /// The cards under the top one, two at most, each a little narrower.
    private var peeks: some View {
        VStack(spacing: 0) {
            ForEach(0..<min(keys.count - 1, 2), id: \.self) { i in
                UnevenRoundedRectangle(bottomLeadingRadius: 10, bottomTrailingRadius: 10)
                    .fill(Color(white: i == 0 ? 0.1 : 0.06))
                    .frame(width: Composer.width - CGFloat(i + 1) * 28, height: 7)
                    .onTapGesture { next() }
            }
        }
    }

    private var list: some View {
        VStack(alignment: .leading, spacing: 4) {
            ForEach(keys, id: \.self) { k in
                if k == key {
                    VStack(alignment: .leading, spacing: 8) {
                        HStack(spacing: 8) {
                            Circle().fill(StatusDot.waiting).frame(width: 6, height: 6)
                            Text(name(k)).font(.system(size: 13, weight: .semibold)).lineLimit(1)
                            Spacer(minLength: 0)
                            dismissAll
                        }
                        askBody(event)
                    }
                    .padding(10)
                    .background(.white.opacity(0.06), in: RoundedRectangle(cornerRadius: 10))
                } else {
                    WaitingRow(title: name(k), summary: summary(k), pick: { composer.askTab = k },
                            dismiss: { composer.dismissAsks(k) })
                }
            }
        }
    }

    private var menu: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Menu {
                    ForEach(keys, id: \.self) { k in
                        Button { composer.askTab = k } label: {
                            Text(name(k))
                            Text(summary(k))
                        }
                    }
                    Divider()
                    Button("Dismiss all") { composer.dismissAsks() }
                } label: {
                    HStack(spacing: 6) {
                        Text(name(key)).font(.system(size: 13, weight: .semibold)).lineLimit(1)
                        if keys.count > 1 {
                            Text("+\(keys.count - 1)").font(.system(size: 11, weight: .semibold))
                                .padding(.horizontal, 6).frame(height: 18)
                                .background(StatusDot.waiting.opacity(0.25), in: Capsule())
                        }
                        Image(systemName: "chevron.down").font(.system(size: 10, weight: .semibold))
                    }
                    .foregroundStyle(.white.opacity(0.7))
                }
                .menuStyle(.button)
                .buttonStyle(.plain)
                .menuIndicator(.hidden)
                .fixedSize()
                Spacer(minLength: 0)
            }
            askBody(event)
        }
    }

    private var side: some View {
        HStack(alignment: .top, spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                ForEach(keys, id: \.self) { k in
                    Button { composer.askTab = k } label: {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(name(k)).font(.system(size: 12, weight: k == key ? .semibold : .regular)).lineLimit(2)
                                .foregroundStyle(.white.opacity(k == key ? 0.9 : 0.55))
                            Text(summary(k)).font(.system(size: 11)).lineLimit(1).foregroundStyle(.white.opacity(0.35))
                        }
                        .padding(8)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(.white.opacity(k == key ? 0.1 : 0), in: RoundedRectangle(cornerRadius: 8))
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
                Spacer(minLength: 8)
                plain("Dismiss all") { composer.dismissAsks() }.padding(.leading, 8)
            }
            .frame(width: 150)
            VStack(alignment: .leading, spacing: 10) {
                askBody(event)
            }
        }
    }

    // MARK: Pieces

    private func next() {
        guard keys.count > 1 else { return }
        composer.askTab = keys[(index + 1) % keys.count]
    }

    private func name(_ k: SessionKey) -> String { store.items[k]?.title ?? "Session" }

    /// What a session asks, in a line: the tool and its purpose, or the first question.
    private func summary(_ k: SessionKey) -> String {
        switch store.asks[k]?.first?.payload {
        case .permissionRequested(let r)?:
            let tool = r.displayName ?? r.toolName
            return [tool, r.description ?? r.input.flatMap(toolArgument)].compactMap { $0 }.joined(separator: "  ")
        case .questionsAsked(let r)?:
            return r.questions.first?.question ?? "A question"
        default:
            return ""
        }
    }

    private func title(_ k: SessionKey) -> some View {
        Text(name(k)).lineLimit(1)
            .font(.system(size: 13, weight: .semibold))
            .foregroundStyle(.white.opacity(0.45))
    }

    /// Up top beside the switcher, as on the real card.
    @ViewBuilder private var dismissAll: some View {
        if keys.count > 1 {
            DismissButton(label: "Dismiss all", help: "Hide all until a new task needs you. They still wait in Dray.") { composer.dismissAsks() }
        }
    }

    private func askBody(_ e: AgentEvent) -> some View {
        AskBody(composer: composer, event: e) { composer.dismissAsks(key) }.id(e.id)
    }

    private func arrow(_ symbol: String, disabled: Bool, _ action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol).font(.system(size: 11, weight: .semibold))
                .frame(width: 20, height: 20)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .foregroundStyle(.white.opacity(disabled ? 0.2 : 0.7))
        .disabled(disabled)
    }

    private func plain(_ label: String, _ action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(label).font(.system(size: 12, weight: .medium)).foregroundStyle(.white.opacity(0.5))
        }
        .buttonStyle(.plain)
    }
}

/// A waiting session folded to one line in the list layout; × shows on hover.
private struct WaitingRow: View {
    let title: String
    let summary: String
    let pick: () -> Void
    let dismiss: () -> Void
    @State private var hover = false

    var body: some View {
        HStack(spacing: 8) {
            Circle().fill(StatusDot.waiting).frame(width: 6, height: 6)
            Text(title).font(.system(size: 13)).lineLimit(1).foregroundStyle(.white.opacity(0.75)).layoutPriority(1)
            Text(summary).font(.system(size: 12)).lineLimit(1).foregroundStyle(.white.opacity(0.35))
            Spacer(minLength: 0)
            Button(action: dismiss) { Image(systemName: "xmark").font(.system(size: 10, weight: .semibold)) }
                .buttonStyle(.plain)
                .foregroundStyle(.white.opacity(0.5))
                .opacity(hover ? 1 : 0)
                .help("Dismiss")
        }
        .padding(.horizontal, 10)
        .frame(height: 30)
        .background(.white.opacity(hover ? 0.06 : 0), in: RoundedRectangle(cornerRadius: 8))
        .contentShape(Rectangle())
        .onTapGesture(perform: pick)
        .onHover { hover = $0 }
    }
}
