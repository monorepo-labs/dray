import SwiftUI

// Agents ask for tokens and passwords with `dray secret request`, never in chat
// (#1578, desktop `SecretRequest.tsx` and `SecretsSettings.tsx`). The value goes
// from the card to the session's own server, which writes it to an owner-only
// file and tells the agent the path; nothing here keeps it past the send.

/// Who a secret card or line names: a task, with its machine where it runs elsewhere.
struct SecretParty {
    let id: String
    let title: String
    var machine: String?
    /// Where the phone can open it; nil where it cannot reach the task.
    var key: SessionKey?
}

extension Store {
    /// The task on another machine a bot's card answers, openable where the chat's server shares that machine.
    func secretParty(_ task: SecretTask, chat server: UUID) -> SecretParty {
        let shared = servers.first { $0.via?.parent == server && ($0.via?.machine == task.machine || $0.name == task.machine) }
        return SecretParty(id: task.sessionId, title: task.title, machine: task.machine,
                           key: shared.map { SessionKey(server: $0.id, id: task.sessionId) })
    }
}

// MARK: The card

/// The card itself. Where the answering machine holds a saved one — by this
/// name, picked for it before, or near it — it offers that in one tap, every
/// other saved one a pick away; the agent gets it under the name it asked for.
struct SecretAsk: View {
    @Environment(Store.self) private var store
    @Environment(\.openTask) private var openTask
    let key: SessionKey
    let request: SecretRequest
    /// Named only where the card sits in someone else's chat: in its own, the chat is the asker.
    let asker: SecretParty?

    private enum Answer { case paste, saved, decline }

    @State private var pasting: Bool
    @State private var pick: String
    @State private var value = ""
    @State private var keep = false
    @State private var auto = false
    @State private var sending: Answer?
    @State private var error: String?

    init(key: SessionKey, request: SecretRequest, asker: SecretParty? = nil) {
        self.key = key
        self.request = request
        self.asker = asker
        _pasting = State(initialValue: request.closest == nil)
        _pick = State(initialValue: request.closest ?? request.savedNames?.first ?? request.name)
    }

