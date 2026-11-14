import SwiftUI

/// The desktop's `SHAPES` and `HUES` (botAvatar.ts), in its order.
private let botShapes = ["round", "organic", "boxy", "capsule", "nub", "cloud", "hexagon", "sun", "triangle"]
private let botHues: [(name: String, hue: Double)] = [
    ("Red", 25), ("Orange", 50), ("Amber", 80), ("Green", 145), ("Teal", 185), ("Blue", 250), ("Purple", 295), ("Pink", 340),
]
/// `DEFAULT_AVATAR`: where a bot made before there was a pick starts.
private let defaultAvatar = BotAvatar(shape: "cloud", hue: 250)

/// The desktop's New bot / Edit bot dialog: a face, a name, a shape and a
/// colour, with the agent and model it runs on. A new bot also picks its machine
/// and starts its chat on them, the bot speaking first. Editing says where it
/// runs; its agent and model go with the chat's next message, as the desktop's
/// bot composer has them, another agent moving the chat to a new session.
struct BotSheet: View {
    @Environment(Store.self) private var store
    @Environment(NewTask.self) private var task
    @Environment(\.dismiss) private var dismiss
    /// Nil makes a new bot.
    let editing: (server: UUID, bot: Bot)?
    /// A new bot's chat, once it started.
    var onStarted: (SessionKey) -> Void = { _ in }

