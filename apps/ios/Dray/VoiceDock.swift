import SwiftUI

/// Where the dock is: resting under the list, or open over it.
enum DockPhase { case rest, recording, transcribing, ready }

/// The bottom of the list: the voice orb, held to talk, and the picks a new
/// task starts on. Holding it opens the dock over the list — recording, then
/// transcribing, then the words ready to start or to keep adding to by holding
/// again. The keyboard edits the same text in a sheet.
struct VoiceDock: View {
    @Environment(Store.self) private var store
    @Bindable var task: NewTask
    /// A task started: the list opens it.
    let started: (SessionKey) -> Void
    @State private var hint: String?
    @State private var confirming = false
    @State private var editing = false
    @State private var sheetTitle = "New task"
    @State private var attaching = false

    private let draft = SessionKey.newSession
    private var dictation: Dictation { Dictations.shared.state(draft) }
    private var phase: DockPhase {
        switch dictation {
        case .starting, .recording: .recording
        case .transcribing: .transcribing
        case .idle: task.hasText ? .ready : .rest
        }
    }
    private var open: Bool { phase != .rest }
    private var busy: Bool { phase == .recording || phase == .transcribing }
    /// The machine that turns speech into words: only a Mac's server can.
    private var transcriber: UUID? { store.servers.first { store.canDictate($0.id) }?.id }

    var body: some View {
        VStack(spacing: 0) {
            if phase == .ready {
                SpokenText(text: task.text) { edit() }
                    .padding(.horizontal, Theme.Space.xs)
                    .padding(.bottom, Theme.Space.xl)
                    .transition(.opacity)
            } else if open {
                Spacer(minLength: 0)
            }
            if !open, let line = hint ?? note {
                KeptNote(line: line, draft: draft)
                    .frame(minHeight: 22)
                    .padding(.bottom, 14)
                    .transition(.opacity)
            }
            orb
            if open {
                actions
                    .padding(.top, Theme.Space.xl)
                    .transition(.opacity.combined(with: .move(edge: .bottom)))
            }
            picks.padding(.top, open ? 18 : 14)
        }
        .padding(.horizontal, 20)
        .padding(.top, open ? 0 : 44)
        .padding(.bottom, 30)
        .frame(maxWidth: .infinity, maxHeight: open ? .infinity : nil, alignment: .bottom)
        .background { backdrop.ignoresSafeArea() }
        .ignoresSafeArea(edges: .bottom)
        .animation(Theme.motion, value: phase)
        .animation(Theme.motion, value: confirming)
        .animation(Theme.motion, value: hint)
        .task(id: "\(task.server?.uuidString ?? "")|\(task.harness)") { await task.load() }
        .sheet(isPresented: $editing) {
            TextSheet(title: sheetTitle, text: $task.text)
        }
        .sheet(isPresented: $attaching) {
            if let server = task.server {
                NavigationStack {
                    AttachProjectView(server: server, projects: store.projects[server] ?? []) { list in
                        store.attached(server, list)
                        task.projectName = list.max { $0.lastSelected < $1.lastSelected }?.name
                    }
                }
            }
        }
        // A new phase asks its own question; one left up would answer the wrong one.
        .onChange(of: phase) { confirming = false }
    }

    /// The page showing through at rest, and nearly closed over the list once open.
    @ViewBuilder private var backdrop: some View {
        switch phase {
        case .rest:
            LinearGradient(stops: [.init(color: Theme.page.opacity(0), location: 0), .init(color: Theme.page, location: 0.26)],
                           startPoint: .top, endPoint: .bottom)
        case .ready:
            LinearGradient(colors: [Theme.page.opacity(0.97), Theme.page], startPoint: .top, endPoint: .bottom)
        default:
            LinearGradient(stops: [.init(color: Theme.page.opacity(0.6), location: 0), .init(color: Theme.page.opacity(0.88), location: 0.45),
                                   .init(color: Theme.page, location: 0.7)], startPoint: .top, endPoint: .bottom)
        }
    }