    private var who: SecretParty? { asker ?? request.task.map { store.secretParty($0, chat: key.server) } }
    private var saved: [String] { request.savedNames ?? [] }
    /// Using it without asking keeps a pasted one, so Save reads as on while that is.
    private var keeps: Bool { keep || auto }
    private var busy: Bool { sending != nil }

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Space.s) {
            VStack(alignment: .leading, spacing: 18) {
                head
                VStack(alignment: .leading, spacing: Theme.Space.m) {
                    if pasting { pasteRow } else { savedRow }
                    VStack(spacing: Theme.Space.s) {
                        if pasting {
                            option("Save to Vault", Binding(get: { keeps }, set: { keep = $0 }))
                                .disabled(auto).opacity(auto ? 0.5 : 1)
                        }
                        option("Let agents use it without asking you", $auto)
                    }
                    if let error {
                        Text(error).font(Theme.Font.footnote).foregroundStyle(Theme.destructive)
                    }
                }
            }
            .padding(.top, 14)
            .padding([.horizontal, .bottom], Theme.Space.l)
            .background(Theme.well, in: .rect(cornerRadius: Theme.Radius.group, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: Theme.Radius.group, style: .continuous).strokeBorder(Theme.hairline))
            if pasting {
                Text(lifeLine).font(Theme.Font.footnote).foregroundStyle(Theme.tertiary).padding(.horizontal, Theme.Space.l)
            }
        }
        .disabled(busy)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var head: some View {
        VStack(alignment: .leading, spacing: Theme.Space.m) {
            if let who {
                HStack(spacing: Theme.Space.m) {
                    Button { who.key.map { openTask?($0) } } label: {
                        HStack(spacing: 6) {
                            BotFace(seed: who.id, size: 16)
                            Text(who.title).lineLimit(1)
                            if let machine = who.machine { MachineMark(machine: machine) }
                        }
                        .font(Theme.Font.subhead)
                        .foregroundStyle(Theme.secondary)
                    }
                    .buttonStyle(RowButtonStyle())
                    .disabled(who.key == nil || openTask == nil)
                    Spacer(minLength: 0)
                    decline
                }
            }
            VStack(alignment: .leading, spacing: 6) {
                HStack(alignment: .firstTextBaseline, spacing: Theme.Space.m) {
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Image(systemName: "key.fill").imageScale(.small)
                        Text(request.label ?? request.name).fontWeight(.semibold)
                    }
                    .font(Theme.Font.subhead)
                    .foregroundStyle(Theme.text)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    if who == nil { decline }
                }
                Text(request.reason).font(Theme.Font.subhead).foregroundStyle(Theme.secondary)
                // The system browser: the session's own could be driven by the agent.
                if let url = request.url.flatMap(URL.init(string:)) {
                    Link(destination: url) {
                        HStack(spacing: Theme.Space.xs) {
                            Image(systemName: "arrow.up.right").imageScale(.small)
                            Text(host(url)).lineLimit(1).truncationMode(.middle)
                        }
                        .font(Theme.Font.subhead)
                        .foregroundStyle(Theme.text)
                    }
                }
            }
        }
    }

    private var decline: some View {
        Button { send(.decline) } label: {
            Image(systemName: "xmark")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(Theme.tertiary)
                .frame(width: 28, height: 28)
        }
        .buttonStyle(RowButtonStyle())
        // Its 28pt box rides the title's 20pt line, centred on it.
        .padding(.vertical, -4)
        .accessibilityLabel("Decline")
    }

    private var pasteRow: some View {
        HStack(spacing: Theme.Space.s) {
            if request.closest != nil {
                Button { withAnimation(Theme.motion) { pasting = false } } label: { Image(systemName: "arrow.left") }
                    .buttonStyle(IconButtonStyle())
                    .padding(.leading, -Theme.Space.s)
                    .accessibilityLabel("Use saved")
            }
            // Not a password field's content type: no password manager offers to fill or save it.
            SecureField("", text: $value, prompt: Text("Paste the value").foregroundStyle(Theme.tertiary))
                .textContentType(.oneTimeCode)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .submitLabel(.send)
                .onSubmit { send(.paste) }
                .font(Theme.Font.body)
                .foregroundStyle(Theme.text)
                .padding(.horizontal, Theme.Space.m)
                .frame(height: 40)
                .background(Theme.raised, in: .rect(cornerRadius: Theme.Radius.md, style: .continuous))
                .accessibilityLabel(request.label ?? request.name)
            Button { send(.paste) } label: {
                HStack(spacing: 6) {
                    Image(systemName: "checkmark.shield.fill")
                    Text(sending == .paste ? "Sharing…" : "Share")
                }
            }
            .buttonStyle(FilledStyle())
            .disabled(busy || value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
    }

    private var savedRow: some View {
        // Side by side where it fits; a long name puts Paste a new one under it.
        ViewThatFits(in: .horizontal) {
            HStack(spacing: Theme.Space.s) { useSaved; pasteNew }
            VStack(alignment: .leading, spacing: Theme.Space.s) { useSaved; pasteNew }
        }
    }

    private var useSaved: some View {
        let picker = saved.count > 1
        return HStack(spacing: 2) {
            Button { send(.saved) } label: {
                HStack(spacing: 6) {
                    Image(systemName: "key.fill")
                    (Text("Use saved ") + Text(pick).monospaced()).lineLimit(1)
                }
            }
            .buttonStyle(FilledStyle(trailing: picker ? 0 : Theme.Radius.md))
            if picker {
                Menu {
                    Section("Saved on \(store.name(of: key.server))") {
                        Picker("Saved secret", selection: $pick) {
                            ForEach(saved, id: \.self) { Text($0).monospaced().tag($0) }
                        }
                        .pickerStyle(.inline)
                    }
                } label: {
                    Image(systemName: "chevron.down")
                }
                .buttonStyle(FilledStyle(leading: 0, width: 36))
                .accessibilityLabel("Pick another saved secret")
            }
        }
    }

    private var pasteNew: some View {
        Button("Paste a new one") { withAnimation(Theme.motion) { pasting = true } }
            .font(Theme.Font.subhead)
            .foregroundStyle(Theme.secondary)
            .buttonStyle(RowButtonStyle())
            .frame(height: 40)
            .padding(.horizontal, Theme.Space.s)
    }

    private func option(_ label: String, _ on: Binding<Bool>) -> some View {
        Toggle(isOn: on) { Text(label).font(Theme.Font.subhead).foregroundStyle(Theme.secondary) }
            .toggleStyle(SwitchStyle())
    }

    /// What happens to a pasted value, as the server does it: deleted after a day unless
    /// saved, and a relayed task always gets that day-long copy on its own machine.
    /// "Out of chat and logs" and no more: the agent can read the file, so it could print it.
    private var lifeLine: String {
        let out = "Kept out of chat and logs."
        if let task = request.task { return "\(out) On \(task.machine) for 24 hours." }
        return keeps ? "\(out) Saved on this machine." : "\(out) Deleted in 24 hours."
    }

    private func send(_ answer: Answer) {
        let pasted = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard sending == nil, answer != .paste || !pasted.isEmpty else { return }
        sending = answer
        error = nil
        Task {
            do {
                try await store.answerSecret(key, requestId: request.requestId,
                                             value: answer == .paste ? pasted : nil,
                                             keep: answer == .paste && keeps, useSaved: answer == .saved,
                                             always: answer != .decline && auto, from: answer == .saved ? pick : nil)
                value = ""
                answer == .decline ? Haptic.tap() : Haptic.success()
            } catch let e {
                error = sentence(e.localizedDescription)
                sending = nil
            }
        }
    }

    private func host(_ url: URL) -> String {
        guard let h = url.host() else { return url.absoluteString }
        return url.path() == "/" || url.path().isEmpty ? h : h + url.path()
    }
}

/// The card's answer buttons: the filled near-white, 40pt, at full strength even
/// while it waits on a value. `leading`/`trailing` square the corners where two meet.
private struct FilledStyle: ButtonStyle {
    var leading = Theme.Radius.md
    var trailing = Theme.Radius.md
    var width: CGFloat?

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(Theme.Font.pill)
            .foregroundStyle(Theme.onPrimary)
            .padding(.horizontal, width == nil ? 14 : 0)
            .frame(width: width, height: 40)
            .background(Theme.primary, in: UnevenRoundedRectangle(
                topLeadingRadius: leading, bottomLeadingRadius: leading,
                bottomTrailingRadius: trailing, topTrailingRadius: trailing, style: .continuous))
            .contentShape(.rect)
            .pressed(configuration.isPressed)
    }
}

