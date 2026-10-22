import SwiftUI

extension Store {
    func marks(_ key: SessionKey) -> Marks {
        guard let item = items[key] else { return Marks() }
        return Marks(asking: isAsking(key), unread: item.status == "completed", busy: item.busy, pr: prMark(key, item))
    }
}

/// A card a session is blocked on, in place of the draft.
struct AskCard: View {
    @Environment(Store.self) private var store
    let composer: Composer
    let key: SessionKey
    let event: AgentEvent
    @State private var bodyHeight: CGFloat = 0

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                let keys = composer.attention
                if keys.count > 1 {
                    AskTabs(titles: keys.map { store.items[$0]?.title ?? "Session" }, active: keys.firstIndex(of: key) ?? 0,
                            pick: { composer.askTab = keys[$0] },
                            openInApp: { i in Task { await composer.showInApp(keys[i]) } })
                } else {
                    Text(store.items[key]?.title ?? "Session").lineLimit(1)
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(.white.opacity(0.45))
                        // The title row's ⌘-click, so every title in the panel answers it alike.
                        .onTapGesture {
                            if NSEvent.modifierFlags.contains(.command) { Task { await composer.showInApp(key) } }
                        }
                        .help("⌘-click to open in Dray")
                }
                Spacer(minLength: 0)
                Text(composer.closeHint).font(.system(size: 12)).foregroundStyle(.white.opacity(0.3))
            }
            // A long option list scrolls rather than pushing the buttons out of the window.
            ScrollView {
                Group {
                    switch event.payload {
                    case .permissionRequested(let r): PermissionBody(composer: composer, request: r)
                    case .questionsAsked(let r): QuestionsBody(composer: composer, request: r)
                    default: EmptyView()
                    }
                }
                .onGeometryChange(for: CGFloat.self, of: \.size.height) { bodyHeight = $0 }
            }
            .scrollBounceBehavior(.basedOnSize)
            .frame(height: min(bodyHeight, 420))
        }
        // Answers typed into one card must not carry over to the next.
        .id(event.id)
    }
}

private struct PermissionBody: View {
    let composer: Composer
    let request: PermissionRequest
    @State private var busy = false

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            // The tool and what it is for, read as one line.
            (Text(request.title ?? request.displayName ?? request.toolName).font(.system(size: 13, weight: .medium))
                + Text(request.description.map { "  \($0)" } ?? "").font(.system(size: 12)).foregroundColor(.white.opacity(0.5)))
                .lineLimit(2)
            if let line = request.input.flatMap(toolArgument) {
                Text(line).font(.system(size: 11, weight: .regular).monospaced()).lineLimit(2)
                    .foregroundStyle(.white.opacity(0.5))
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            ForEach(Array(request.options.enumerated()), id: \.element.id) { i, option in
                Button {
                    busy = true
                    Task {
                        await composer.respond(option.id)
                        busy = false
                    }
                } label: {
                    HStack(spacing: 8) {
                        if i < 9 { Text("\(i + 1)").foregroundStyle(.white.opacity(0.3)) }
                        Text(option.label).lineLimit(1)
                            .foregroundStyle(option.behavior == "deny" ? .red : .white)
                        Spacer(minLength: 0)
                    }
                    .font(.system(size: 13))
                    .padding(.horizontal, 10)
                    .frame(height: 30)
                    .itemFill()
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        }
        .disabled(busy)
    }
}

/// One question at a time, the desktop's questionnaire: a number picks an
/// option (toggles one, on a multi-select), Return moves on and sends from the
/// last, Skip leaves a question unanswered — a real answer. Three answer
/// shapes go back: an option's label, several labels comma-separated, or text.
private struct QuestionsBody: View {
    let composer: Composer
    let request: QuestionsRequest
    @State private var index = 0
    @State private var picks: [String: Set<String>] = [:]
    @State private var typed: [String: String] = [:]
    /// The box is a button until clicked, so the card never opens with the caret in it.
    @State private var editing = false
    @FocusState private var boxFocused: Bool
    @State private var busy = false