    /// What dictation or the last start said instead of words.
    private var note: String? { Dictations.shared.notes[draft] ?? task.failure }

    private var orb: some View {
        let size: CGFloat = open ? 120 : 76
        return TimelineView(.animation(minimumInterval: 1 / 20, paused: dictation != .recording)) { _ in
            VoiceOrb(size: size, level: dictation == .recording ? Dictations.shared.level(draft) : 0, state: dictation)
        }
        .frame(width: size, height: size)
        .clipShape(Circle())
        .overlay(Circle().stroke(Color.white.opacity(0.08), lineWidth: 1).padding(-0.5))
        .shadow(color: .black.opacity(0.6), radius: open ? 20 : 15, y: open ? 16 : 10)
        .contentShape(Circle())
        .gesture(LongPressGesture(minimumDuration: 0.25).onEnded { _ in hold() }
            .exclusively(before: TapGesture().onEnded { tapped() }))
        .accessibilityElement()
        .accessibilityLabel("Voice")
        .accessibilityHint("Hold to talk")
        .accessibilityAddTraits(.isButton)
        .accessibilityAction(named: "Talk") { hold() }
        .accessibilityIdentifier("orb")
    }

    /// A tap is not a hold: say how, once, then let it go.
    private func tapped() {
        guard phase == .rest else { return }
        flash(transcriber == nil ? "This server can't transcribe. Type instead." : "Hold to talk")
    }

    private func hold() {
        guard !busy else { return }
        guard let transcriber else { return flash("This server can't transcribe. Type instead.") }
        // A kept recording is the only copy of what was said; it goes by Retry or Discard, never by a new hold.
        guard Dictations.shared.kept[draft] == nil else { return }
        Dictations.shared.dismiss(draft)
        task.failure = nil
        Task { await Dictations.shared.start(store, server: transcriber, draft: draft) }
    }

    /// The title is read once, or typing into an empty task retitles the sheet mid-word.
    /// Typing answers whatever the last dictation said, unless its recording waits on Retry.
    private func edit() {
        sheetTitle = task.hasText ? "Edit task" : "New task"
        if Dictations.shared.kept[draft] == nil { Dictations.shared.notes[draft] = nil }
        task.failure = nil
        editing = true
    }

    private func flash(_ line: String) {
        hint = line
        Task {
            try? await Task.sleep(for: .seconds(2))
            if hint == line { hint = nil }
        }
    }

    @ViewBuilder private var actions: some View {
        VStack(spacing: Theme.Space.m) {
            if confirming {
                Text(phase == .ready ? "Discard this task?" : "Discard this recording?")
                    .font(Theme.Font.subhead).foregroundStyle(Theme.secondary)
            } else if let note {
                HStack(spacing: Theme.Space.s) {
                    Text(note).font(Theme.Font.subhead).foregroundStyle(Theme.secondary)
                        .multilineTextAlignment(.center)
                    if Dictations.shared.kept[draft] != nil {
                        Button("Retry") { Task { await Dictations.shared.retry(store, draft: draft) } }
                            .font(Theme.Font.subhead).foregroundStyle(Theme.text)
                    }
                }
            }
            HStack(spacing: Theme.Space.m) {
                if confirming { confirmButtons } else { mainButtons }
            }
        }
    }

    @ViewBuilder private var mainButtons: some View {
        Button("Cancel") {
            // Nothing said and nothing written: there is nothing to lose.
            if phase == .ready && !task.hasText { return task.discard() }
            confirming = true
        }
        .buttonStyle(DockButtonStyle())
        switch phase {
        case .recording:
            Button { Task { await Dictations.shared.stop(store, draft: draft) } } label: {
                HStack(spacing: Theme.Space.s) {
                    RoundedRectangle(cornerRadius: 3).frame(width: 12, height: 12)
                    Text("Done")
                    StopTimer(since: Dictations.shared.since[draft])
                }
            }
            .buttonStyle(DockButtonStyle(kind: .primary))
            .disabled(dictation != .recording)
            .accessibilityLabel("Done")
        default:
            Button {
                Task { if let key = await task.start() { started(key) } }
            } label: {
                if task.sending { ProgressView().tint(.black) } else { Text("Start task") }
            }
            .buttonStyle(DockButtonStyle(kind: .primary))
            .disabled(phase != .ready || !task.ready)
        }
    }

