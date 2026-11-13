import SwiftUI

// MARK: Run with

/// Everything a new task starts on, opened from any pick in the list's dock:
/// where it runs, the agent, the model, and effort, fast mode and stance.
struct RunWithSheet: View {
    @Environment(Store.self) private var store
    @Bindable var task: NewTask
    @State private var attaching = false
    @State private var branches: BranchList?
    /// A branch picked while the checkout has uncommitted files: Bring or Stash decides.
    @State private var switching: String?
    @State private var branchError: String?

    var body: some View {
        NavigationStack {
            PickSheet(title: "Run with") {
                PickSection("Where") { whereCard }
                if let branchError {
                    Text(sentence(branchError)).font(Theme.Font.footnote).foregroundStyle(Theme.destructive)
                        .padding(.horizontal, Theme.Space.l)
                }
                let agents = task.available.filter(\.available)
                if !agents.isEmpty {
                    PickSection("Agent") {
                        ChipRow {
                            ForEach(agents, id: \.harness) { a in
                                PickChip(label: a.label, selected: a.harness == task.harness, harness: a.harness) {
                                    task.harness = a.harness
                                }
                            }
                        }
                    }
                }
                PickSection("Model", footer: "Double-tap a model to star it. Starred ones come first.") {
                    ModelChips(models: task.list, harness: task.harness, selected: task.modelId, pick: task.pickModel)
                }
                settingsCard
            }
            .toolbar(.hidden, for: .navigationBar)
            .navigationDestination(isPresented: $attaching) {
                if let server = task.server {
                    AttachProjectView(server: server, projects: store.projects[server] ?? []) { list in
                        store.attached(server, list)
                        task.projectName = list.max { $0.lastSelected < $1.lastSelected }?.name
                    }
                }
            }
        }
        .presentationDetents([.large])
        .presentationDragIndicator(.visible)
        .presentationCornerRadius(38)
        .presentationBackground(Theme.card)
        .task(id: place) {
            branches = nil
            branchError = nil
            await readBranches()
        }
        .confirmationDialog(dirtyTitle, isPresented: Binding(get: { switching != nil }, set: { if !$0 { switching = nil } }),
                            titleVisibility: .visible, presenting: switching) { branch in
            Button("Bring changes") { Task { await checkout(branch, stash: false) } }
            Button("Stash changes") { Task { await checkout(branch, stash: true) } }
            Button("Cancel", role: .cancel) {}
        } message: { branch in
            Text("Switching to \(branch). Bring moves them with you; Stash keeps them here, saved for later.")
        }
    }

    @ViewBuilder private var whereCard: some View {
        // Server first: the project menu lists what the picked server holds.
        PickCard {
            if !task.connected.isEmpty {
                PickMenu("Server", value: task.server.map(store.name(of:)) ?? "") {
                    Picker("Server", selection: Binding(get: { task.server }, set: task.pick(server:))) {
                        ForEach(task.connected) { Text($0.name).tag(Optional($0.id)) }
                    }
                }
                PickDivider()
            }
            if task.projectChoices.isEmpty {
                Button { attaching = true } label: {
                    HStack(spacing: Theme.Space.s) {
                        Image(systemName: "plus").font(.system(size: 14, weight: .semibold)).frame(width: 16)
                        Text("Attach project").frame(maxWidth: .infinity, alignment: .leading)
                        Image(systemName: "chevron.right").font(.system(size: 13, weight: .semibold)).foregroundStyle(Theme.tertiary)
                    }
                    .font(Theme.Font.body)
                    .foregroundStyle(Theme.text)
                    .rowFrame()
                }
                .disabled(task.server == nil)
            } else {
                PickMenu("Project", value: task.projectChoice?.label ?? "") {
                    Picker("Project", selection: Binding(get: { task.projectChoice }, set: task.pick)) {
                        ForEach(task.projectChoices, id: \.self) { Text($0.label).tag(Optional($0)) }
                    }
                    Divider()
                    Button("Attach project…", systemImage: "plus") { attaching = true }
                }
                PickDivider()
                PickRow("Worktree", detail: task.worktree ? branches?.defaultBase.map { "from \($0)" } : nil) {
                    PickSwitch(label: "Worktree", isOn: $task.worktree)
                }
                if !task.worktree, let branches, let current = branches.current {
                    PickDivider()
                    PickMenu("Branch", value: current) {
                        Picker("Branch", selection: Binding(get: { current }, set: pickBranch)) {
                            ForEach(branches.branches, id: \.self) { Text($0).tag($0) }
                        }
                    }
                }
            }
        }
    }