    private var q: Question { request.questions[index] }
    private var last: Bool { index == request.questions.count - 1 }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline) {
                Text(q.question).font(.system(size: 13, weight: .medium)).fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 8)
                if request.questions.count > 1 {
                    Text("\(index + 1) of \(request.questions.count)").font(.system(size: 12)).foregroundStyle(.white.opacity(0.3))
                }
            }
            ForEach(Array(q.options.enumerated()), id: \.element.label) { i, option in
                let on = picks[q.question, default: []].contains(option.label)
                Button { toggle(option.label) } label: {
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        if i < 9 { Text("\(i + 1)").foregroundStyle(.white.opacity(0.3)) }
                        VStack(alignment: .leading, spacing: 2) {
                            Text(option.label)
                            if let d = option.description {
                                Text(d).font(.system(size: 11)).foregroundStyle(.white.opacity(0.4)).lineLimit(2)
                            }
                        }
                        Spacer(minLength: 0)
                    }
                    .font(.system(size: 13))
                    .padding(.horizontal, 10)
                    .padding(.vertical, 7)
                    .itemFill(on: on)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
            if q.freeText != false {
                if editing {
                    // Typed text is the answer once there is any, so the pick lets go.
                    TextField("", text: Binding(get: { typed[q.question] ?? "" }, set: {
                        typed[q.question] = $0
                        if !$0.isEmpty { picks[q.question] = nil }
                    }),
                              prompt: Text("Something else…").foregroundStyle(.white.opacity(0.3)))
                        .textFieldStyle(.plain)
                        .font(.system(size: 13))
                        .focused($boxFocused)
                        .padding(.horizontal, 10)
                        .frame(height: 32)
                        .background(.white.opacity(0.14), in: RoundedRectangle(cornerRadius: 8))
                        .onAppear { boxFocused = true }
                } else {
                    Button { editing = true } label: {
                        Text(typed[q.question].flatMap { $0.isEmpty ? nil : $0 } ?? "Something else…")
                            .font(.system(size: 13))
                            .foregroundStyle(.white.opacity(typed[q.question]?.isEmpty == false ? 1 : 0.3))
                            .lineLimit(1)
                            .padding(.horizontal, 10)
                            .frame(maxWidth: .infinity, minHeight: 32, alignment: .leading)
                            .itemFill()
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
            }
            HStack(spacing: 14) {
                if index > 0 {
                    Button("Back") { move(-1) }.buttonStyle(.plain).foregroundStyle(.white.opacity(0.5))
                }
                Spacer()
                Button("Skip") { skip() }.buttonStyle(.plain).foregroundStyle(.white.opacity(0.5))
                Button { advance() } label: {
                    Text(last ? "Send  ⏎" : "Next  ⏎").font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(.black)
                        .padding(.horizontal, 12)
                        .frame(height: 28)
                        .background(.white, in: Capsule())
                }
                .buttonStyle(.plain)
            }
            .font(.system(size: 13))
        }
        .disabled(busy)
        .onChange(of: composer.submits) { advance() }
        .onChange(of: composer.digits) {
            if q.options.indices.contains(composer.digit) { toggle(q.options[composer.digit].label) }
        }
    }

    private func toggle(_ label: String) {
        // And the other way: a pick is the answer, which typed text would otherwise outrank unseen.
        typed[q.question] = nil
        editing = false
        var set = picks[q.question, default: []]
        if set.contains(label) { set.remove(label) } else if q.multiSelect { set.insert(label) } else { set = [label] }
        picks[q.question] = set
    }

    private func move(_ delta: Int) {
        editing = false
        index += delta
    }

    private func advance() {
        if last { send() } else { move(1) }
    }

    private func skip() {
        picks[q.question] = nil
        typed[q.question] = nil
        advance()
    }

    private func send() {
        guard !busy else { return }
        var out: [String: String] = [:]
        for q in request.questions {
            let text = (typed[q.question] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            if !text.isEmpty && q.freeText != false {
                out[q.question] = text
            } else if let set = picks[q.question], !set.isEmpty {
                // In option order, so the answer reads the way the menu did.
                out[q.question] = q.options.map(\.label).filter(set.contains).joined(separator: ", ")
            }
        }
        busy = true
        Task {
            await composer.answer(out)
            busy = false
        }
    }
}

/// A card's pickable row: a fill that lifts under the pointer and holds brighter once picked.
private struct ItemFill: ViewModifier {
    var on: Bool
    @State private var hover = false

    func body(content: Content) -> some View {
        content
            .background(.white.opacity(on ? 0.2 : hover ? 0.13 : 0.08), in: RoundedRectangle(cornerRadius: 8))
            .onHover { hover = $0 }
            .animation(.easeOut(duration: 0.12), value: hover)
    }
}

private extension View {
    func itemFill(on: Bool = false) -> some View { modifier(ItemFill(on: on)) }
}