    @ViewBuilder private var confirmButtons: some View {
        if phase == .ready {
            Button("Save draft") {
                Task { if await task.saveDraft() { confirming = false } }
            }
            .buttonStyle(DockButtonStyle())
            .disabled(task.sending)
            Button("Keep") { confirming = false }.buttonStyle(DockButtonStyle())
            Button("Discard") {
                task.discard()
                Haptic.tap()
            }
            .buttonStyle(DockButtonStyle(kind: .destructive))
        } else {
            Button(phase == .recording ? "Keep recording" : "Keep") { confirming = false }
                .buttonStyle(DockButtonStyle())
            Button("Discard") {
                Dictations.shared.cancel(draft)
                Haptic.tap()
            }
            .buttonStyle(DockButtonStyle(kind: .destructive))
        }
    }

    /// Model and effort, project, machine, the rest behind "···", and the keyboard.
    private var picks: some View {
        HStack(spacing: Theme.Space.l) {
            Menu { modelMenu } label: {
                HStack(spacing: 5) {
                    AgentMark(harness: task.harness).frame(width: 13, height: 13)
                    Text(task.model?.label ?? "Default").font(Theme.Font.footnoteStrong).foregroundStyle(Theme.text)
                    if let effort = task.effort {
                        Text(Picks.effortLabels[effort] ?? effort).font(Theme.Font.footnote).foregroundStyle(Theme.tertiary)
                    }
                }
                // The model keeps its name whole; a long project or machine name gives way first.
                .fixedSize()
            }
            .accessibilityLabel("Model")
            Menu { projectMenu } label: {
                HStack(spacing: 5) {
                    Image(systemName: "folder.fill").font(.system(size: 11))
                    Text(task.project ?? "Project").font(Theme.Font.footnote)
                }
            }
            .accessibilityLabel("Project")
            Menu { machineMenu } label: {
                HStack(spacing: 5) {
                    ServerIcon().frame(width: 13, height: 13)
                    Text(task.server.map(store.name(of:)) ?? "Machine").font(Theme.Font.footnote)
                }
            }
            .accessibilityLabel("Machine")
            Menu { moreMenu } label: {
                Image(systemName: "ellipsis").font(.system(size: 15, weight: .bold)).frame(width: 24, height: 20)
            }
            .accessibilityLabel("More picks")
            Button { edit() } label: {
                Image(systemName: "keyboard").font(.system(size: 16)).frame(width: 24, height: 20)
            }
            .disabled(busy)
            .opacity(busy ? 0.3 : 1)
            .accessibilityLabel("Keyboard")
        }
        .foregroundStyle(Theme.secondary)
        .lineLimit(1)
        .frame(height: 20)
    }

    @ViewBuilder private var modelMenu: some View {
        let agents = task.available.filter(\.available)
        if agents.count > 1 {
            Picker("Agent", selection: $task.harness) {
                ForEach(agents, id: \.harness) { Text($0.label).tag($0.harness) }
            }
            .pickerStyle(.menu)
        }
        Picker("Model", selection: Binding(get: { task.modelId }, set: task.pickModel)) {
            if Picks.defaultModel[task.harness]?.isEmpty ?? false { Text("Default").tag("") }
            ForEach(task.list, id: \.id) { Text($0.label).tag($0.id) }
        }
        if let model = task.model, !model.efforts.isEmpty {
            Picker("Effort", selection: Binding(get: { task.effort ?? "" }, set: task.pickEffort)) {
                ForEach(model.efforts, id: \.self) { Text(Picks.effortLabels[$0] ?? $0).tag($0) }
            }
            .pickerStyle(.menu)
        }
        if Picks.offersFast(task.harness, task.model) {
            Toggle("Fast mode", isOn: $task.fast)
        }
    }