    @ViewBuilder private var settingsCard: some View {
        let effort = task.model.map { !$0.efforts.isEmpty } ?? false
        let fast = Picks.offersFast(task.harness, task.model)
        let stance = Picks.offersStances(task.harness)
        if effort || fast || stance {
            PickCard {
                if effort, let model = task.model {
                    PickMenu("Effort", value: task.effort.map { Picks.effortLabels[$0] ?? $0 } ?? "") {
                        Picker("Effort", selection: Binding(get: { task.effort ?? "" }, set: task.pickEffort)) {
                            ForEach(model.efforts, id: \.self) { Text(Picks.effortLabels[$0] ?? $0).tag($0) }
                        }
                    }
                }
                if fast {
                    if effort { PickDivider() }
                    PickRow("Fast mode") { PickSwitch(label: "Fast mode", isOn: $task.fast) }
                }
                if stance {
                    if effort || fast { PickDivider() }
                    PickMenu("Permissions", value: task.stanceLabel) {
                        Picker("Permissions", selection: Binding(get: { Picks.stanceFor(task.harness, task.stance) }, set: { task.stance = $0 })) {
                            ForEach(Picks.stances.filter { Picks.honours(task.harness, $0.0) }, id: \.0) { Text($0.1).tag($0.0) }
                        }
                    }
                }
            }
        }
    }

    private var dirtyTitle: String {
        let n = branches?.dirty ?? 0
        return n == 1 ? "1 uncommitted file" : "\(n) uncommitted files"
    }

    /// The checkout the branch row speaks for; a reply for any other is dropped on landing.
    private var place: String { "\(task.server?.uuidString ?? "")|\(task.cwd ?? "")" }

    @discardableResult
    private func readBranches() async -> BranchList? {
        let at = place
        guard let server = task.server, let cwd = task.cwd else { return nil }
        do {
            let read: BranchList = try await store.call(server, "list_branches", ["cwd": .string(cwd)])
            guard at == place else { return nil }
            branches = read
            branchError = nil
            return read
        } catch {
            // The last list stays, so the row is still there to try again from.
            if at == place { branchError = error.localizedDescription }
            return nil
        }
    }

    /// A clean checkout switches at once; uncommitted files ask first, as the desktop's picker does.
    /// Counted afresh, since the agent or an editor may have written since the sheet opened.
    private func pickBranch(_ branch: String) {
        guard branch != branches?.current else { return }
        Task {
            guard let fresh = await readBranches() else { return }
            if fresh.dirty > 0 { switching = branch } else { await checkout(branch, stash: false) }
        }
    }

    private func checkout(_ branch: String, stash: Bool) async {
        let at = place
        guard let server = task.server, let cwd = task.cwd else { return }
        branchError = nil
        do {
            let list: BranchList = try await store.call(server, "checkout_branch",
                                                        ["cwd": .string(cwd), "branch": .string(branch), "stash": .bool(stash)])
            guard at == place else { return }
            branches = list
            Haptic.success()
        } catch {
            guard at == place else { return }
            // Git refusing names the files in the way, which is the part to act on.
            branchError = error.localizedDescription
            Haptic.error()
        }
    }
}

// MARK: Pieces

/// A picks sheet's frame: the title over Done on the right, then sections 24pt apart.
struct PickSheet<Content: View>: View {
    let title: String
    @ViewBuilder let content: Content
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(spacing: 0) {
            ZStack {
                Text(title).font(Theme.Font.headline).foregroundStyle(Theme.text)
                HStack {
                    Spacer()
                    Button("Done") { dismiss() }
                        .font(Theme.Font.headline)
                        .foregroundStyle(Theme.text)
                        .frame(width: 64, alignment: .trailing)
                }
            }
            .frame(height: 52)
            .padding(.horizontal, Theme.Space.xs)
            ScrollView {
                VStack(alignment: .leading, spacing: Theme.Space.xl) { content }
                    .padding(.top, Theme.Space.m)
                    .padding(.bottom, Theme.Space.xl)
            }
            .scrollIndicators(.hidden)
        }
        .padding(.horizontal, Theme.Space.l)
        .padding(.top, 11)
        .background(Theme.card)
    }
}

