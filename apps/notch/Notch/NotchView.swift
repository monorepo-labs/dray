import SwiftUI

enum Field { case input, search }

/// Two cards: the composer, hanging from the notch or sitting above the Dock,
/// and the session list on its far side. The transcript is Dray's.
struct NotchView: View {
    @Bindable var composer: Composer
    @Environment(Store.self) private var store
    @FocusState private var focus: Field?
    /// From the press, not from the microphone opening: the start is a round
    /// trip through Dray, and waiting on it read as the panel hesitating.
    private var recording: Bool { composer.listening }
    private var bare: Bool { recording && composer.mode == .expanded }
    @State private var titleHovered = false
    /// A file drag over the card, which says where it lands.
    @State private var dropping = false
    /// Mid-recording, the pointer over the card shows what can be done without stopping.
    @State private var cardHovered = false
    /// The idle orb and the recording one are one orb to the reader, so a start
    /// moves it into place rather than fading a second one in.
    @Namespace private var orbSpace

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
        // Recording draws only the orb and the clock, so the card shrinks to them.
        .frame(width: recording ? nil : Composer.width)
        .fixedSize(horizontal: recording, vertical: true)
        // Grows out of the notch, or up out of the Dock's edge.
        .scaleEffect(composer.shown ? 1 : 0.5, anchor: composer.placement == .notch ? .top : .bottom)
        .opacity(composer.shown ? 1 : 0)
        .animation(composer.shown ? .spring(duration: 0.32, bounce: 0.2) : .easeIn(duration: 0.15), value: composer.shown)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: composer.placement == .notch ? .top : .bottom)
        .padding(.bottom, composer.placement == .bottom ? 12 : 0)
        .animation(.snappy(duration: 0.25), value: recording)
        // Out here, so the card's fill widens with the camera rather than snapping.
        .animation(.spring(duration: 0.3, bounce: 0.2), value: cardHovered)
        // Over the whole window, so a dropdown has the room below the cards too.
        .overlayPreferenceValue(MenuAnchors.self) { anchors in
            DropMenus(composer: composer, anchors: anchors, upward: composer.placement == .bottom)
        }
        .environment(\.colorScheme, .dark)
        .onChange(of: composer.placement) { composer.reposition() }
        .onChange(of: composer.opens) { focus = .input }
        // The input leaves the panel while recording, and its focus with it.
        .onChange(of: composer.dictation) { if !composer.listening { focus = .input } }
        .onChange(of: composer.searches) {
            composer.listShown = true
            focus = .search
        }
        .onChange(of: composer.listShown) { if !composer.listShown { focus = .input } }
        .onChange(of: composer.typing) {
            if !composer.typing.isEmpty { composer.listShown = false }
        }
    }

    @ViewBuilder private var farSide: some View {
        if composer.listShown { SessionList(composer: composer, focus: $focus) }
    }

    private var composerCard: some View {
        VStack(alignment: .leading, spacing: 8) {
            if recording {
                recordingBar
            } else {
                draft
            }
        }
        .padding(12)
        .padding(.top, composer.notchHeight)
        .frame(maxWidth: .infinity, alignment: .leading)
        // Expanded mode records as the orb alone, floating over whatever is beneath;
        // faded rather than removed, so it animates.
        .background {
            shape.fill(.black.opacity(bare ? 0 : 1))
                .padding(.horizontal, composer.placement == .notch ? -NotchShape.ear : 0)
        }
        .shadow(color: .black.opacity(bare ? 0 : 0.35), radius: 12, y: 4)
        .onHover { cardHovered = $0 }
        // A file dropped anywhere on the card rides the draft as a capture does.
        .overlay {
            if dropping {
                RoundedRectangle(cornerRadius: 14).fill(.white.opacity(0.1))
                    .allowsHitTesting(false)
                    .padding(6)
                    .padding(.top, composer.notchHeight)
                    .transition(.scale(scale: 0.9).combined(with: .opacity))
            }
        }
        .scaleEffect(dropping ? 1.04 : 1)
        .animation(.spring(duration: 0.3, bounce: 0.45), value: dropping)
        .dropDestination(for: URL.self) { urls, _ in
            // The server skips a folder, so its row would send nothing.
            let files = urls.filter { $0.isFileURL && (try? $0.resourceValues(forKeys: [.isDirectoryKey]))?.isDirectory == false }
            withAnimation(.spring(duration: 0.4, bounce: 0.5)) {
                composer.rows += files.map { Row(text: "", said: false, file: $0.path) }
            }
            if !files.isEmpty { NSHapticFeedbackManager.defaultPerformer.perform(.levelChange, performanceTime: .now) }
            return !files.isEmpty
        } isTargeted: {
            if $0, !dropping { NSHapticFeedbackManager.defaultPerformer.perform(.alignment, performanceTime: .now) }
            dropping = $0
        }
        .contextMenu {
            Picker("Position", selection: $composer.placement) {
                ForEach(Placement.allCases, id: \.self) { Text($0.label).tag($0) }
            }
            .pickerStyle(.inline)
            Picker("Layout", selection: $composer.mode) {
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

    /// Nothing to read while talking: the orb, which stops it, and the clock.
    /// ⌘Esc throws it away.
    private var recordingBar: some View {
        Group {
            if composer.mode == .expanded {
                VStack(spacing: 6) {
                    MicButton(composer: composer, big: true).matchedGeometryEffect(id: "orb", in: orbSpace)
                    // The card's fill is gone here, so the clock carries its own.
                    HStack(spacing: 8) {
                        RecordingTimer(since: composer.recordingSince)
                        if cardHovered { capture.transition(.scale.combined(with: .opacity)) }
                    }
                    .padding(.horizontal, 8)
                    .padding(.vertical, 3)
                    .background(.black, in: Capsule())
                }
            } else {
                HStack(spacing: 8) {
                    MicButton(composer: composer, big: false).matchedGeometryEffect(id: "orb", in: orbSpace)
                    RecordingTimer(since: composer.recordingSince)
                    if cardHovered { capture.padding(.leading, 4).transition(.scale.combined(with: .opacity)) }
                }
            }
        }
        .padding(.horizontal, 4)
    }

    @ViewBuilder private var draft: some View {
        if !composer.listShown, composer.target != .new {
            HStack(spacing: 12) {
                Button { composer.listShown = true } label: {
                    Text(title).lineLimit(1)
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(.white.opacity(titleHovered ? 1 : 0.7))
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .onHover { titleHovered = $0 }
                .animation(.easeOut(duration: 0.12), value: titleHovered)
                .help("Show tasks")
                HStack(spacing: 10) {
                    Text("⌘N New")
                    Text("↑↓ Tasks")
                    Text("⌥Esc")
                }
                .font(.system(size: 12))
                .foregroundStyle(.white.opacity(0.3))
                .fixedSize()
            }
        }
        if composer.target == .new { NewSessionBar(composer: composer) }
        if !composer.rows.isEmpty {
            // Three rows tall at most, then it scrolls, held at the newest.
            ViewThatFits(in: .vertical) {
                rowList
                ScrollView { rowList }.scrollIndicators(.never).defaultScrollAnchor(.bottom)
                    // Rows above the cap fade out under the card's black.
                    .overlay(alignment: .top) {
                        LinearGradient(colors: [.black, .black.opacity(0)], startPoint: .top, endPoint: .bottom)
                            .frame(height: 28)
                            .allowsHitTesting(false)
                    }
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

    private var rowList: some View {
        VStack(spacing: 10) {
            ForEach(groups, id: \.first) { ids in
                if ids.count == 1, let file = composer.rows.first(where: { $0.id == ids[0] })?.file {
                    FileRow(path: file, label: composer.label(file)) { remove(ids[0]) }
                        .id(ids[0])
                        .reorderable(ids[0], move)
                        .transition(.scale(scale: 0.8).combined(with: .opacity))
                } else if composer.rows.first(where: { $0.id == ids[0] })?.file != nil {
                    ScrollView(.horizontal) {
                        HStack(spacing: 8) {
                            ForEach(ids, id: \.self) { id in
                                if let file = composer.rows.first(where: { $0.id == id })?.file {
                                    FileTile(path: file, label: composer.label(file)) { remove(id) }
                                        .reorderable(id, move)
                                        .transition(.scale(scale: 0.6).combined(with: .opacity))
                                }
                            }
                        }
                    }
                    .scrollIndicators(.never)
                    .padding(8)
                    .background(.white.opacity(0.06), in: RoundedRectangle(cornerRadius: 10))
                } else if let i = composer.rows.firstIndex(where: { $0.id == ids[0] }) {
                    RowView(row: $composer.rows[i]) { remove(ids[0]) }
                        .id(ids[0])
                        .reorderable(ids[0], move)
                }
            }
        }
    }

    /// Rows in order, files back to back sharing one line, each text row alone.
    private var groups: [[UUID]] {
        var out: [[UUID]] = []
        var lastWasFile = false
        for row in composer.rows {
            if row.file != nil, lastWasFile { out[out.count - 1].append(row.id) } else { out.append([row.id]) }
            lastWasFile = row.file != nil
        }
        return out
    }

    /// The id is taken by value: read through a binding inside `removeAll`, it
    /// reenters `rows` mid-mutation and Swift aborts.
    private func remove(_ id: UUID) { composer.rows.removeAll { $0.id == id } }

    private var title: String {
        switch composer.target {
        case .session(let k): store.items[k]?.title ?? "Task"
        case .new, nil: "New task"
        }
    }

    private var shape: AnyShape {
        switch composer.placement {
        case .notch: AnyShape(NotchShape())
        case .bottom: AnyShape(RoundedRectangle(cornerRadius: 20))
        }
    }

    /// Expanded: the orb alone in the middle, input and send beneath it.
    /// Compact: all three in one row.
    @ViewBuilder private var input: some View {
        if composer.mode == .expanded {
            MicButton(composer: composer, big: true).matchedGeometryEffect(id: "orb", in: orbSpace).frame(maxWidth: .infinity)
        }
        HStack(alignment: .center, spacing: 8) {
            if composer.mode == .compact { MicButton(composer: composer, big: false).matchedGeometryEffect(id: "orb", in: orbSpace) }
            field
            capture
            send
        }
    }

    private var field: some View {
        TextField("", text: $composer.typing, prompt: Text("\(ModifierTap.symbol) to speak, ⌘⏎ Queue, ⏎ Send").foregroundStyle(.white.opacity(0.3)), axis: .vertical)
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

    private var capture: some View {
        Button {
            // The overlay comes up under the pointer, so the card never hears it leave.
            cardHovered = false
            composer.capture()
        } label: {
            Image(systemName: "camera.viewfinder").font(.title3).foregroundStyle(.white.opacity(0.6))
        }
        .buttonStyle(.plain)
        .help("Screenshot a region and mark it up")
    }

    private var send: some View {
        Button {
            Task { if await composer.send() { composer.hide() } }
        } label: {
            Image(systemName: "arrow.up.circle.fill").font(.title2)
        }
        .buttonStyle(.plain)
        .disabled(!composer.canSend || composer.sending)
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
/// The notch grown downward: its top corners flare out into the menu bar the
/// way the hardware notch meets the screen edge, its bottom ones round off.
/// Drawn `ear` wider on each side than the content it backs.
private struct NotchShape: Shape {
    static let ear: CGFloat = 12
    var radius: CGFloat = 20

    func path(in rect: CGRect) -> Path {
        let e = Self.ear, r = radius
        var p = Path()
        p.move(to: CGPoint(x: rect.minX, y: rect.minY))
        p.addQuadCurve(to: CGPoint(x: rect.minX + e, y: rect.minY + e), control: CGPoint(x: rect.minX + e, y: rect.minY))
        p.addLine(to: CGPoint(x: rect.minX + e, y: rect.maxY - r))
        p.addQuadCurve(to: CGPoint(x: rect.minX + e + r, y: rect.maxY), control: CGPoint(x: rect.minX + e, y: rect.maxY))
        p.addLine(to: CGPoint(x: rect.maxX - e - r, y: rect.maxY))
        p.addQuadCurve(to: CGPoint(x: rect.maxX - e, y: rect.maxY - r), control: CGPoint(x: rect.maxX - e, y: rect.maxY))
        p.addLine(to: CGPoint(x: rect.maxX - e, y: rect.minY + e))
        p.addQuadCurve(to: CGPoint(x: rect.maxX, y: rect.minY), control: CGPoint(x: rect.maxX - e, y: rect.minY))
        p.closeSubpath()
        return p
    }
}

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
                TextField("", text: $composer.search, prompt: Text("Search tasks  ⌘F").foregroundStyle(.white.opacity(0.3)))
                    .textFieldStyle(.plain)
                    .focused(focus, equals: .search)
                    .onSubmit { composer.choose() }
                Text("↑↓ navigate  ⏎ select").font(.caption).foregroundStyle(.white.opacity(0.3))
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
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
                    .padding([.horizontal, .bottom], 6)
                }
                .scrollIndicators(.never)
                .frame(height: Self.rowHeight * 5 + 2 * 4 + 6)
                .overlay {
                    if listed.isEmpty { Text("No tasks").foregroundStyle(.secondary) }
                }
                .onChange(of: composer.target) {
                    if let k = composer.key { proxy.scrollTo(k) }
                }
            }
        }
        .background(.black, in: RoundedRectangle(cornerRadius: 16))
        .shadow(color: .black.opacity(0.35), radius: 12, y: 4)
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

private extension View {
    /// Dragged by id onto another row to land before it.
    func reorderable(_ id: UUID, _ move: @escaping (String?, UUID) -> Bool) -> some View {
        draggable(id.uuidString).dropDestination(for: String.self) { ids, _ in move(ids.first, id) }
    }
}

/// A capture or a dropped file alone between text rows: thumbnail and label.
private struct FileRow: View {
    let path: String
    let label: String
    let remove: () -> Void

    var body: some View {
        HStack(spacing: 8) {
            if let image = NSImage(contentsOfFile: path) {
                Image(nsImage: image).resizable().scaledToFit()
                    .frame(maxHeight: 72, alignment: .leading)
                    .clipShape(RoundedRectangle(cornerRadius: 6))
            } else {
                Image(systemName: "doc").foregroundStyle(.secondary).frame(width: 16)
            }
            Text(label).lineLimit(1).truncationMode(.middle)
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
            Button(action: remove) { Image(systemName: "xmark") }
                .buttonStyle(.plain)
                .foregroundStyle(.secondary)
                .help("Remove")
        }
        .padding(8)
        .background(.white.opacity(0.06), in: RoundedRectangle(cornerRadius: 10))
    }
}

/// Files back to back, sharing one line: the image itself, or a page and its name.
private struct FileTile: View {
    let path: String
    let label: String
    let remove: () -> Void
    @State private var hover = false

    var body: some View {
        Group {
            if let image = NSImage(contentsOfFile: path) {
                Image(nsImage: image).resizable().scaledToFill()
            } else {
                VStack(spacing: 4) {
                    Image(systemName: "doc").font(.title3)
                    Text(label).font(.caption).lineLimit(1).truncationMode(.middle)
                }
                .foregroundStyle(.secondary)
                .padding(.horizontal, 8)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(.white.opacity(0.06))
            }
        }
        .frame(width: 96, height: 64)
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .overlay(alignment: .topTrailing) {
            if hover {
                Button(action: remove) {
                    Image(systemName: "xmark.circle.fill").font(.title3)
                        .symbolRenderingMode(.palette)
                        .foregroundStyle(.white, .black.opacity(0.7))
                }
                .buttonStyle(.plain)
                .padding(4)
                .help("Remove")
            }
        }
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
