import SwiftUI

/// The desktop composer's bar for a new session: agent and model, project,
/// worktree, stance. Each control opens a dropdown drawn here rather than an
/// `NSMenu`, so it looks like the desktop's own.
struct NewSessionBar: View {
    let composer: Composer

    var body: some View {
        @Bindable var composer = composer
        HStack(spacing: 12) {
            BarButton(id: .model, composer: composer) {
                AgentGlyph(harness: composer.harness)
                Text(composer.model?.label ?? "Default")
                if let effort = composer.effort {
                    Text(Picks.effortLabels[effort] ?? effort).foregroundStyle(.secondary)
                }
            }
            BarButton(id: .project, composer: composer) {
                Image(systemName: "folder.fill").foregroundStyle(.secondary)
                Text(composer.projects.first { $0.path == composer.projectPath }?.name ?? "Project")
            }
            Button { composer.worktree.toggle() } label: {
                HStack(spacing: 6) {
                    Switch(on: composer.worktree)
                    Text("Worktree").foregroundStyle(composer.worktree ? .primary : .secondary)
                }
            }
            .buttonStyle(.plain)
            if Picks.offersStances(composer.harness) {
                BarButton(id: .stance, composer: composer) {
                    Text(Picks.stances.first { $0.0 == Picks.stanceFor(composer.harness, composer.stance) }?.1 ?? "Auto")
                }
            }
            Spacer(minLength: 0)
            KeyHints(new: false, close: composer.closeHint)
        }
        .font(.system(size: 13, weight: .medium))
        .task(id: composer.harness) { await composer.loadModels() }
    }
}

/// Where each bar control sits, so its dropdown can open beneath it.
struct MenuAnchors: PreferenceKey {
    static let defaultValue: [MenuID: Anchor<CGRect>] = [:]
    static func reduce(value: inout [MenuID: Anchor<CGRect>], nextValue: () -> [MenuID: Anchor<CGRect>]) {
        value.merge(nextValue()) { $1 }
    }
}

private struct BarButton<Label: View>: View {
    let id: MenuID
    let composer: Composer
    @ViewBuilder let label: () -> Label

    var body: some View {
        Button {
            composer.openMenu = composer.openMenu == id ? nil : id
        } label: {
            HStack(spacing: 5) { label() }.lineLimit(1).fixedSize()
        }
        .buttonStyle(.plain)
        .anchorPreference(key: MenuAnchors.self, value: .bounds) { [id: $0] }
    }
}

/// The open dropdown, over everything else, with a catcher behind it that
/// closes it on a click anywhere outside.
struct DropMenus: View {
    let composer: Composer
    let anchors: [MenuID: Anchor<CGRect>]
    /// Above the control, when the panel sits at the bottom of the screen.
    let upward: Bool
    static let width: CGFloat = 240

    var body: some View {
        GeometryReader { proxy in
            if let id = composer.openMenu, let anchor = anchors[id] {
                let r = proxy[anchor]
                ZStack(alignment: upward ? .bottomLeading : .topLeading) {
                    Color.black.opacity(0.001)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                        .onTapGesture { composer.openMenu = nil }
                    // Never taller than the room between the control and the window's edge.
                    let room = (upward ? r.minY : proxy.size.height - r.maxY) - 12
                    Group {
                        if id == .model { ModelMenu(composer: composer, room: room) }
                        else { MenuCard(width: Self.width, room: room) { items(id) } }
                    }
                        .offset(
                            x: min(r.minX - 6, proxy.size.width - Self.width - 8),
                            y: upward ? -(proxy.size.height - r.minY) - 6 : r.maxY + 6
                        )
                }
            }
        }
    }

    @ViewBuilder private func items(_ id: MenuID) -> some View {
        switch id {
        case .model:
            EmptyView()
        case .project:
            ForEach(composer.projects, id: \.path) { p in
                MenuRow(title: p.name, on: p.path == composer.projectPath) {
                    composer.projectPath = p.path
                    composer.openMenu = nil
                }
            }
        case .stance:
            ForEach(Picks.stances.filter { Picks.honours(composer.harness, $0.0) }, id: \.0) { s in
                MenuRow(title: s.1, on: s.0 == Picks.stanceFor(composer.harness, composer.stance)) {
                    composer.stance = s.0
                    composer.openMenu = nil
                }
            }
        }
    }
}

/// The dark card every dropdown is drawn on; short lists take their own
/// height, long ones scroll within the room they have.
private struct MenuCard<Content: View>: View {
    let width: CGFloat
    let room: CGFloat
    @ViewBuilder let content: () -> Content

    var body: some View {
        let rows = VStack(alignment: .leading, spacing: 0) { content() }.padding(4)
        ViewThatFits(in: .vertical) {
            rows
            ScrollView { rows }
        }
        .frame(width: width)
        .frame(maxHeight: min(260, room))
        .fixedSize(horizontal: false, vertical: true)
        .background(Color(white: 0.12), in: RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(.white.opacity(0.1)))
        .shadow(color: .black.opacity(0.4), radius: 14, y: 6)
        .font(.system(size: 13))
    }
}

/// The desktop's model menu: agent marks on a track with a sliding thumb, the
/// shortlist with each row's effort held back a step, and hovering a row opens
/// its effort levels beside it. A click on a row picks the model and keeps its effort.
private struct ModelMenu: View {
    let composer: Composer
    let room: CGFloat
    @State private var hovered: String?
    /// Each row's top as drawn: the list may scroll, so an index says nothing.
    @State private var rowY: [String: CGFloat] = [:]
    static let row: CGFloat = 26

