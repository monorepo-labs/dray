import SwiftUI

/// A card a session is stopped on, answered where it is drawn: under its row in
/// the list, and at the foot of its transcript. Borderless, a fill alone, the
/// Island's card cut to the phone: no number keys, one question at a time.
struct AskCard: View {
    let key: SessionKey
    let event: AgentEvent

    var body: some View {
        Group {
            switch event.payload {
            case .permissionRequested(let r): PermissionAsk(key: key, request: r)
            case .questionsAsked(let r): QuestionsAsk(key: key, request: r)
            default: EmptyView()
            }
        }
        .padding(Theme.Space.m)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.well, in: .rect(cornerRadius: Theme.Radius.lg, style: .continuous))
        // Answers must not carry over to the next card.
        .id(event.id)
        .transition(.opacity)
    }
}

/// A pickable line inside a card: a fill that brightens once picked.
private struct ItemFill: ViewModifier {
    var on = false
    func body(content: Content) -> some View {
        content.background(Color.white.opacity(on ? 0.2 : 0.08), in: .rect(cornerRadius: Theme.Radius.md, style: .continuous))
    }
}

private struct PermissionAsk: View {
    @Environment(Store.self) private var store
    let key: SessionKey
    let request: PermissionRequest
    @State private var busy = false

    var body: some View {
        let argument = request.input.flatMap(toolArgument)
        let beside = request.description ?? argument
        VStack(alignment: .leading, spacing: 6) {
            VStack(alignment: .leading, spacing: 2) {
                (Text(request.displayName ?? request.toolName).foregroundColor(Theme.text)
                    + Text(beside.map { " \($0)" } ?? "").foregroundColor(Theme.text.opacity(0.5)))
                    .font(Theme.Font.subhead)
                    .lineLimit(3)
                // What Allow will run, whenever the description put something else in its place.
                if let argument, argument != beside {
                    Text(argument).font(Theme.Font.footnote).foregroundStyle(Theme.text.opacity(0.5))
                        .lineLimit(4)
                        .textSelection(.enabled)
                }
            }
            .padding(.horizontal, 2)
            .padding(.top, 2)
            .padding(.bottom, Theme.Space.xs)
            ForEach(request.options, id: \.id) { option in
                Button {
                    busy = true
                    Task {
                        await store.respond(key, requestId: request.requestId, optionId: option.id)
                        option.behavior == "deny" ? Haptic.tap() : Haptic.success()
                        busy = false
                    }
                } label: {
                    Text(option.label)
                        .font(Theme.Font.body)
                        .foregroundStyle(option.behavior == "deny" ? Theme.destructive : Theme.text)
                        .lineLimit(1)
                        .padding(.horizontal, Theme.Space.m)
                        .frame(maxWidth: .infinity, minHeight: 40, alignment: .leading)
                        .modifier(ItemFill())
                }
                .buttonStyle(RowButtonStyle())
            }
        }
        .disabled(busy)
        .opacity(busy ? 0.6 : 1)
    }
}

/// The desktop's questionnaire, one question at a time: an option picks (or
/// toggles, on a multi-select), Next moves on and Send answers from the last,
/// Skip leaves one unanswered — a real answer. Three shapes go back: an
/// option's label, several labels comma-separated, or typed text.
private struct QuestionsAsk: View {
    @Environment(Store.self) private var store
    let key: SessionKey
    let request: QuestionsRequest
    @State private var index = 0
    @State private var picks: [String: Set<String>] = [:]
    @State private var typed: [String: String] = [:]
    @State private var busy = false

    private var q: Question { request.questions[index] }
    private var last: Bool { index >= request.questions.count - 1 }