/// A grey label over its content, with an optional note under it.
struct PickSection<Content: View>: View {
    let label: String?
    var footer: String?
    @ViewBuilder let content: Content

    init(_ label: String?, footer: String? = nil, @ViewBuilder content: () -> Content) {
        self.label = label
        self.footer = footer
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Space.s) {
            if let label { note(label) }
            content
            if let footer { note(footer) }
        }
    }

    private func note(_ line: String) -> some View {
        Text(line).font(Theme.Font.footnote).foregroundStyle(Theme.tertiary).padding(.horizontal, Theme.Space.l)
    }
}

struct PickCard<Content: View>: View {
    @ViewBuilder let content: Content

    var body: some View {
        VStack(spacing: 0) { content }
            .background(Theme.raised, in: RoundedRectangle(cornerRadius: Theme.Radius.lg, style: .continuous))
    }
}

struct PickDivider: View {
    var body: some View {
        Theme.hairline.frame(height: 1).padding(.leading, Theme.Space.l)
    }
}

/// A 52pt card row: the label, a grey note beside it where there is one, and what it holds.
struct PickRow<Trailing: View>: View {
    let label: String
    var detail: String?
    @ViewBuilder let trailing: Trailing

    init(_ label: String, detail: String? = nil, @ViewBuilder trailing: () -> Trailing) {
        self.label = label
        self.detail = detail
        self.trailing = trailing()
    }

    var body: some View {
        HStack(spacing: detail == nil ? Theme.Space.s : 6) {
            Text(label).foregroundStyle(Theme.text)
                .frame(maxWidth: detail == nil ? .infinity : nil, alignment: .leading)
            if let detail {
                Text(detail).foregroundStyle(Theme.tertiary).frame(maxWidth: .infinity, alignment: .leading)
            }
            trailing
        }
        .font(Theme.Font.body)
        .lineLimit(1)
        .rowFrame()
    }
}

/// A card row whose value is picked from a menu; `row.<label>` finds it in tests.
struct PickMenu<Content: View>: View {
    let label: String
    let value: String
    @ViewBuilder let content: Content

    init(_ label: String, value: String, @ViewBuilder content: () -> Content) {
        self.label = label
        self.value = value
        self.content = content()
    }

    var body: some View {
        Menu { content } label: { PickRow(label) { MenuValue(value) } }
            .accessibilityIdentifier("row." + label)
    }
}

/// A menu row's value and its up-down chevron; a lock in its place where the value can't move now.
struct MenuValue: View {
    let value: String
    var locked = false

    init(_ value: String, locked: Bool = false) {
        self.value = value
        self.locked = locked
    }

    var body: some View {
        HStack(spacing: Theme.Space.s) {
            Text(value).foregroundStyle(locked ? Theme.tertiary : Theme.secondary)
            Image(systemName: locked ? "lock.fill" : "chevron.up.chevron.down")
                .font(.system(size: locked ? 11 : 12, weight: .semibold))
                .foregroundStyle(Theme.tertiary)
                .frame(width: 13)
        }
    }
}

/// The frames' switch: white with a dark knob when on, grey when off.
struct PickSwitch: View {
    let label: String
    @Binding var isOn: Bool
    @Environment(\.isEnabled) private var enabled

    var body: some View {
        Button {
            isOn.toggle()
            Haptic.select()
        } label: {
            Capsule()
                .fill(isOn ? Theme.primary : Theme.off)
                .frame(width: 51, height: 31)
                .overlay(alignment: isOn ? .trailing : .leading) {
                    Circle().fill(isOn ? Theme.onPrimary : Theme.secondary).frame(width: 27, height: 27).padding(2)
                }
                .opacity(enabled ? 1 : 0.35)
        }
        .buttonStyle(.plain)
        .animation(Theme.motion, value: isOn)
        .accessibilityLabel(label)
        .accessibilityValue(isOn ? "On" : "Off")
        .accessibilityAddTraits(.isToggle)
    }
}