    var body: some View {
        let list = composer.shortlist
        HStack(alignment: .top, spacing: 4) {
            MenuCard(width: 232, room: room) {
                AgentTrack(composer: composer).padding(.bottom, 4)
                ForEach(list, id: \.id) { m in
                    ModelRow(model: m, effort: effort(of: m), picked: m.id == composer.modelId)
                        .onGeometryChange(for: CGFloat.self) { $0.frame(in: .named("modelMenu")).minY } action: { rowY[m.id] = $0 }
                        .onHover { if $0 { hovered = m.id } }
                        .onTapGesture {
                            composer.pickModel(m.id)
                            composer.openMenu = nil
                        }
                }
                if list.isEmpty { Text("No models").foregroundStyle(.secondary).padding(8) }
            }
            if let i = list.firstIndex(where: { $0.id == hovered }), !list[i].efforts.isEmpty {
                let m = list[i]
                MenuCard(width: 140, room: room) {
                    ForEach(m.efforts, id: \.self) { level in
                        MenuRow(title: Picks.effortLabels[level] ?? level, on: level == effort(of: m)) {
                            composer.pickModel(m.id)
                            composer.pickEffort(level, for: m.id)
                            composer.openMenu = nil
                        }
                    }
                }
                // Level with the row it belongs to, and never past the room below.
                .padding(.top, max(0, min(rowY[m.id] ?? 0, room - CGFloat(m.efforts.count) * Self.row - 8)))
            }
        }
        .coordinateSpace(.named("modelMenu"))
        .onChange(of: composer.harness) { hovered = nil }
    }

    /// What a row would run at if clicked: the live pick for the model already
    /// chosen, else that model's remembered or default level.
    private func effort(of m: Model) -> String? {
        m.id == composer.modelId ? composer.effort : Picks.usableEffort(m, composer.effortPicks[m.id])
    }
}

private struct ModelRow: View {
    let model: Model
    let effort: String?
    let picked: Bool
    @State private var hover = false

    var body: some View {
        HStack(spacing: 4) {
            Text(model.label).lineLimit(1)
            if let effort { Text(Picks.effortLabels[effort] ?? effort).foregroundStyle(.secondary) }
            Spacer(minLength: 8)
            if picked {
                Image(systemName: "checkmark").font(.system(size: 11, weight: .semibold))
            } else if !model.efforts.isEmpty {
                Image(systemName: "chevron.right").font(.system(size: 10, weight: .semibold)).foregroundStyle(.secondary)
            }
        }
        .padding(.horizontal, 8)
        .frame(height: ModelMenu.row)
        .background(hover ? .white.opacity(0.08) : .clear, in: RoundedRectangle(cornerRadius: 6))
        .contentShape(Rectangle())
        .onHover { hover = $0 }
    }
}

/// One mark per installed agent, a thumb sliding under the picked one.
private struct AgentTrack: View {
    let composer: Composer

    var body: some View {
        let agents = composer.agents.filter(\.available)
        let at = agents.firstIndex { $0.harness == composer.harness } ?? 0
        HStack(spacing: 0) {
            ZStack(alignment: .leading) {
                RoundedRectangle(cornerRadius: 5)
                    .fill(.white.opacity(0.16))
                    .frame(width: 24, height: 24)
                    .offset(x: CGFloat(at) * 24)
                    .animation(.easeOut(duration: 0.15), value: at)
                HStack(spacing: 0) {
                    ForEach(agents, id: \.harness) { a in
                        Button { composer.harness = a.harness } label: {
                            AgentGlyph(harness: a.harness)
                                .font(.system(size: 12))
                                .frame(width: 24, height: 24)
                                .opacity(a.harness == composer.harness ? 1 : 0.55)
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .help(a.label)
                    }
                }
            }
            Spacer(minLength: 0)
        }
        .padding(4)
        .background(.white.opacity(0.05), in: RoundedRectangle(cornerRadius: 7))
    }
}

private struct MenuRow: View {
    let title: String
    let on: Bool
    let action: () -> Void
    @State private var hover = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: 6) {
                Text(title).lineLimit(1)
                Spacer(minLength: 8)
                if on { Image(systemName: "checkmark").font(.system(size: 11, weight: .semibold)) }
            }
            .padding(.horizontal, 8)
            .frame(height: 26)
            .background(hover ? .white.opacity(0.08) : .clear, in: RoundedRectangle(cornerRadius: 6))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hover = $0 }
    }
}

/// The agent's mark: Claude's asterisk in its own orange, a symbol for the rest.
struct AgentGlyph: View {
    let harness: String

    var body: some View {
        switch harness {
        case "claude_code":
            Image(systemName: "asterisk").fontWeight(.bold).foregroundStyle(Color(red: 0.85, green: 0.47, blue: 0.34))
        default:
            let symbol = ["codex": "circle.hexagonpath", "pi": "pi", "fx": "bolt.fill", "grok": "sparkle"][harness] ?? "circle"
            Image(systemName: symbol).foregroundStyle(.secondary)
        }
    }
}

/// The desktop's worktree switch: a white track with a dark thumb when on.
private struct Switch: View {
    let on: Bool

    var body: some View {
        Capsule()
            .fill(on ? .white : .white.opacity(0.2))
            .frame(width: 26, height: 15)
            .overlay(alignment: on ? .trailing : .leading) {
                Circle().fill(on ? .black : .white).frame(width: 11, height: 11).padding(2)
            }
            .animation(.easeOut(duration: 0.12), value: on)
    }
}
