import SwiftUI

struct TranscriptView: View {
    @Environment(Store.self) private var store
    let key: SessionKey

    private var item: SessionItem? { store.items[key] }
    private var busy: Bool { item?.busy ?? false }

    var body: some View {
        let transcript = store.transcripts[key]
        let rows = buildRows(transcript?.events ?? [], busy: busy)
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 12) {
                    if transcript?.olderBefore != nil {
                        Button("Load earlier") { Task { await store.loadOlder(key) } }
                            .frame(maxWidth: .infinity)
                    }
                    if transcript == nil {
                        ProgressView().frame(maxWidth: .infinity).padding(.top, 40)
                    }
                    ForEach(rows) { RowView(row: $0) }
                    ForEach(store.queued[key] ?? [], id: \.id) { q in
                        UserBubble(text: q.text, from: nil).opacity(0.5)
                    }
                    if busy {
                        HStack(spacing: 8) {
                            ProgressView().controlSize(.small)
                            Text("Working…").foregroundStyle(.secondary)
                        }
                    }
                    ForEach(store.asks[key] ?? []) { ask in
                        switch ask.payload {
                        case .permissionRequested(let r): PermissionCard(key: key, request: r)
                        case .questionsAsked(let r): QuestionsCard(key: key, request: r)
                        default: EmptyView()
                        }
                    }
                    Color.clear.frame(height: 1).id("bottom")
                }
                .padding()
            }
            .scrollDismissesKeyboard(.interactively)
            // The newest row, not the count, or loading earlier turns would jump to the end.
            .onChange(of: "\(rows.last?.id ?? "")|\(store.asks[key]?.count ?? 0)|\(busy)") {
                proxy.scrollTo("bottom", anchor: .bottom)
            }
            .onAppear { proxy.scrollTo("bottom", anchor: .bottom) }
        }
        .safeAreaInset(edge: .bottom) { Composer(key: key, busy: busy) }
        .navigationTitle(item?.title ?? "")
        .navigationBarTitleDisplayMode(.inline)
        .task { await store.open(key) }
        .prPanel(key)
    }
}

struct RowView: View {
    let row: Row

    var body: some View {
        switch row {
        case .user(_, let text, let from):
            UserBubble(text: text, from: from)
        case .assistant(_, let text):
            MarkdownText(text: text)
        case .tool(_, let line, let output, let state):
            ToolRow(line: line, output: output, state: state)
        case .failure(_, let text):
            Label(text, systemImage: "exclamationmark.circle")
                .foregroundStyle(.red)
                .font(.callout)
                .textSelection(.enabled)
        }
    }
}

struct UserBubble: View {
    let text: String
    let from: String?

    var body: some View {
        VStack(alignment: .trailing, spacing: 4) {
            if let from {
                Text("From \(from)").font(.caption).foregroundStyle(.secondary)
            }
            Text(text)
                .textSelection(.enabled)
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .background(.fill.tertiary, in: RoundedRectangle(cornerRadius: 16))
        }
        .frame(maxWidth: .infinity, alignment: .trailing)
        .padding(.leading, 40)
    }
}

struct ToolRow: View {
    let line: String
    let output: String?
    let state: ToolState
    @State private var open = false

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Button {
                if output?.isEmpty == false { open.toggle() }
            } label: {
                HStack(spacing: 6) {
                    switch state {
                    case .pending: ProgressView().controlSize(.mini)
                    case .failed: Image(systemName: "xmark.circle").foregroundStyle(.red)
                    case .done: Image(systemName: open ? "chevron.down" : "chevron.right")
                    }
                    Text(line).lineLimit(1)
                }
                .font(.footnote.monospaced())
                .foregroundStyle(.secondary)
            }
            .buttonStyle(.plain)
            if open, let output {
                ScrollView(.horizontal) {
                    Text(output.count > 6000 ? String(output.prefix(6000)) + "\n…" : output)
                        .font(.caption.monospaced())
                        .textSelection(.enabled)
                        .padding(8)
                }
                .background(.fill.quaternary, in: RoundedRectangle(cornerRadius: 8))
            }
        }
    }
}

/// Prose through the system's markdown, inline only since `Text` draws no
/// blocks; fenced code split out and drawn monospaced.
struct MarkdownText: View {
    let text: String

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
                if block.code {
                    ScrollView(.horizontal) {
                        Text(block.text).font(.caption.monospaced()).padding(8)
                    }
                    .background(.fill.quaternary, in: RoundedRectangle(cornerRadius: 8))
                } else {
                    Text(attributed(block.text))
                }
            }
        }
        .textSelection(.enabled)
    }

    private var blocks: [(code: Bool, text: String)] {
        var out: [(code: Bool, text: String)] = []
        var current: [Substring] = []
        var code = false
        for line in text.split(separator: "\n", omittingEmptySubsequences: false) {
            if line.trimmingCharacters(in: .whitespaces).hasPrefix("```") {
                let joined = current.joined(separator: "\n").trimmingCharacters(in: .newlines)
                if !joined.isEmpty { out.append((code, joined)) }
                current = []
                code.toggle()
            } else {
                current.append(line)
            }
        }
        let joined = current.joined(separator: "\n").trimmingCharacters(in: .newlines)
        if !joined.isEmpty { out.append((code, joined)) }
        return out
    }

    private func attributed(_ s: String) -> AttributedString {
        (try? AttributedString(markdown: s, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)))
            ?? AttributedString(s)
    }
}

