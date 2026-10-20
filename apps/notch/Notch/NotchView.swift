import SwiftUI

enum Field { case input, search }

/// Two cards: the composer, hanging from the notch or sitting above the Dock,
/// and the session list on its far side. The transcript is Dray's.
struct NotchView: View {
    @Bindable var composer: Composer
    @Environment(Store.self) private var store
    @FocusState private var focus: Field?
    @State private var size = CGSize.zero

    var body: some View {
        VStack(spacing: 8) {
            if composer.placement == .notch {
                composerCard
                farSide
            } else {
                farSide
                composerCard
            }
        }
        .frame(width: Composer.width)
        .fixedSize(horizontal: false, vertical: true)
        .overlayPreferenceValue(MenuAnchors.self) { anchors in
            DropMenus(composer: composer, anchors: anchors, upward: composer.placement == .bottom)
        }
        .environment(\.colorScheme, .dark)
        .onGeometryChange(for: CGSize.self) { $0.size } action: {
            size = $0
            composer.resized($0)
        }
        // A new placement at the same size moves the window too.
        .onChange(of: composer.placement) { composer.resized(size) }
        .onChange(of: composer.opens) { focus = .input }
        .onChange(of: composer.searches) {
            composer.listShown = true
            focus = .search
        }
        .onChange(of: composer.typing) {
            if !composer.typing.isEmpty { composer.listShown = false }
        }
    }

    /// The list, or with it hidden, room for an open dropdown: the window is
    /// only as big as what it draws, and a menu past its edge is cut off.
    @ViewBuilder private var farSide: some View {
        if composer.listShown {
            SessionList(composer: composer, focus: $focus)
        } else if composer.openMenu != nil {
            Color.clear.frame(height: 280)
        }
    }

    private var composerCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            if !composer.listShown, composer.target != .new {
                HStack(spacing: 12) {
                    Button { composer.listShown = true } label: {
                        Text(title).lineLimit(1)
                            .font(.system(size: 13, weight: .semibold))
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .help("Show tasks")
                    Text("⌘N new task    ↑↓ tasks").font(.system(size: 12)).foregroundStyle(.white.opacity(0.5)).fixedSize()
                }
            }
            if composer.target == .new { NewSessionBar(composer: composer) }
            if !composer.rows.isEmpty {
                // Three rows tall at most, then it scrolls, held at the newest.
                ViewThatFits(in: .vertical) {
                    rowList
                    ScrollView { rowList }.scrollIndicators(.never).defaultScrollAnchor(.bottom)
                }
                .frame(maxHeight: 3 * 32 + 2 * 10)
                .fixedSize(horizontal: false, vertical: true)
            }
            input
            if let notice = composer.notice {
                HStack(spacing: 8) {
                    Text(notice).font(.caption).foregroundStyle(.secondary)
                    if composer.retryPath != nil {
                        Button("Retry") { Task { await composer.retryDictation() } }
                            .buttonStyle(.plain)
                            .font(.caption.weight(.semibold))
                    }
                }
            }
        }
        .padding(14)
        .padding(.top, composer.notchHeight)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.black, in: shape)
        .contextMenu {
            Picker("Position", selection: $composer.placement) {
                ForEach(Placement.allCases, id: \.self) { Text($0.label).tag($0) }
            }
            .pickerStyle(.inline)
            Picker("Main input", selection: $composer.mode) {
                ForEach(InputMode.allCases, id: \.self) { Text($0.label).tag($0) }
            }
            .pickerStyle(.inline)
            Divider()
            Button("Quit Dray Notch") { NSApp.terminate(nil) }
        }
        // A panel opened before the socket was up read nothing; read again once it is.
        .task(id: store.serverState[composer.server] == .connected) {
            if store.serverState[composer.server] == .connected, composer.target == .new { await composer.loadPicks() }
        }
    }

    private var rowList: some View {
        VStack(spacing: 10) {
            ForEach($composer.rows) { $row in
                // The id is read before the removal: read through `row` inside
                // `removeAll`, it reenters `rows` mid-mutation and Swift aborts.
                RowView(row: $row) { [id = row.id] in composer.rows.removeAll { $0.id == id } }
                    .id(row.id)
                    .draggable(row.id.uuidString)
                    .dropDestination(for: String.self) { ids, _ in move(ids.first, before: row.id) }
            }
        }
    }

    private var title: String {
        switch composer.target {
        case .session(let k): store.items[k]?.title ?? "Task"
        case .new, nil: "New task"
        }
    }

    private var shape: UnevenRoundedRectangle {
        let r: CGFloat = 20
        return switch composer.placement {
        case .notch: UnevenRoundedRectangle(bottomLeadingRadius: r, bottomTrailingRadius: r)
        case .bottom: UnevenRoundedRectangle(topLeadingRadius: r, bottomLeadingRadius: r, bottomTrailingRadius: r, topTrailingRadius: r)
        }
    }

    /// Dictation mode: the mic alone in the middle, input and send beneath it.
    /// Text mode: all three in one row.
    @ViewBuilder private var input: some View {
        if composer.mode == .dictate {
            VStack(spacing: 6) {
                MicButton(composer: composer, big: true)
                RecordingTimer(since: composer.recordingSince)
            }
            .frame(maxWidth: .infinity)
        }
        // One row in both modes: moved between rows the field is a new view and loses its focus.
        HStack(alignment: .center, spacing: 8) {
            if composer.mode == .text {
                MicButton(composer: composer, big: false)
                RecordingTimer(since: composer.recordingSince)
            }
            field
            send
        }
    }

    private var field: some View {
        TextField("⏎ send    ⌘⏎ add to list", text: $composer.typing, axis: .vertical)
            .textFieldStyle(.plain)
            .lineLimit(1...6)
            .focused($focus, equals: .input)
            .onSubmit {
                // ⌘⏎ adds the text as a row, in the panel's key monitor.
                if composer.listShown {
                    composer.choose()
                } else {
                    Task { if await composer.send() { composer.hide() } }
                }
            }
    }

    private var send: some View {
        Button {
            Task { if await composer.send() { composer.hide() } }
        } label: {
            Image(systemName: "arrow.up.circle.fill").font(.title2)
        }
        .buttonStyle(.plain)
        .disabled(composer.prompt.isEmpty || composer.sending)
        .help("Send (⏎)")
    }

    private func move(_ id: String?, before target: UUID) -> Bool {
        guard let id, let from = composer.rows.firstIndex(where: { $0.id.uuidString == id }),
              let to = composer.rows.firstIndex(where: { $0.id == target }), from != to else { return false }
        let row = composer.rows.remove(at: from)
        composer.rows.insert(row, at: to)
        return true
    }
}