    @ViewBuilder private var projectMenu: some View {
        Picker("Project", selection: Binding(get: { task.projectChoice }, set: task.pick)) {
            ForEach(task.projectChoices, id: \.self) { Text($0.label).tag(Optional($0)) }
        }
        if task.server != nil {
            Button("Attach project…", systemImage: "plus") { attaching = true }
        }
    }

    @ViewBuilder private var machineMenu: some View {
        Picker("Machine", selection: Binding(get: { task.server }, set: { task.pickedServer = $0 })) {
            ForEach(task.machines) { Text($0.name).tag(Optional($0.id)) }
        }
    }

    @ViewBuilder private var moreMenu: some View {
        Toggle("Worktree", isOn: $task.worktree)
        if Picks.offersStances(task.harness) {
            Picker("Permissions", selection: Binding(get: { Picks.stanceFor(task.harness, task.stance) }, set: { task.stance = $0 })) {
                ForEach(Picks.stances.filter { Picks.honours(task.harness, $0.0) }, id: \.0) { Text($0.1).tag($0.0) }
            }
            .pickerStyle(.menu)
        }
    }
}

/// The words so far, large and dim at the top of the open dock: bottom-aligned
/// so the newest is in view, faded at both ends, and a tap away from editing.
struct SpokenText: View {
    let text: String
    let edit: () -> Void

    var body: some View {
        ScrollView {
            Text(text)
                .font(Theme.Font.spoken)
                .tracking(-0.3)
                .foregroundStyle(Theme.text.opacity(0.7))
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.top, 140)
                .padding(.bottom, Theme.Space.xl)
                .contentShape(.rect)
                .onTapGesture(perform: edit)
        }
        .defaultScrollAnchor(.bottom)
        .scrollIndicators(.hidden)
        .mask {
            VStack(spacing: 0) {
                LinearGradient(colors: [.clear, .black], startPoint: .top, endPoint: .bottom).frame(height: 180)
                Color.black
                LinearGradient(colors: [.black, .clear], startPoint: .top, endPoint: .bottom).frame(height: 40)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityHint("Opens it to edit")
        .accessibilityAddTraits(.isButton)
        .accessibilityAction { edit() }
    }
}

/// What dictation said instead of words, under the resting orb; Retry and
/// Discard beside it while the server never answered and the audio is kept.
struct KeptNote: View {
    @Environment(Store.self) private var store
    let line: String
    let draft: SessionKey

    var body: some View {
        HStack(spacing: Theme.Space.m) {
            Text(line).foregroundStyle(Theme.tertiary).multilineTextAlignment(.center)
            if Dictations.shared.kept[draft] != nil {
                Button("Retry") { Task { await Dictations.shared.retry(store, draft: draft) } }
                    .foregroundStyle(Theme.text)
                Button("Discard") { Dictations.shared.dismiss(draft) }
                    .foregroundStyle(Theme.destructive)
            }
        }
        .font(Theme.Font.footnote)
    }
}

/// The text of a task or a reply in a near-full sheet: grabber, title, Done.
/// Only the words change here; the picks and the send stay on the dock.
struct TextSheet: View {
    let title: String
    @Binding var text: String
    @Environment(\.dismiss) private var dismiss
    @FocusState private var focused: Bool