struct Composer: View {
    @Environment(Store.self) private var store
    let key: SessionKey
    let busy: Bool
    @State private var sending = false

    var body: some View {
        let draft = Binding(get: { store.drafts[key] ?? "" }, set: { store.drafts[key] = $0 })
        HStack(alignment: .bottom, spacing: 8) {
            TextField("Message", text: draft, axis: .vertical)
                .lineLimit(1...6)
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .background(.fill.tertiary, in: RoundedRectangle(cornerRadius: 18))
            if busy {
                Button {
                    Task { await store.interrupt(key) }
                } label: {
                    Image(systemName: "stop.circle.fill").font(.title)
                }
                .accessibilityLabel("Stop")
            }
            Button {
                let text = draft.wrappedValue.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !text.isEmpty else { return }
                sending = true
                Task {
                    // Only if untouched meanwhile: text typed while the send was out was never sent.
                    if await store.send(key, text), store.drafts[key]?.trimmingCharacters(in: .whitespacesAndNewlines) == text {
                        store.drafts[key] = nil
                    }
                    sending = false
                }
            } label: {
                Image(systemName: "arrow.up.circle.fill").font(.title)
            }
            .disabled(sending || draft.wrappedValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            .accessibilityLabel("Send")
        }
        .padding(.horizontal)
        .padding(.vertical, 8)
        .background(.bar)
    }
}

struct PermissionCard: View {
    @Environment(Store.self) private var store
    let key: SessionKey
    let request: PermissionRequest
    @State private var busy = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(request.title ?? request.displayName ?? request.toolName).font(.headline)
            if let d = request.description { Text(d).font(.callout).foregroundStyle(.secondary) }
            if let input = request.input {
                let line = toolLine(request.toolName, input)
                if line != request.toolName {
                    Text(line).font(.caption.monospaced()).lineLimit(4)
                }
            }
            ForEach(request.options, id: \.id) { option in
                Button {
                    busy = true
                    Task {
                        await store.respond(key, requestId: request.requestId, optionId: option.id)
                        busy = false
                    }
                } label: {
                    Text(option.label).frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
                .tint(option.behavior == "deny" ? .red : .accentColor)
            }
        }
        .disabled(busy)
        .padding()
        .background(.background.secondary, in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(.yellow.opacity(0.6)))
    }
}

/// Three answer shapes: an option's label, several labels comma-separated,
/// or free text. A question left blank is skipped, which is a real answer.
struct QuestionsCard: View {
    @Environment(Store.self) private var store
    let key: SessionKey
    let request: QuestionsRequest
    @State private var picks: [String: Set<String>] = [:]
    @State private var typed: [String: String] = [:]
    @State private var busy = false

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            ForEach(request.questions, id: \.question) { q in
                VStack(alignment: .leading, spacing: 6) {
                    if let header = q.header { Text(header).font(.caption).foregroundStyle(.secondary) }
                    Text(q.question).font(.headline)
                    ForEach(q.options, id: \.label) { option in
                        let on = picks[q.question, default: []].contains(option.label)
                        Button {
                            toggle(q, option.label)
                        } label: {
                            HStack(alignment: .firstTextBaseline) {
                                Image(systemName: on ? (q.multiSelect ? "checkmark.square.fill" : "largecircle.fill.circle")
                                                     : (q.multiSelect ? "square" : "circle"))
                                VStack(alignment: .leading) {
                                    Text(option.label)
                                    if let d = option.description {
                                        Text(d).font(.caption).foregroundStyle(.secondary)
                                    }
                                }
                                Spacer(minLength: 0)
                            }
                        }
                        .buttonStyle(.plain)
                    }
                    if q.freeText != false {
                        TextField("Or type an answer", text: Binding(
                            get: { typed[q.question] ?? "" },
                            set: { typed[q.question] = $0 }
                        ))
                        .textFieldStyle(.roundedBorder)
                    }
                }
            }
            Button {
                busy = true
                Task {
                    await store.answer(key, requestId: request.requestId, answers: answers)
                    busy = false
                }
            } label: {
                Text("Submit").frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
        }
        .disabled(busy)
        .padding()
        .background(.background.secondary, in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(.yellow.opacity(0.6)))
    }

    private func toggle(_ q: Question, _ label: String) {
        var set = picks[q.question, default: []]
        if set.contains(label) { set.remove(label) }
        else if q.multiSelect { set.insert(label) }
        else { set = [label] }
        picks[q.question] = set
    }

    private var answers: [String: String] {
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
        return out
    }
}