/// Search over five visible rows, newest first; ↑/↓ and ⌘F are the panel's keys.
private struct SessionList: View {
    let composer: Composer
    var focus: FocusState<Field?>.Binding
    @Environment(Store.self) private var store
    static let rowHeight: CGFloat = 32

    var body: some View {
        @Bindable var composer = composer
        let listed = composer.listed
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
                TextField("Search tasks  ⌘F", text: $composer.search)
                    .textFieldStyle(.plain)
                    .focused(focus, equals: .search)
                    .onSubmit { composer.choose() }
                Text("↑↓ navigate  ⏎ select").font(.caption).foregroundStyle(.tertiary)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            Divider().opacity(0.5)
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(spacing: 2) {
                        ForEach(listed, id: \.key) { s in
                            SessionRow(item: s.item, asking: store.isAsking(s.key), selected: composer.key == s.key)
                                .id(s.key)
                                .onTapGesture {
                                    composer.pick(.session(s.key))
                                    composer.choose()
                                }
                        }
                    }
                    .padding(6)
                }
                .scrollIndicators(.never)
                .frame(height: Self.rowHeight * 5 + 2 * 4 + 12)
                .overlay {
                    if listed.isEmpty { Text("No tasks").foregroundStyle(.secondary) }
                }
                .onChange(of: composer.target) {
                    if let k = composer.key { proxy.scrollTo(k) }
                }
            }
        }
        .background(.black, in: RoundedRectangle(cornerRadius: 16))
    }
}

private struct SessionRow: View {
    let item: SessionItem
    let asking: Bool
    let selected: Bool
    @State private var hover = false

    var body: some View {
        HStack(spacing: 8) {
            Circle()
                .fill(asking ? Color.yellow : item.status == "completed" ? .green : .clear)
                .frame(width: 6, height: 6)
            Text(item.title).lineLimit(1)
            Spacer(minLength: 8)
            Text(item.project).lineLimit(1).foregroundStyle(.secondary)
        }
        .font(.system(size: 13))
        .padding(.horizontal, 8)
        .frame(height: SessionList.rowHeight)
        .background(selected ? .white.opacity(0.12) : hover ? .white.opacity(0.06) : .clear, in: RoundedRectangle(cornerRadius: 8))
        .contentShape(Rectangle())
        .onHover { hover = $0 }
    }
}

/// One said or typed line, editable, since a model mishears.
private struct RowView: View {
    @Binding var row: Row
    let remove: () -> Void

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Image(systemName: row.said ? "waveform" : "text.cursor")
                .foregroundStyle(.secondary)
                .frame(width: 16)
            TextField("", text: $row.text, axis: .vertical)
                .textFieldStyle(.plain)
            Button(action: remove) { Image(systemName: "xmark") }
                .buttonStyle(.plain)
                .foregroundStyle(.secondary)
                .help("Remove")
        }
        .padding(8)
        .background(.white.opacity(0.06), in: RoundedRectangle(cornerRadius: 10))
    }
}

/// The orb is the microphone: a click starts dictating, another stops it.
private struct MicButton: View {
    let composer: Composer
    /// The centre of dictation mode, rather than a control in the row.
    let big: Bool

    var body: some View {
        Button {
            Task { await composer.toggleDictation() }
        } label: {
            VoiceOrb(size: big ? 48 : 22, level: composer.level, state: composer.dictation)
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .disabled(composer.dictation == .transcribing)
        .help(composer.dictation == .recording ? "Stop dictating" : "Dictate")
    }
}