/// The desktop's server mark beside a task on another machine, with the machine's name.
private struct MachineMark: View {
    let machine: String

    var body: some View {
        HStack(spacing: 3) {
            ServerGlyph().fill(Theme.tertiary, style: FillStyle(eoFill: true)).frame(width: 11, height: 11)
            Text(machine).foregroundStyle(Theme.tertiary).lineLimit(1)
        }
    }
}

// MARK: Lines

/// A closed secret card, in the words and size of "Started a new task": what happened
/// and who to, never the value or where it went. Also a task's note that it asked its bot.
struct SecretLine: View {
    @Environment(Store.self) private var store
    @Environment(\.openTask) private var openTask
    @Environment(\.openSession) private var openSession
    /// The session it was logged in.
    let key: SessionKey
    let event: AgentEvent

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: "key.fill").imageScale(.small)
            words
        }
        .font(Theme.Font.subhead)
        .foregroundStyle(Theme.tertiary)
        .lineLimit(1)
    }

    @ViewBuilder private var words: some View {
        switch event.payload {
        case .secretAnswered(let a):
            let chip = a.task.map { store.secretParty($0, chat: key.server) }
            if a.outcome == "declined" {
                Text("Declined ") + Text(a.name).monospaced() + Text(chip == nil ? "" : " for")
            } else if chip != nil {
                Text("Sent ") + Text(a.name).monospaced() + Text(" to")
            } else if a.outcome == "used" {
                Text("Used saved ") + Text(a.name).monospaced() + Text(a.auto == true ? " without asking" : "")
            } else {
                Text("Saved ") + Text(a.name).monospaced() + Text(a.kept == true ? " on this machine" : " for 24 hours")
            }
            if let chip {
                Button { chip.key.map { openTask?($0) } } label: { Chip(seed: chip.id, title: chip.title) }
                    .buttonStyle(.plain)
                    .disabled(chip.key == nil)
                if let machine = chip.machine { MachineMark(machine: machine) }
            }
        case .secretRequested(let r):
            let bot = store.botOf(key)
            let chat = bot.flatMap { b in store.servers.lazy.compactMap { s in store.botChat(s.id, b).last }.first }
            Text("Asked")
            if let bot {
                Button { chat.map { openSession?($0) } } label: { Chip(seed: bot.id, avatar: bot.avatar, title: bot.name) }
                    .buttonStyle(.plain)
                    .disabled(chat == nil)
            } else {
                Text("its bot")
            }
            Text("for ") + Text(r.name).monospaced()
        default:
            EmptyView()
        }
    }

    private struct Chip: View {
        let seed: String
        var avatar: BotAvatar?
        let title: String

        var body: some View {
            HStack(spacing: 5) {
                BotFace(seed: seed, avatar: avatar, size: 18)
                Text(title).foregroundStyle(Theme.text)
            }
        }
    }
}

