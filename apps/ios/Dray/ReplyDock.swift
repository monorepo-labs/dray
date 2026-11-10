import SwiftUI

/// The foot of a session: the voice orb, held to reply, and under it the
/// session's model, its stance behind "···", the keyboard and, while a turn
/// runs, Stop. The list's `VoiceDock` with a reply in place of a new task: the
/// words show as the bubble they will send as, and nothing here saves a draft.
struct ReplyDock: View {
    @Environment(Store.self) private var store
    let key: SessionKey
    let openSettings: () -> Void
    @AppStorage(Dictations.serverKey) private var dictationPick = ""
    @State private var models: [Model] = []
    /// Picks for the next reply; nil is the session's own.
    @State private var model: String?
    @State private var effort: String?
    @State private var stance: String?
    @State private var hint: String?
    @State private var confirming = false
    @State private var editing = false
    @State private var sheetTitle = "Reply"
    @State private var sending = false
    /// Why the last send failed; the words stay to send again.
    @State private var failed: String?

    private var item: SessionItem? { store.items[key] }
    private var busy: Bool { item?.busy ?? false }
    private var dictation: Dictation { Dictations.shared.state(key) }
    private var text: String { (store.drafts[key] ?? "").trimmingCharacters(in: .whitespacesAndNewlines) }
    private var phase: DockPhase {
        switch dictation {
        case .starting, .recording: .recording
        case .transcribing: .transcribing
        case .idle: text.isEmpty ? .rest : .ready
        }
    }
    private var open: Bool { phase != .rest }
    private var connected: Bool { store.serverState[key.server] == .connected }
    /// Settings' pick, else any machine that can: the words come back to this draft whoever reads them.
    private var transcriber: UUID? { store.dictationServer(dictationPick) }
    private var harness: String { item?.harness ?? "" }
    private var modelId: String { model ?? item?.model ?? "" }
    private var current: Model? { models.first { $0.id == modelId } }
    private var effortNow: String? { effort ?? item?.effort }
    private var stanceNow: String { stance ?? item?.permissionMode ?? "" }
    private var note: String? { failed.map { "Couldn't send. \(sentence($0))" } ?? Dictations.shared.notes[key] }

    var body: some View {
        VStack(spacing: 14) {
            ConnectionStrip(server: key.server, openSettings: openSettings)
            if phase == .ready { bubble.transition(.opacity) }
            if !open, let line = hint ?? note {
                KeptNote(line: line, draft: key).transition(.opacity)
            }
            DockOrb(draft: key, size: 76, hold: hold, tap: tapped)
            if open {
                actions
                    .padding(.top, 6)
                    .transition(.opacity.combined(with: .move(edge: .bottom)))
            }
            picks
        }
        .padding(.horizontal, 20)
        .padding(.top, 40)
        .padding(.bottom, 30)
        .frame(maxWidth: 760)
        .frame(maxWidth: .infinity)
        .background {
            LinearGradient(stops: [.init(color: Theme.page.opacity(0), location: 0), .init(color: Theme.page, location: 0.3)],
                           startPoint: .top, endPoint: .bottom)
                .ignoresSafeArea()
        }
        .ignoresSafeArea(edges: .bottom)
        .animation(Theme.motion, value: phase)
        .animation(Theme.motion, value: confirming)
        .animation(Theme.motion, value: hint)
        .animation(Theme.motion, value: connected)
        .onChange(of: phase) { confirming = false }
        .task(id: "\(harness)|\(connected)") {
            guard connected, !harness.isEmpty else { return }
            models = (try? await store.call(key.server, "list_models", ["harness": .string(harness)])) ?? models
        }
        .sheet(isPresented: $editing) {
            TextSheet(title: sheetTitle, text: Binding(get: { store.drafts[key] ?? "" }, set: { store.drafts[key] = $0 }),
                      send: { editing = false; send() })
        }
        // Leaving mid-recording sends what was said into this session's draft, the desktop's rule.
        .onDisappear {
            if Dictations.shared.state(key) == .recording { Task { await Dictations.shared.stop(store, draft: key) } }
        }
    }

