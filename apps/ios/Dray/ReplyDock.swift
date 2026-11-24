import SwiftUI
import UIKit

/// The foot of a session: the voice orb, held to reply, and under it the
/// session's model, its stance behind "···", the keyboard and, while a turn
/// runs, Stop. The list's `VoiceDock` with a reply in place of a new task: the
/// words show as the bubble they will send as, and nothing here saves a draft.
struct ReplyDock: View {
    @Environment(Store.self) private var store
    @Environment(\.openSession) private var openSession
    let key: SessionKey
    @AppStorage(Dictations.serverKey) private var dictationPick = ""
    @AppStorage(SwipeHint.key) private var swiped = 0
    @State private var models: [Model] = []
    /// The machine's agents, read when This task opens.
    @State private var agents: [AgentAvailability] = []
    @State private var keyboard = false
    /// The home indicator's inset, which the dock sits on rather than ignores.
    @State private var homeInset: CGFloat = 0
    /// Picks for the next reply; nil is the session's own.
    @State private var model: String?
    @State private var effort: String?
    @State private var stance: String?
    @State private var fast: Bool?
    @State private var picking = false
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
    /// Nothing can transcribe: a text field stands where the orb would. Never mid-recording,
    /// or losing the one server that could would take Done away with the mic still on.
    private var typing: Bool { store.typesOnly && dictation == .idle }
    private var phase: DockPhase {
        if typing { return .rest }
        switch dictation {
        case .starting, .recording: return .recording
        case .transcribing: return .transcribing
        case .idle: return text.isEmpty ? .rest : .ready
        }
    }
    private var open: Bool { phase != .rest }
    private var connected: Bool { store.serverState[key.server] == .connected }
    /// Down long enough that its session says so; a quick reconnect dims nothing.
    private var away: Bool { store.lost.contains(key.server) }
    /// Settings' pick, else anything that can: the words come back to this draft whoever reads them.
    private var transcriber: DictationEngine? { store.dictationEngine(dictationPick) }
    /// An agent and model picked here or in the bot sheet, waiting for this reply.
    private var pick: AgentPick? { store.unsent[key] }
    /// The reply moves the session to another agent (#1414).
    private var moving: Bool { pick.map { $0.harness != item?.harness } ?? false }
    private var harness: String { pick?.harness ?? item?.harness ?? "" }
    private var modelId: String { model ?? pick?.model ?? item?.model ?? "" }
    private var current: Model? { models.first { $0.id == modelId } }
    private var effortNow: String? { effort ?? (moving ? nil : item?.effort) }
    private var stanceNow: String { stance ?? item?.permissionMode ?? "" }
    private var fastNow: Bool { fast ?? item?.fast ?? false }
    private var note: String? { failed.map { "Couldn't send. \(sentence($0))" } ?? Dictations.shared.notes[key] }