extension AgentEvent {
    /// A secret line the chat draws: a closed card, or a task's ask of its bot elsewhere.
    var isSecretLine: Bool {
        switch payload {
        case .secretAnswered(let a): a.draws
        case .secretRequested(let r): r.bot == true
        default: false
        }
    }
}

// MARK: Settings

/// One saved secret as `list_secrets` names it: never its value.
struct SecretSummary: Decodable, Hashable, Identifiable {
    let name: String
    let modified: String
    let always: Bool?
    var id: String { name }
}

/// Saved secrets on one machine at a time, picked at the top. A value is written
/// here and never read back: the server answers names alone.
struct SecretsSettings: View {
    @Environment(Store.self) private var store
    @State private var picked: UUID?
    @State private var secrets: [SecretSummary]?
    @State private var error: String?
    /// The sheet open: no secret adds, a secret replaces that one.
    @State private var editing: Editing?
    @State private var deleting: SecretSummary?

    struct Editing: Identifiable {
        var secret: SecretSummary?
        var id: String { secret?.name ?? "" }
    }

    private var machines: [Server] { store.live.filter { store.serverState[$0.id] == .connected } }
    /// A machine that went away takes the pick back to the first.
    private var server: UUID? { machines.first { $0.id == picked }?.id ?? machines.first?.id }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 28) {
                VStack(alignment: .leading, spacing: Theme.Space.s) {
                    RowGroup { machinePicker }
                    GroupLabel("Saved on each machine. Values can't be read back.").padding(.horizontal, Theme.Space.m)
                }
                list
            }
            .padding(.horizontal, Theme.Space.l)
            .padding(.top, Theme.Space.m)
        }
        .background(Theme.card.ignoresSafeArea())
        .foregroundStyle(Theme.text)
        .navigationTitle("Vault")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            Button { editing = Editing() } label: { Image(systemName: "plus") }
                .disabled(server == nil)
                .accessibilityLabel("Add secret")
        }
        .task(id: "\(server?.uuidString ?? "")|\(store.secretsRevision)") { await read() }
        .sheet(item: $editing) { e in
            if let server { SecretSheet(server: server, secret: e.secret, saved: secrets ?? []) }
        }
        .confirmationDialog("Delete \(deleting?.name ?? "")?", isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }),
                            titleVisibility: .visible, presenting: deleting) { s in
            Button("Delete", role: .destructive) { Task { await call("delete_secret", ["name": .string(s.name)]) } }
        } message: { _ in
            Text("Agents will have to ask for it again.")
        }
    }

    private var machinePicker: some View {
        Menu {
            Picker("Machine", selection: Binding(get: { server }, set: { picked = $0 })) {
                ForEach(machines) { Text($0.name).tag(Optional($0.id)) }
            }
        } label: {
            SettingsRow("Machine", value: server.map { store.name(of: $0) } ?? "None connected", trailing: "chevron.up.chevron.down")
        }
        .disabled(machines.isEmpty)
    }

    @ViewBuilder private var list: some View {
        if let error {
            Text(error).font(Theme.Font.footnote).foregroundStyle(Theme.destructive).padding(.horizontal, Theme.Space.xs)
        } else if let secrets, secrets.isEmpty {
            GroupLabel("None saved yet.")
        } else if let secrets {
            RowGroup {
                ForEach(Array(secrets.enumerated()), id: \.element.id) { i, s in
                    if i > 0 { RowDivider() }
                    row(s)
                }
            }
        }
    }

    private func row(_ s: SecretSummary) -> some View {
        HStack(spacing: Theme.Space.m) {
            VStack(alignment: .leading, spacing: 2) {
                Text(s.name).font(Theme.Font.body).monospaced().lineLimit(1)
                Text("Saved \(day(s.modified))").font(Theme.Font.footnote).foregroundStyle(Theme.secondary)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            Toggle(isOn: Binding(get: { s.always == true }, set: { on in
                Haptic.select()
                Task { await call("set_secret_always", ["name": .string(s.name), "on": .bool(on)]) }
            })) {
                Text("Auto").font(Theme.Font.subhead).foregroundStyle(Theme.secondary)
            }
            .toggleStyle(SwitchStyle())
            .fixedSize()
            .accessibilityLabel("Let agents use \(s.name) without asking")
            Menu {
                Button("Replace") { editing = Editing(secret: s) }
                Button("Delete", role: .destructive) { deleting = s }
            } label: {
                Image(systemName: "ellipsis").font(Theme.Font.body.font).foregroundStyle(Theme.secondary)
                    .frame(width: 32, height: 44).contentShape(.rect)
            }
            .accessibilityLabel("\(s.name) options")
        }
        .padding(.leading, Theme.Space.l)
        .padding(.trailing, Theme.Space.s)
        .frame(minHeight: 60)
    }

    private func read() async {
        guard let server else { secrets = nil; return }
        do {
            secrets = try await store.call(server, "list_secrets", as: [SecretSummary].self)
            error = nil
        } catch let e {
            error = sentence(e.localizedDescription)
        }
    }

    /// A change lands as `secrets_changed`, which reads the list again.
    private func call(_ cmd: String, _ args: [String: JSON]) async {
        guard let server else { return }
        do { _ = try await store.call(server, cmd, args, as: JSON.self) } catch let e { error = sentence(e.localizedDescription) }
    }

    private func day(_ iso: String) -> String {
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd"
        f.locale = Locale(identifier: "en_US_POSIX")
        return f.date(from: String(iso.prefix(10)))?.formatted(date: .abbreviated, time: .omitted) ?? ""
    }
}

