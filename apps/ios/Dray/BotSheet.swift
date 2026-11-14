import SwiftUI

/// The desktop's `SHAPES` and `HUES` (botAvatar.ts), in its order.
private let botShapes = ["round", "organic", "boxy", "capsule", "nub", "cloud", "hexagon", "sun", "triangle"]
private let botHues: [(name: String, hue: Double)] = [
    ("Red", 25), ("Orange", 50), ("Amber", 80), ("Green", 145), ("Teal", 185), ("Blue", 250), ("Purple", 295), ("Pink", 340),
]
/// `DEFAULT_AVATAR`: where a bot made before there was a pick starts.
private let defaultAvatar = BotAvatar(shape: "cloud", hue: 250)

/// The desktop's New bot / Edit bot dialog: a face, a name, a shape and a
/// colour. Editing also says where the bot runs; a new one picks that, and
/// starts its chat on the new-task dock's agent and model, the bot speaking first.
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
                    place
                    if let error {
                        Text(sentence(error)).font(Theme.Font.subhead).foregroundStyle(Theme.destructive)
                            .multilineTextAlignment(.center)
                    }
                }
                .padding(.horizontal, Theme.Space.xl)
                .padding(.top, Theme.Space.l)
            }
            .navigationTitle(editing == nil ? "New bot" : "Edit bot")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(busy) }
                ToolbarItem(placement: .confirmationAction) {
                    Button(editing == nil ? "Create" : "Save") { Task { await submit() } }
                        .fontWeight(.semibold)
                        .disabled(name.trimmingCharacters(in: .whitespaces).isEmpty || busy || target == nil)
                }
            }
            .background(Theme.card.ignoresSafeArea())
        }
        .presentationDetents([.large])
        .presentationBackground(Theme.card)
        .interactiveDismissDisabled(busy)
        .onAppear {
            guard let editing else { return }
            name = editing.bot.name
            avatar = editing.bot.avatar ?? defaultAvatar
        }
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
                    let chat = try await store.call(at, "start_bot", await startArgs(bot, on: at), as: SessionItem.self)
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

    /// `create_bot`, and where it fails, a bot of this name with no chat yet: one a lost reply already made.
    private func create(_ name: String, on at: UUID) async throws -> Bot {
        do {
            return try await store.call(at, "create_bot", ["name": .string(name), "avatar": avatar.json])
        } catch {
            await store.loadBots(at)
            let orphan = (store.bots[at] ?? []).first {
                $0.name.lowercased() == name.lowercased() && $0.avatar == avatar && $0.welcome == nil && store.botChat(at, $0).isEmpty
            }
            guard let orphan else { throw error }
            return orphan
        }
    }

    /// The dock's picks where it points at this machine. Elsewhere its agent where that machine
    /// has it, else the first it has, on that agent's default model.
    private func startArgs(_ bot: Bot, on at: UUID) async -> [String: JSON] {
        // An unread model list leaves the pick empty, which is the harness's default too.
        let here = at == task.server && !task.modelId.isEmpty
        var harness = task.harness
        if at != task.server, let agents: [AgentAvailability] = try? await store.call(at, "agent_availability"),
           !agents.contains(where: { $0.harness == harness && $0.available }), let first = agents.first(where: \.available) {
            harness = first.harness
        }
        return [
            "id": .string(bot.id),
            "harness": .string(harness),
            "model": .string(here ? task.modelId : Picks.defaultModel[harness] ?? ""),
            "effort": here ? JSON(task.effort) : .null,
            "permissionMode": .string(Picks.stanceFor(harness, task.stance)),
            "fast": .bool(here && task.fast && Picks.offersFast(harness, task.model)),
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