    @State private var name = ""
    @State private var avatar = defaultAvatar
    @State private var server: UUID?
    @State private var busy = false
    @State private var error: String?
    /// A bot made whose chat failed to start: a retry starts that one, never a second bot.
    @State private var made: Bot?
    @State private var harness = ""
    @State private var modelId = ""
    @State private var agents: [AgentAvailability] = []
    /// The machine `agents` was read from.
    @State private var agentsOf: UUID?
    @State private var models: [Model] = []

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: Theme.Space.xl) {
                    // A fixed seed, so the faces differ by shape and colour alone, as on the desktop.
                    BotFace(seed: "new-bot", avatar: avatar, size: 96)
                    TextField("Name your bot", text: $name)
                        .font(Theme.Font.headline)
                        .multilineTextAlignment(.center)
                        .submitLabel(.done)
                        .padding(.vertical, Theme.Space.m)
                        .background(Theme.raised, in: .rect(cornerRadius: Theme.Radius.lg, style: .continuous))
                        .accessibilityLabel("Bot name")
                    shapes
                    colours
                    agentPicks
                    place
                    if let error {
                        Text(sentence(error)).font(Theme.Font.subhead).foregroundStyle(Theme.destructive)
                            .multilineTextAlignment(.center)
                    }
                }
                .padding(.horizontal, Theme.Space.l)
                .padding(.top, Theme.Space.l)
                .padding(.bottom, Theme.Space.xl)
            }
            .navigationTitle(editing == nil ? "New bot" : "Edit bot")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(busy) }
                ToolbarItem(placement: .confirmationAction) {
                    Button(editing == nil ? "Create" : "Save") { Task { await submit() } }
                        .fontWeight(.semibold)
                        .disabled(name.trimmingCharacters(in: .whitespaces).isEmpty || busy || target == nil || harness.isEmpty)
                }
            }
            .background(Theme.card.ignoresSafeArea())
        }
        .presentationDetents([.large])
        .presentationBackground(Theme.card)
        .interactiveDismissDisabled(busy)
        .onAppear {
            // An edit opens on the chat's pick: one waiting for its next message, else what it runs on.
            let pick = editing.flatMap(chat(of:)).flatMap { key in
                store.unsent[key] ?? store.items[key].map { AgentPick(harness: $0.harness, model: $0.model) }
            }
            harness = pick?.harness ?? task.harness
            modelId = pick?.model ?? task.modelId
            guard let editing else { return }
            name = editing.bot.name
            avatar = editing.bot.avatar ?? defaultAvatar
        }
        .task(id: "\(target?.uuidString ?? "")|\(harness)") { await loadPicks() }
    }

    /// The agents up on the bot's machine, then the picked one's models.
    private var agentPicks: some View {
        let up = agents.filter(\.available)
        return VStack(alignment: .leading, spacing: Theme.Space.l) {
            if !up.isEmpty {
                PickSection("Agent") {
                    ChipRow(focus: harness) {
                        ForEach(up, id: \.harness) { a in
                            PickChip(label: a.label, selected: a.harness == harness, harness: a.harness) {
                                guard a.harness != harness else { return }
                                harness = a.harness
                                modelId = ""
                                models = []
                            }
                            .id(a.harness)
                        }
                    }
                }
            }
            PickSection("Model", footer: pickNote) {
                ModelChips(models: models, harness: harness, selected: modelId) { modelId = $0 }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// When an edit's pick lands: with the next message, another agent moving the chat.
    private var pickNote: String? {
        guard let editing, let item = chat(of: editing).flatMap({ store.items[$0] }) else { return nil }
        if harness != item.harness { return "Your next message moves the chat to \(Picks.agentLabels[harness] ?? harness)." }
        return modelId != item.model ? "Goes with your next message." : nil
    }

    /// The bot's chat a reply goes to: its newest session. None before its first message.
    private func chat(of e: (server: UUID, bot: Bot)) -> SessionKey? { store.botChat(e.server, e.bot).last }

    /// Reads the machine's agents once, moves off one it lacks, then reads that agent's
    /// models and keeps the model pick where the list has it.
    private func loadPicks() async {
        guard let at = target else { return }
        // Each read is checked against the pick it was for: the task is cancelled when the
        // server or agent moves, and a late answer must not land on the new one's picks.
        if agentsOf != at {
            let read: [AgentAvailability] = (try? await store.call(at, "agent_availability")) ?? []
            guard !Task.isCancelled, at == target else { return }
            agents = read
            agentsOf = at
        }
        if !agents.contains(where: { $0.harness == harness && $0.available }), let first = agents.first(where: \.available) {
            harness = first.harness
            modelId = ""
            return // the task runs again under the new agent
        }
        let asked = harness
        let read: [Model] = (try? await store.call(at, "list_models", ["harness": .string(asked)])) ?? []
        guard !Task.isCancelled, asked == harness, at == target else { return }
        models = read
        modelId = Picks.usableModel(read, modelId.isEmpty ? Picks.defaultModel[asked] ?? "" : modelId, asked)
    }

    private var shapes: some View {
        LazyVGrid(columns: Array(repeating: GridItem(.flexible()), count: 5), spacing: Theme.Space.s) {
            ForEach(botShapes, id: \.self) { shape in
                Button { avatar = BotAvatar(shape: shape, hue: avatar.hue) } label: {
                    BotFace(seed: "new-bot", avatar: BotAvatar(shape: shape, hue: avatar.hue), size: 36)
                        .frame(width: 52, height: 52)
                        .overlay(Circle().strokeBorder(Theme.text.opacity(avatar.shape == shape ? 0.6 : 0), lineWidth: 2))
                        .contentShape(Circle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(shape)
                .accessibilityAddTraits(avatar.shape == shape ? .isSelected : [])
            }
        }
    }

    private var colours: some View {
        HStack(spacing: 10) {
            ForEach(botHues, id: \.hue) { c in
                Button { avatar = BotAvatar(shape: avatar.shape, hue: c.hue) } label: {
                    Circle().fill(swatch(c.hue)).frame(width: 28, height: 28)
                        .padding(3)
                        .overlay(Circle().strokeBorder(Theme.text.opacity(avatar.hue == c.hue ? 0.7 : 0), lineWidth: 2))
                }
                .buttonStyle(.plain)
                .accessibilityLabel(c.name)
                .accessibilityAddTraits(avatar.hue == c.hue ? .isSelected : [])
            }
        }
    }

    /// Where the bot runs: said when editing, picked when new where more than one machine is up.
    @ViewBuilder private var place: some View {
        let label = { (id: UUID?) in
            HStack(spacing: 6) {
                ServerIcon().frame(width: 13, height: 13)
                Text(id.map(store.name(of:)) ?? "No server connected").lineLimit(1)
            }
            .font(Theme.Font.subhead)
            .foregroundStyle(Theme.secondary)
        }
        VStack(spacing: Theme.Space.xs) {
            Text("Runs on").font(Theme.Font.footnote).foregroundStyle(Theme.tertiary)
            if editing == nil && task.connected.count > 1 && made == nil {
                Menu {
                    Picker("Server", selection: Binding(get: { target }, set: { server = $0 })) {
                        ForEach(task.connected) { Text($0.name).tag(Optional($0.id)) }
                    }
                } label: {
                    HStack(spacing: 4) { label(target); Image(systemName: "chevron.up.chevron.down").font(.caption2) }
                        .foregroundStyle(Theme.secondary)
                }
                .accessibilityLabel("Server")
            } else {
                label(target)
            }
        }
        .accessibilityElement(children: editing == nil ? .contain : .combine)
    }

    /// The bot's machine: its own when editing; a new one's pick, else where the dock sends.
    private var target: UUID? {
        if let editing { return editing.server }
        if made != nil { return server }
        // The dock aimed at a bot on a machine that is down answers nil; any machine up will do.
        return task.connected.first { $0.id == server }?.id ?? task.server ?? task.connected.first?.id
    }

    private func submit() async {
        let name = name.trimmingCharacters(in: .whitespaces)
        guard !name.isEmpty, !busy, let at = target else { return }
        busy = true
        error = nil
        defer { busy = false }
        do {
            if let editing {
                let _: Bot = try await store.call(at, "edit_bot", ["id": .string(editing.bot.id), "name": .string(name), "avatar": avatar.json])
                if let key = chat(of: editing), let item = store.items[key] {
                    let pick = AgentPick(harness: harness, model: modelId)
                    store.unsent[key] = pick == AgentPick(harness: item.harness, model: item.model) ? nil : pick
                } else {
                    // No chat yet: its first message goes out from the list's dock, on the dock's picks.
                    task.harness = harness
                    task.pickModel(modelId)
                }
                await store.loadBots(at)
                Haptic.success()
                dismiss()
            } else {
                var bot: Bot
                if let made { bot = made } else {
                    bot = try await create(name, on: at)
                    made = bot
                    server = at
                }
                // A retry carries what was changed since onto the bot made.
                if bot.name != name || bot.avatar != avatar {
                    bot = try await store.call(at, "edit_bot", ["id": .string(bot.id), "name": .string(name), "avatar": avatar.json])
                    made = bot
                }
                // A start whose reply was lost may have opened the chat anyway: open that one, never a second.
                await store.loadBots(at)
                let key: SessionKey
                if let open = store.botChat(at, bot).last {
                    key = open
                } else {
                    let chat = try await store.call(at, "start_bot", startArgs(bot), as: SessionItem.self)
                    store.created(at, chat)
                    key = SessionKey(server: at, id: chat.sessionId)
                }
                Haptic.success()
                dismiss()
                onStarted(key)
            }
        } catch {
            self.error = error.localizedDescription
            Haptic.error()
        }
    }

    /// `create_bot`, and where it fails, the bot of this name that appeared during the call:
    /// one a lost reply made. A bot there before is a refused name, never adopted.
    private func create(_ name: String, on at: UUID) async throws -> Bot {
        // Read fresh, not from the cache: a bot missing there would read as new.
        let before = Set(try await store.call(at, "list_bots", as: [Bot].self).map(\.id))
        do {
            return try await store.call(at, "create_bot", ["name": .string(name), "avatar": avatar.json])
        } catch {
            await store.loadBots(at)
            let orphan = (store.bots[at] ?? []).first {
                !before.contains($0.id) && $0.name.lowercased() == name.lowercased() && store.botChat(at, $0).isEmpty
            }
            guard let orphan else { throw error }
            return orphan
        }
    }

    /// The picked agent and model; effort, fast mode and stance as the dock has them, where they apply.
    private func startArgs(_ bot: Bot) -> [String: JSON] {
        let model = models.first { $0.id == modelId }
        let asDock = harness == task.harness && modelId == task.modelId
        return [
            "id": .string(bot.id),
            "harness": .string(harness),
            "model": .string(modelId),
            "effort": JSON(model.flatMap { Picks.usableEffort($0, asDock ? task.effort : nil) }),
            "permissionMode": .string(Picks.stanceFor(harness, task.stance)),
            "fast": .bool(asDock && task.fast && Picks.offersFast(harness, model)),
        ]
    }
}

extension BotAvatar {
    var json: JSON { .object(["shape": .string(shape), "hue": .number(hue)]) }
}

/// `swatch()`: `oklch(0.68 0.16 hue)`, a picked face's own colour.
private func swatch(_ hue: Double) -> Color {
    let h = hue * .pi / 180
    let (l, a, b) = (0.68, 0.16 * cos(h), 0.16 * sin(h))
    let l_ = pow(l + 0.3963377774 * a + 0.2158037573 * b, 3)
    let m_ = pow(l - 0.1055613458 * a - 0.0638541728 * b, 3)
    let s_ = pow(l - 0.0894841775 * a - 1.2914855480 * b, 3)
    // Linear sRGB; Color's .sRGBLinear space applies the transfer curve itself.
    let r = 4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_
    let g = -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_
    let bl = -0.0041960863 * l_ - 0.7034186147 * m_ + 1.7076147010 * s_
    return Color(.sRGBLinear, red: max(0, min(1, r)), green: max(0, min(1, g)), blue: max(0, min(1, bl)))
}