/// Adds a secret, or replaces `secret`'s value with its name fixed. Auto is set after
/// the value lands, since the server only takes it for a saved name.
private struct SecretSheet: View {
    @Environment(Store.self) private var store
    @Environment(\.dismiss) private var dismiss
    let server: UUID
    let secret: SecretSummary?
    let saved: [SecretSummary]
    @State private var newName = ""
    @State private var value = ""
    @State private var auto: Bool
    @State private var busy = false
    @State private var error: String?
    @FocusState private var focus: Field?

    private enum Field { case name, value }

    init(server: UUID, secret: SecretSummary?, saved: [SecretSummary]) {
        self.server = server
        self.secret = secret
        self.saved = saved
        _auto = State(initialValue: secret?.always == true)
    }

    private var replacing: Bool { secret != nil }
    private var name: String { secret?.name ?? newName.trimmingCharacters(in: .whitespaces) }
    private var nameOk: Bool { name.wholeMatch(of: /[A-Za-z_][A-Za-z0-9_]{0,63}/) != nil }
    /// Adding under a saved name overwrites it, which the reader should know.
    private var existing: SecretSummary? { saved.first { $0.name == name } }
    private var filled: Bool { !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: Theme.Space.xl) {
                    VStack(alignment: .leading, spacing: Theme.Space.s) {
                        RowGroup(radius: Theme.Radius.group) {
                            field("Name") {
                                TextField("Name", text: replacing ? .constant(secret?.name ?? "") : $newName,
                                          prompt: Text("GITHUB_TOKEN").foregroundStyle(Theme.tertiary))
                                    .monospaced()
                                    .foregroundStyle(replacing ? Theme.secondary : Theme.text)
                                    .disabled(replacing)
                                    .focused($focus, equals: .name)
                            }
                            RowDivider(inset: 0)
                            field("Value") {
                                // Not a password's content type: no password manager offers to fill or save it.
                                SecureField("Value", text: $value, prompt: Text("Paste the value").foregroundStyle(Theme.tertiary))
                                    .textContentType(.oneTimeCode)
                                    .focused($focus, equals: .value)
                            }
                        }
                        Group {
                            if let error {
                                Text(error).foregroundStyle(Theme.destructive)
                            } else if !replacing, !newName.trimmingCharacters(in: .whitespaces).isEmpty, !nameOk {
                                Text("Letters, digits and _, like GITHUB_TOKEN.").foregroundStyle(Theme.secondary)
                            } else if !replacing, existing != nil {
                                Text("\(name) is saved already; this replaces it.").foregroundStyle(Theme.secondary)
                            } else {
                                Text("Saved on \(store.name(of: server)). Its value can't be read back.").foregroundStyle(Theme.tertiary)
                            }
                        }
                        .font(Theme.Font.footnote)
                        .padding(.horizontal, Theme.Space.xs)
                    }
                    RowGroup(radius: Theme.Radius.group) {
                        switchRow("Let agents use it without asking you", $auto)
                    }
                }
                .padding(.horizontal, 20)
                .padding(.top, 14)
            }
            .background(Theme.card.ignoresSafeArea())
            .scrollDismissesKeyboard(.interactively)
            .navigationTitle(replacing ? "Replace secret" : "Add secret")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(busy) }
                ToolbarItem(placement: .confirmationAction) {
                    Button(busy ? "Saving…" : replacing ? "Replace" : "Save") { Task { await save() } }
                        .fontWeight(.semibold)
                        .disabled(busy || !filled || !nameOk)
                }
            }
            .onAppear { focus = replacing ? .value : .name }
        }
        .interactiveDismissDisabled(busy)
    }

    private func field(_ label: String, @ViewBuilder _ input: () -> some View) -> some View {
        HStack(spacing: Theme.Space.m) {
            Text(label).foregroundStyle(Theme.secondary).frame(width: 72, alignment: .leading)
            input()
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .accessibilityLabel(label)
        }
        .font(Theme.Font.body)
        .padding(.horizontal, Theme.Space.l)
        .frame(minHeight: 52)
    }

    private func save() async {
        busy = true
        error = nil
        do {
            _ = try await store.call(server, "save_secret", ["name": .string(name),
                                                              "value": .string(value.trimmingCharacters(in: .whitespacesAndNewlines))], as: JSON.self)
            value = ""
            if auto != (existing?.always == true) {
                _ = try await store.call(server, "set_secret_always", ["name": .string(name), "on": .bool(auto)], as: JSON.self)
            }
            Haptic.success()
            dismiss()
        } catch let e {
            error = sentence(e.localizedDescription)
            busy = false
        }
    }
}