    /// The reply as it will send: the reader's own bubble, its first lines and a count.
    private var bubble: some View {
        VStack(alignment: .trailing, spacing: 6) {
            Text(text)
                .font(Theme.Font.body)
                .foregroundStyle(Theme.text)
                .lineLimit(3)
                .padding(.vertical, 10)
                .padding(.horizontal, 14)
                .background(Theme.raised, in: UnevenRoundedRectangle(topLeadingRadius: 20, bottomLeadingRadius: 20,
                                                                      bottomTrailingRadius: 6, topTrailingRadius: 20, style: .continuous))
                .frame(maxWidth: 290, alignment: .trailing)
                .onTapGesture { edit() }
                .accessibilityAddTraits(.isButton)
                .accessibilityHint("Opens it to edit")
            let words = text.split(whereSeparator: \.isWhitespace).count
            Text(words == 1 ? "1 word" : "\(words) words")
                .font(Theme.Font.footnote)
                .foregroundStyle(Theme.tertiary)
                .padding(.trailing, 6)
        }
        .frame(maxWidth: .infinity, alignment: .trailing)
    }

    @ViewBuilder private var actions: some View {
        VStack(spacing: Theme.Space.m) {
            if confirming {
                Text(phase == .ready ? "Discard this reply?" : "Discard this recording?")
                    .font(Theme.Font.subhead).foregroundStyle(Theme.secondary)
            } else if let note {
                HStack(spacing: Theme.Space.s) {
                    Text(note).font(Theme.Font.subhead).foregroundStyle(Theme.secondary).multilineTextAlignment(.center)
                    // The recording alone: the reply's words stay.
                    if Dictations.shared.kept[key] != nil {
                        Button("Retry") { Task { await Dictations.shared.retry(store, draft: key) } }
                            .font(Theme.Font.subhead).foregroundStyle(Theme.text)
                        Button("Discard") { Dictations.shared.dismiss(key) }
                            .font(Theme.Font.subhead).foregroundStyle(Theme.destructive)
                    }
                }
            }
            HStack(spacing: Theme.Space.m) {
                if confirming { confirmButtons } else { mainButtons }
            }
        }
    }

    @ViewBuilder private var mainButtons: some View {
        Button("Cancel") { confirming = true }
            .buttonStyle(DockButtonStyle())
        if phase == .recording {
            Button { Task { await Dictations.shared.stop(store, draft: key) } } label: {
                HStack(spacing: Theme.Space.s) {
                    RoundedRectangle(cornerRadius: 3).frame(width: 12, height: 12)
                    Text("Done")
                    StopTimer(since: Dictations.shared.since[key])
                }
            }
            .buttonStyle(DockButtonStyle(kind: .primary))
            .disabled(dictation != .recording)
            .accessibilityLabel("Done")
        } else {
            Button { send() } label: {
                if sending { ProgressView().tint(.black) } else { Label("Send", systemImage: "arrow.up").labelStyle(SendLabel()) }
            }
            .buttonStyle(DockButtonStyle(kind: .primary))
            .disabled(phase != .ready || sending || !connected)
            .accessibilityLabel("Send")
        }
    }

    @ViewBuilder private var confirmButtons: some View {
        Button(phase == .recording ? "Keep recording" : "Keep") { confirming = false }
            .buttonStyle(DockButtonStyle())
        Button("Discard") {
            if phase == .ready {
                store.drafts[key] = nil
                failed = nil
            } else {
                Dictations.shared.cancel(key)
            }
            Haptic.tap()
        }
        .buttonStyle(DockButtonStyle(kind: .destructive))
    }