    var body: some View {
        VStack(spacing: 14) {
            if phase == .ready { bubble.transition(.opacity) }
            if moving, !open {
                HStack(spacing: 6) {
                    AgentMark(harness: harness).frame(width: 13, height: 13)
                    Text("Your next message goes to \(Picks.agentLabels[harness] ?? harness)")
                        .font(Theme.Font.footnoteMedium).foregroundStyle(Theme.text).lineLimit(1)
                }
            }
            if !open, let line = hint ?? note {
                KeptNote(line: line, draft: key).transition(.opacity)
            } else if !open, !typing, swiped < SwipeHint.learned {
                Text(SwipeHint.line).font(Theme.Font.footnote).foregroundStyle(Theme.tertiary).transition(.opacity)
            }
            VStack(spacing: 14) {
                // Dim while the server or the network is away; the banner up top says why, and typing still works.
                if typing {
                    ChatInput(placeholder: "Message", text: Binding(get: { store.drafts[key] ?? "" }, set: { store.drafts[key] = $0 }),
                              sending: sending, sendable: !text.isEmpty && !sending && connected, send: send)
                } else {
                    // New task's size while it listens; back to rest size once the bubble takes the room.
                    DockOrb(draft: key, size: phase == .recording || phase == .transcribing ? 120 : 76, tap: tapped)
                        .opacity(away ? 0.4 : 1)
                }
                if open {
                    actions
                        .padding(.top, 6)
                        .transition(.opacity.combined(with: .move(edge: .bottom)))
                }
                picks.opacity(away ? 0.4 : 1).typingAligned(typing)
            }
            .padding(.bottom, typing && keyboard ? 30 : max(0, 30 - homeInset))
            .swipeUpToType(phase == .rest && !typing, edit)
        }
        .padding(.horizontal, 20)
        .padding(.top, Theme.Space.m)
        .frame(maxWidth: 760)
        .frame(maxWidth: .infinity)
        // Everything in the dock's frame is inset the chat stops at, so the fade reaches up past it
        // rather than padding it, and the dock sits on the home indicator's inset rather than
        // ignoring it, which `safeAreaInset` counts under the dock either way: 80pt of gap between them.
        .background {
            LinearGradient(stops: [.init(color: Theme.page.opacity(0), location: 0), .init(color: Theme.page, location: 0.3)],
                           startPoint: .top, endPoint: .bottom)
                .padding(.top, -28)
                .ignoresSafeArea()
                .onGeometryChange(for: CGFloat.self, of: { $0.safeAreaInsets.bottom }) { if !keyboard { homeInset = $0 } }
        }
        // The keyboard lifts the field, never the orb.
        .ignoresSafeArea(typing ? [] : .keyboard, edges: .bottom)
        .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillShowNotification)) { _ in keyboard = true }
        .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillHideNotification)) { _ in keyboard = false }
        .animation(Theme.motion, value: phase)
        .animation(Theme.motion, value: confirming)
        .animation(Theme.motion, value: hint)
        .animation(Theme.motion, value: connected)
        .onChange(of: phase) { confirming = false }
        // The bot sheet's pick is the newer word on model and effort; the dock's own would override it.
        .onChange(of: pick) {
            model = nil
            effort = nil
        }
        // A switch made elsewhere: the old agent's picks would go to the new one, which may not run them.
        .onChange(of: item?.harness) {
            model = nil
            effort = nil
            stance = nil
            fast = nil
        }
        // Never the old agent's models under the new one's name while its list is read.
        .onChange(of: harness) { models = [] }
        .task(id: "\(harness)|\(connected)") {
            guard connected, !harness.isEmpty else { return }
            let read: [Model]? = try? await store.call(key.server, "list_models", ["harness": .string(harness)])
            guard let read, !Task.isCancelled else { return }
            models = read
            // An agent picked onto a model its list lacks takes its default, never the old agent's model.
            if let pick, moving {
                let usable = Picks.usableModel(read, pick.model, pick.harness)
                if usable != pick.model { store.unsent[key] = AgentPick(harness: pick.harness, model: usable) }
            }
        }
        .sheet(isPresented: $editing) {
            TextSheet(title: sheetTitle, text: Binding(get: { store.drafts[key] ?? "" }, set: { store.drafts[key] = $0 }),
                      send: { editing = false; send() }, sendable: dictation == .idle)
        }
        .sheet(isPresented: $picking) { thisTask }
        // Leaving mid-recording sends what was said into this session's draft, the desktop's rule.
        .onDisappear {
            if Dictations.shared.state(key) == .recording { Task { await Dictations.shared.stop(store, draft: key) } }
        }
    }

    /// The reply as it will send: the reader's own bubble, its last lines, so each recording
    /// shows what it added. Tapped, the sheet holds the whole text.
    private var bubble: some View {
        VStack(alignment: .trailing, spacing: 6) {
            Text(spokenTail(text))
                .font(Theme.Font.body)
                .foregroundStyle(Theme.onSent)
                .lineLimit(3)
                .padding(.vertical, 10)
                .padding(.horizontal, 14)
                .background(Theme.sent, in: UnevenRoundedRectangle(topLeadingRadius: 20, bottomLeadingRadius: 20,
                                                                      bottomTrailingRadius: 6, topTrailingRadius: 20, style: .continuous))
                .frame(maxWidth: 290, alignment: .trailing)
                .onTapGesture { edit() }
                .accessibilityLabel(text)
                .accessibilityAddTraits(.isButton)
                .accessibilityHint("Opens it to edit")
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

    /// Model and effort, and "···", both opening This task; the keyboard, and Stop while a turn runs.
    private var picks: some View {
        HStack(spacing: Theme.Space.l) {
            Button { picking = true } label: {
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
            .accessibilityValue(current?.label ?? item?.model ?? "")
            Button { picking = true } label: {
                Image(systemName: "ellipsis").font(.system(size: 15, weight: .bold)).frame(width: 24, height: 20)
            }
            .accessibilityLabel("More picks")
            if !typing {
                Button { edit() } label: {
                    Image(systemName: "keyboard").font(.system(size: 16)).frame(width: 24, height: 20)
                }
                .accessibilityLabel("Keyboard")
            }
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

    /// The session's picks for the next reply, each locked mid-turn where the harness can't carry it
    /// onto a queued prompt (`liveControls.ts`).
    private var thisTask: some View {
        let locked = { (control: String) in Picks.lockedMidTurn(harness, control, busy) }
        let efforts = current?.efforts ?? []
        let offersFast = Picks.offersFast(harness, current)
        let offersStance = Picks.offersStances(harness)
        let effortLabel = current.flatMap { Picks.usableEffort($0, effortNow) }.map { Picks.effortLabels[$0] ?? $0 } ?? ""
        let stanceLabel = Picks.stances.first { $0.0 == Picks.stanceFor(harness, stanceNow) }?.1 ?? ""
        let choices = agentChoices
        return PickSheet(title: "This task") {
            // Another agent takes the session over at the next send, with the conversation.
            if choices.count > 1 {
                PickSection("Agent") {
                    ChipRow(focus: harness) {
                        ForEach(choices, id: \.harness) { a in
                            // Mid-turn the session's own agent stays open, so a pick made before the turn can be undone.
                            let held = locked("agent") && a.harness != item?.harness
                            PickChip(label: a.label, selected: a.harness == harness, harness: a.harness) { pickAgent(a.harness) }
                                .allowsHitTesting(!held)
                                .opacity(held ? 0.35 : 1)
                                .id(a.harness)
                        }
                    }
                }
            }
            PickSection("Model") {
                ModelChips(models: models, harness: harness, selected: modelId) { model = $0; effort = nil }
                    .allowsHitTesting(!locked("model"))
                    .opacity(locked("model") ? 0.35 : 1)
            }
            if !efforts.isEmpty || offersFast || offersStance {
                PickSection(nil, footer: lockNote) {
                    PickCard {
                        if let current, !efforts.isEmpty {
                            if locked("effort") {
                                PickRow("Effort") { MenuValue(effortLabel, locked: true) }
                            } else {
                                PickMenu("Effort", value: effortLabel) {
                                    Picker("Effort", selection: Binding(get: { Picks.usableEffort(current, effortNow) ?? "" }, set: { effort = $0 })) {
                                        ForEach(efforts, id: \.self) { Text(Picks.effortLabels[$0] ?? $0).tag($0) }
                                    }
                                }
                            }
                        }
                        if offersFast {
                            if !efforts.isEmpty { PickDivider() }
                            PickRow("Fast mode") {
                                PickSwitch(label: "Fast mode", isOn: Binding(get: { fastNow }, set: { fast = $0 }))
                                    .disabled(locked("fast"))
                            }
                        }
                        if offersStance {
                            if !efforts.isEmpty || offersFast { PickDivider() }
                            if locked("stance") {
                                PickRow("Permissions") { MenuValue(stanceLabel, locked: true) }
                            } else {
                                PickMenu("Permissions", value: stanceLabel) {
                                    Picker("Permissions", selection: Binding(get: { Picks.stanceFor(harness, stanceNow) }, set: { stance = $0 })) {
                                        ForEach(Picks.stances.filter { Picks.honours(harness, $0.0) }, id: \.0) { Text($0.1).tag($0.0) }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
        .task {
            if let read: [AgentAvailability] = try? await store.call(key.server, "agent_availability") { agents = read }
        }
        .presentationDetents([.height(444), .large])
        .presentationDragIndicator(.visible)
        .presentationCornerRadius(38)
        .presentationBackground(Theme.card)
    }

    /// What waits for the turn to end, said once under the card. Picks go out with the next reply,
    /// so "the rest" are the ones that reply carries into the running turn.
    private var lockNote: String? {
        let shown: [(String, String)] = (agentChoices.count > 1 ? [("agent", "agent")] : []) + [("model", "model")]
            + ((current?.efforts.isEmpty ?? true) ? [] : [("effort", "effort")])
            + (Picks.offersFast(harness, current) ? [("fast", "fast mode")] : [])
            + (Picks.offersStances(harness) ? [("stance", "permissions")] : [])
        let held = shown.filter { Picks.lockedMidTurn(harness, $0.0, busy) }.map(\.1)
        guard !held.isEmpty else { return nil }
        if held.count == shown.count { return "These can change once this turn ends." }
        let names = ListFormatter.localizedString(byJoining: held)
        return names.prefix(1).uppercased() + names.dropFirst() + " can change once this turn ends. The rest go with your next message."
    }

    /// The agents up on the machine, and always the session's own, so a pick can be taken back.
    private var agentChoices: [(harness: String, label: String)] {
        var list = agents.filter(\.available).map { (harness: $0.harness, label: $0.label) }
        if let own = item?.harness, !list.contains(where: { $0.harness == own }) {
            list.insert((harness: own, label: Picks.agentLabels[own] ?? own), at: 0)
        }
        return list
    }

    /// Another agent's pick waits for the next send; the session's own takes the pick back.
    /// Its model is the one last started a task on here, until its list says otherwise.
    private func pickAgent(_ agent: String) {
        guard let item, agent != harness else { return }
        store.unsent[key] = agent == item.harness ? nil
            : AgentPick(harness: agent, model: Prefs.map("models")[agent] ?? Picks.defaultModel[agent] ?? "")
    }

    /// Tap to talk, tap again to stop: the orb is never held.
    private func tapped() {
        if dictation == .recording {
            Task { await Dictations.shared.stop(store, draft: key) }
            return
        }
        guard phase == .rest || phase == .ready else { return }
        guard let transcriber else { return flash("Nothing can transcribe right now. Type instead.") }
        // A kept recording is the only copy of what was said; it goes by Retry or Discard, never by a new tap.
        guard Dictations.shared.kept[key] == nil else { return }
        Dictations.shared.dismiss(key)
        failed = nil
        Task { await Dictations.shared.start(store, engine: transcriber, draft: key) }
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
        // Spoken words still on their way would land after this send, as a reply of their own.
        guard !words.isEmpty, !sending, dictation == .idle else { return }
        sending = true
        failed = nil
        Haptic.tap()
        // Only what the reader moved; a new model takes an effort it offers.
        let level = model != nil || effort != nil || pick != nil ? current.flatMap { Picks.usableEffort($0, effortNow) } ?? effortNow : nil
        Task {
            let to = await store.send(key, words, harness: pick?.harness, model: model ?? pick?.model, effort: level, stance: stance,
                                      fast: moving ? fastNow && Picks.offersFast(harness, current) : fast)
            if let to {
                // Only if untouched meanwhile: words added while the send was out were never sent.
                if store.drafts[key]?.trimmingCharacters(in: .whitespacesAndNewlines) == words { store.drafts[key] = nil }
                model = nil
                effort = nil
                stance = nil
                fast = nil
                // A switch is a new session: the chat follows it.
                if to != key { openSession?(to) }
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

/// The end of a long reply, cut at a word with "…" before it: about three lines of the bubble.
/// Cut here rather than by `truncationMode(.head)`, which a multi-line `Text` ignores.
func spokenTail(_ text: String, limit: Int = 100) -> String {
    guard text.count > limit else { return text }
    let cut = text.suffix(limit)
    let word = cut.firstIndex(where: \.isWhitespace).map { cut.index(after: $0) } ?? cut.startIndex
    return "…" + cut[word...]
}