/// Chips in one sideways-scrolling line, running to the sheet's edges, opened on `focus`.
struct ChipRow<Content: View>: View {
    var focus: String?
    @ViewBuilder let content: Content

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView(.horizontal) {
                HStack(spacing: Theme.Space.s) { content }
            }
            .scrollIndicators(.hidden)
            .contentMargins(.horizontal, Theme.Space.l, for: .scrollContent)
            .padding(.horizontal, -Theme.Space.l)
            .onAppear { if let focus { proxy.scrollTo(focus, anchor: .center) } }
            // A new agent brings a new list and pick while the row stays on screen.
            .onChange(of: focus) { if let focus { withAnimation(Theme.motion) { proxy.scrollTo(focus, anchor: .center) } } }
        }
    }
}

/// One choice in a chip row: white when picked. An agent carries its mark, a starred model its star.
struct PickChip: View {
    let label: String
    let selected: Bool
    var harness: String?
    var starred = false
    var star: (() -> Void)?
    let pick: () -> Void

    var body: some View {
        HStack(spacing: 0) {
            if let harness {
                AgentMark(harness: harness).frame(width: 13, height: 13).padding(.trailing, 6)
            }
            if starred {
                Image(systemName: "star.fill").font(.system(size: 10)).foregroundStyle(Theme.accent).padding(.trailing, 5)
            }
            Text(label).font(selected ? Theme.Font.pill : Theme.Font.subhead)
        }
        .foregroundStyle(selected ? Theme.page : Theme.text)
        .lineLimit(1)
        .padding(.horizontal, 14)
        .frame(height: 36)
        .background(selected ? Theme.text : Theme.tile, in: Capsule())
        .contentShape(Capsule())
        // Double first: a single tap waits out the second, which is the price of starring by double-tap.
        .onTapGesture(count: 2) { (star ?? pick)() }
        .onTapGesture {
            Haptic.select()
            pick()
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(label)
        .accessibilityAddTraits(selected ? [.isButton, .isSelected] : .isButton)
        .accessibilityValue(starred ? "Starred" : "")
        .accessibilityActions {
            if let star { Button(starred ? "Unstar" : "Star", action: star) }
        }
    }
}

/// An agent's models as chips, starred ones first. Stars live on this phone, per agent.
struct ModelChips: View {
    let models: [Model]
    let harness: String
    let selected: String
    let pick: (String) -> Void
    @State private var stars: [String] = []

    private var key: String { "stars." + harness }
    /// The shortlist, and the pick if it is off it. pi and fx run their own default where
    /// nothing is picked, so that is a choice too.
    private var choices: [(id: String, label: String)] {
        let all = (Picks.defaultModel[harness] == "" ? [("", "Default")] : [])
            + models.filter { $0.secondary != true || $0.id == selected }.map { ($0.id, $0.label) }
        return all.filter { stars.contains($0.0) } + all.filter { !stars.contains($0.0) }
    }

    var body: some View {
        ChipRow(focus: selected) {
            ForEach(choices, id: \.id) { m in
                PickChip(label: m.label, selected: m.id == selected, starred: stars.contains(m.id),
                         star: m.id.isEmpty ? nil : { toggle(m.id) }) { pick(m.id) }
                    .id(m.id)
            }
        }
        .animation(Theme.motion, value: stars)
        .task(id: harness) { stars = UserDefaults.standard.stringArray(forKey: key) ?? [] }
    }

    private func toggle(_ id: String) {
        if let i = stars.firstIndex(of: id) { stars.remove(at: i) } else { stars.append(id) }
        UserDefaults.standard.set(stars, forKey: key)
        Haptic.firm()
    }
}

extension View {
    /// A card row's 52pt height and its 16/14 insets.
    func rowFrame() -> some View {
        frame(maxWidth: .infinity, minHeight: 52).padding(.leading, Theme.Space.l).padding(.trailing, 14).contentShape(Rectangle())
    }
}