    /// Model and effort, stance behind "···", the keyboard, and Stop while a turn runs.
    private var picks: some View {
        HStack(spacing: Theme.Space.l) {
            Menu { modelMenu } label: {
                HStack(spacing: 5) {
                    AgentMark(harness: harness).frame(width: 13, height: 13)
                    Text(current?.label ?? item?.model ?? "Model").font(Theme.Font.footnoteStrong).foregroundStyle(Theme.text)
                    if let effortNow, current?.efforts.isEmpty == false {
                        Text(Picks.effortLabels[effortNow] ?? effortNow).font(Theme.Font.footnote).foregroundStyle(Theme.tertiary)
                    }
                }
                .fixedSize()
            }
            .accessibilityLabel("Model")
            if Picks.offersStances(harness) {
                Menu {
                    Picker("Permissions", selection: Binding(get: { Picks.stanceFor(harness, stanceNow) }, set: { stance = $0 })) {
                        ForEach(Picks.stances.filter { Picks.honours(harness, $0.0) }, id: \.0) { Text($0.1).tag($0.0) }
                    }
                    .pickerStyle(.menu)
                    .disabled(Picks.lockedMidTurn(harness, "stance", busy))
                } label: {
                    Image(systemName: "ellipsis").font(.system(size: 15, weight: .bold)).frame(width: 24, height: 20)
                }
                .accessibilityLabel("More picks")
            }
            Button { edit() } label: {
                Image(systemName: "keyboard").font(.system(size: 16)).frame(width: 24, height: 20)
            }
            .accessibilityLabel("Keyboard")
            if busy {
                Button {
                    Haptic.firm()
                    Task { await store.interrupt(key) }
                } label: {
                    RoundedRectangle(cornerRadius: 2).fill(Theme.text).frame(width: 10, height: 10)
                        .frame(width: 28, height: 28)
                        .background(Theme.raised, in: Circle())
                }
                .accessibilityLabel("Stop")
                .transition(.opacity)
            }
        }
        .foregroundStyle(Theme.secondary)
        .lineLimit(1)
        .frame(height: 28)
        .animation(Theme.motion, value: busy)
    }

    /// Locked one control at a time, where the harness can't carry it onto a prompt sent mid-turn.
    @ViewBuilder private var modelMenu: some View {
        Picker("Model", selection: Binding(get: { modelId }, set: { model = $0; effort = nil })) {
            ForEach(models, id: \.id) { Text($0.label).tag($0.id) }
        }
        .disabled(Picks.lockedMidTurn(harness, "model", busy))
        if let current, !current.efforts.isEmpty {
            Picker("Effort", selection: Binding(get: { Picks.usableEffort(current, effortNow) ?? "" }, set: { effort = $0 })) {
                ForEach(current.efforts, id: \.self) { Text(Picks.effortLabels[$0] ?? $0).tag($0) }
            }
            .pickerStyle(.menu)
            .disabled(Picks.lockedMidTurn(harness, "effort", busy))
        }
    }

    private func tapped() {
        guard phase == .rest else { return }
        flash(transcriber != nil ? "Hold to talk" : "This server can't transcribe. Type instead.")
    }

    private func hold() {
        guard phase == .rest || phase == .ready else { return }
        guard let transcriber else { return flash("This server can't transcribe. Type instead.") }
        // A kept recording is the only copy of what was said; it goes by Retry or Discard, never by a new hold.
        guard Dictations.shared.kept[key] == nil else { return }
        Dictations.shared.dismiss(key)
        failed = nil
        Task { await Dictations.shared.start(store, server: transcriber, draft: key) }
    }

    private func flash(_ line: String) {
        hint = line
        Task {
            try? await Task.sleep(for: .seconds(2))
            if hint == line { hint = nil }
        }
    }

    /// The title is read once, or typing into an empty reply retitles the sheet mid-word.
    private func edit() {
        sheetTitle = text.isEmpty ? "Reply" : "Edit message"
        if Dictations.shared.kept[key] == nil { Dictations.shared.notes[key] = nil }
        editing = true
    }

    private func send() {
        let words = text
        guard !words.isEmpty, !sending else { return }
        sending = true
        failed = nil
        Haptic.tap()
        let picks = (model: modelId, effort: current.flatMap { Picks.usableEffort($0, effortNow) } ?? effortNow, stance: stanceNow)
        Task {
            if await store.send(key, words, picks: picks) {
                // Only if untouched meanwhile: words added while the send was out were never sent.
                if store.drafts[key]?.trimmingCharacters(in: .whitespacesAndNewlines) == words { store.drafts[key] = nil }
                model = nil
                effort = nil
                stance = nil
            } else {
                failed = store.lastError ?? "The server didn't answer."
                store.lastError = nil
                Haptic.error()
            }
            sending = false
        }
    }
}

/// "↑ Send": the arrow before the word, 8pt apart, in the word's colour.
private struct SendLabel: LabelStyle {
    func makeBody(configuration: Configuration) -> some View {
        HStack(spacing: 8) {
            configuration.icon.font(.system(size: 16, weight: .bold))
            configuration.title
        }
    }
}