    var body: some View {
        VStack(spacing: 0) {
            ZStack {
                Text(title).font(Theme.Font.headline).foregroundStyle(Theme.text)
                HStack {
                    Spacer()
                    Button("Done") { dismiss() }
                        .font(Theme.Font.headline)
                        .foregroundStyle(Theme.text)
                }
            }
            .frame(height: 52)
            TextEditor(text: $text)
                .font(Theme.Font.body)
                .foregroundStyle(Theme.text)
                .tint(Theme.accent)
                .scrollContentBackground(.hidden)
                .focused($focused)
                .padding(.horizontal, -5)
                .padding(.top, Theme.Space.xs)
                .accessibilityLabel(title)
        }
        .padding(.horizontal, 20)
        .padding(.top, 14)
        .presentationDetents([.large])
        .presentationDragIndicator(.visible)
        .presentationBackground(Theme.card)
        .onAppear { focused = true }
    }
}

/// The dock's 52pt pill buttons: raised by default, white for the one the
/// screen is for, a red tint for discarding.
struct DockButtonStyle: ButtonStyle {
    enum Kind { case plain, primary, destructive }
    var kind = Kind.plain
    @Environment(\.isEnabled) private var enabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(Theme.Font.headline)
            .foregroundStyle(kind == .primary ? Color.black : kind == .destructive ? Theme.destructive : Theme.text)
            .frame(maxWidth: .infinity, minHeight: 52)
            .background(fill, in: Capsule())
            .opacity(enabled ? 1 : 0.3)
            .pressed(configuration.isPressed)
    }

    private var fill: Color {
        switch kind {
        case .plain: Theme.raised
        case .primary: .white
        case .destructive: Theme.destructive.opacity(0.16)
        }
    }
}

/// The elapsed time inside Done, dim against its label.
private struct StopTimer: View {
    let since: Date?

    var body: some View {
        TimelineView(.periodic(from: since ?? .now, by: 1)) { context in
            let s = since.map { max(0, Int(context.date.timeIntervalSince($0))) } ?? 0
            Text(String(format: "%d:%02d", s / 60, s % 60))
                .monospacedDigit()
                .foregroundStyle(Color.black.opacity(0.45))
        }
    }
}

/// The agent's mark in the picks: Claude's rust starburst, else a neutral sparkle.
struct AgentMark: View {
    let harness: String

    var body: some View {
        if harness == "claude_code" {
            Canvas { ctx, size in
                ctx.scaleBy(x: size.width / 24, y: size.height / 24)
                let points: [(Double, Double)] = [(12, 1.5), (13.6, 8.8), (19.8, 4.6), (15.6, 10.8), (22.9, 12.4), (15.6, 14),
                                                  (19.8, 20.2), (13.6, 16), (12, 22.5), (10.4, 15.2), (4.2, 19.4), (8.4, 13.2),
                                                  (1.1, 12), (8.4, 10.4), (4.2, 4.2), (10.4, 8.4)]
                var p = Path()
                p.addLines(points.map { CGPoint(x: $0.0, y: $0.1) })
                p.closeSubpath()
                ctx.fill(p, with: .color(Theme.claude))
            }
        } else {
            Image(systemName: "sparkle").resizable().scaledToFit().foregroundStyle(Theme.secondary)
        }
    }
}

/// The desktop's `ServerFilledIcon`: two filled racks with their lights cut out.
struct ServerIcon: View {
    var body: some View {
        Canvas { ctx, size in
            ctx.scaleBy(x: size.width / 24, y: size.height / 24)
            var racks = Path()
            racks.addRoundedRect(in: CGRect(x: 1, y: 2, width: 22, height: 8.5), cornerSize: CGSize(width: 2.5, height: 2.5))
            racks.addRoundedRect(in: CGRect(x: 1, y: 12.5, width: 22, height: 8.5), cornerSize: CGSize(width: 2.5, height: 2.5))
            ctx.fill(racks, with: .foreground)
            ctx.blendMode = .destinationOut
            ctx.fill(Path(ellipseIn: CGRect(x: 4.5, y: 4.75, width: 3, height: 3)), with: .color(.black))
            ctx.fill(Path(ellipseIn: CGRect(x: 4.5, y: 15.25, width: 3, height: 3)), with: .color(.black))
        }
    }
}