    var body: some View {
        // A request may carry no questions; the agent still waits on an answer, so Skip sends one.
        if request.questions.isEmpty {
            HStack {
                Text("The agent asked nothing.").font(Theme.Font.subhead).foregroundStyle(Theme.secondary)
                Spacer(minLength: 0)
                Button("Skip") { send() }.font(Theme.Font.subhead).foregroundStyle(Color.white.opacity(0.5)).buttonStyle(.plain)
            }
            .padding(2)
            .disabled(busy)
        } else {
            questions
        }
    }

    private var questions: some View {
        VStack(alignment: .leading, spacing: Theme.Space.s) {
            HStack(alignment: .firstTextBaseline, spacing: Theme.Space.s) {
                Text(q.question).font(Theme.Font.subhead).foregroundStyle(Theme.text)
                    .frame(maxWidth: .infinity, alignment: .leading)
                if request.questions.count > 1 {
                    Text("\(index + 1) of \(request.questions.count)")
                        .font(Theme.Font.footnote).foregroundStyle(Color.white.opacity(0.3))
                }
            }
            .padding(2)
            ForEach(q.options, id: \.label) { option in
                Button { toggle(option.label) } label: {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(option.label).font(Theme.Font.body).foregroundStyle(Theme.text)
                        if let d = option.description {
                            Text(d).font(Theme.Font.footnote).foregroundStyle(Color.white.opacity(0.4))
                        }
                    }
                    .padding(.horizontal, Theme.Space.m)
                    .padding(.vertical, 9)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .modifier(ItemFill(on: picks[q.question, default: []].contains(option.label)))
                }
                .buttonStyle(RowButtonStyle())
            }
            if q.freeText != false {
                // On a single pick, typed text is the answer once there is any, so the pick lets go.
                TextField("", text: Binding(get: { typed[q.question] ?? "" }, set: {
                    typed[q.question] = $0
                    if !$0.isEmpty, !q.multiSelect { picks[q.question] = nil }
                }), prompt: Text("Something else…").foregroundStyle(Color.white.opacity(0.3)), axis: .vertical)
                    .font(Theme.Font.body)
                    .foregroundStyle(Theme.text)
                    .padding(.horizontal, Theme.Space.m)
                    .padding(.vertical, 9)
                    .frame(minHeight: 40)
                    .modifier(ItemFill())
            }
            HStack(spacing: 18) {
                if index > 0 {
                    Button("Back") { index -= 1 }.foregroundStyle(Color.white.opacity(0.5))
                }
                Spacer(minLength: 0)
                Button("Skip") { skip() }.foregroundStyle(Color.white.opacity(0.5))
                Button { advance() } label: {
                    Text(last ? "Send" : "Next")
                        .font(Theme.Font.pill)
                        .foregroundStyle(.black)
                        .padding(.horizontal, Theme.Space.l)
                        .frame(height: 34)
                        .background(.white, in: Capsule())
                }
            }
            .font(Theme.Font.subhead)
            .buttonStyle(.plain)
            .padding(.top, Theme.Space.xs)
        }
        .disabled(busy)
        .opacity(busy ? 0.6 : 1)
    }

    private func toggle(_ label: String) {
        Haptic.select()
        // A single pick is the answer, which typed text would otherwise outrank unseen.
        if !q.multiSelect { typed[q.question] = nil }
        var set = picks[q.question, default: []]
        if set.contains(label) { set.remove(label) } else if q.multiSelect { set.insert(label) } else { set = [label] }
        picks[q.question] = set
    }

    private func advance() {
        if last { send() } else { index += 1 }
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
            let typedAnswer = !text.isEmpty && q.freeText != false ? [text] : []
            // In option order, so the answer reads the way the menu did; typed text last.
            let picked = q.options.map(\.label).filter(picks[q.question, default: []].contains)
            let parts = q.multiSelect ? picked + typedAnswer : typedAnswer.isEmpty ? picked : typedAnswer
            if !parts.isEmpty { out[q.question] = parts.joined(separator: ", ") }
        }
        busy = true
        Task {
            await store.answer(key, requestId: request.requestId, answers: out)
            Haptic.success()
            busy = false
        }
    }
}
