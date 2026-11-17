import SwiftUI
import ThinkingOrbs

extension EnvironmentValues {
    /// Opens the runs sheet on one run, by its spawning call's id: a subagent row in the chat.
    /// False where the chat holds no such run, and the row opens its own output instead.
    @Entry var openRun: ((String) -> Bool)?
}

/// One subagent or backgrounded shell: the desktop's `SubagentRun`, built off the loaded events.
struct Run: Identifiable {
    /// The spawning call's id, which the events' `subagent` envelope carries.
    let id: String
    let session: SessionKey
    /// The harness's handle, what `stop_task` names; nil until a lifecycle event carries it.
    var taskId: String?
    var label: String?
    var description: String?
    /// The newest `subagent_progress` line.
    var status: String?
    var done = false
    var lastAt: String?
    /// The run's own work, its lifecycle events left out.
    var events: [AgentEvent] = []
    /// The spawning call: a shell's command, an agent's brief.
    var tool: String?
    var input: JSON = .null
    /// The spawning call's answer; a backgrounded shell's names the file its output goes to.
    var answer: String?

    /// Claude Code's `Bash` and `Monitor` register as `local_bash`; grok's task list says `bash`.
    var shell: Bool { tool == "Bash" || tool == "Monitor" || label == "local_bash" || label == "bash" }
    var title: String { description ?? label ?? (shell ? "Background task" : "Subagent") }
    var handle: String { taskId ?? id }
    var command: String? { input["command"]?.string }
    var brief: String? { input["prompt"]?.string }
    var opens: Bool { command != nil || !events.isEmpty || brief != nil }
}

/// A session's runs, newest first: the desktop's `buildTranscript` pass over subagent envelopes.
/// `live` is the tasks its child still holds; a run outside it is over whether or not it said so,
/// since only a live child sends the completion.
func buildRuns(_ events: [AgentEvent], session: SessionKey, live: Set<String>, busy: Bool) -> [Run] {
    var calls: [String: (name: String, input: JSON)] = [:]
    var answers: [String: String] = [:]
    var abandoned: Set<String> = []
    var open: [String] = []
    // Every call, a subagent's too: a shell it backgrounds is a run of the session's own.
    for e in events {
        switch e.payload {
        case .toolStarted(let id, let name, _, let input, _):
            calls[id] = (name, input)
            if e.subagent == nil { open.append(id) }
        case .toolCompleted(let id, let r): answers[id] = r.text
        // A prompt abandons every call still open before it, as `buildTurns` reads it.
        case .userMessage(_, _, _, false, _, _, _) where e.subagent == nil:
            abandoned.formUnion(open)
            open = []
        default: break
        }
    }
    var order: [String] = []
    var runs: [String: Run] = [:]
    for e in events {
        guard let id = e.subagent?["id"]?.string else { continue }
        var run = runs[id] ?? Run(id: id, session: session)
        if runs[id] == nil { order.append(id) }
        // The completion's envelope carries no label, so the first one sticks.
        run.label = run.label ?? e.subagent?["label"]?.string
        if let ts = e.ts { run.lastAt = ts }
        switch e.payload {
        case .subagentStarted(let agent, let label, let description):
            run.taskId = agent.isEmpty ? nil : agent
            run.label = run.label ?? label
            run.description = description
        case .subagentProgress(let agent, let description):
            run.taskId = agent.isEmpty ? nil : agent
            run.status = description
        case .subagentCompleted(let agent):
            run.taskId = agent.isEmpty ? nil : agent
            run.done = true
        default:
            run.events.append(e)
        }
        runs[id] = run
    }
    return order.reversed().compactMap { id in
        guard var run = runs[id] else { return nil }
        if let call = calls[id] {
            run.tool = call.name
            run.input = call.input
        }
        run.answer = answers[id]
        if !run.done && !live.contains(run.handle) {
            run.done = answers[id] != nil || abandoned.contains(id) || !busy
        }
        return run
    }
}

/// A subagent's work as the chat's rows, its calls joined to their results.
func runItems(_ run: Run) -> [Item] {
    var results: [String: ToolResult] = [:]
    for e in run.events { if case .toolCompleted(let id, let r) = e.payload { results[id] = r } }
    return run.events.compactMap { e in
        switch e.payload {
        case .assistantText(let text) where !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty:
            return .text(id: e.id, text: text)
        case .toolStarted(let callId, let name, let toolType, let input, let title):
            let r = results[callId]
            return .tool(ToolCall(id: e.id, name: name, toolType: toolType, input: input, title: title, output: r?.text,
                                  state: r.map { $0.isError ? .failed : .done } ?? (run.done ? .done : .pending),
                                  images: r?.images ?? []))
        default:
            return nil
        }
    }
}

/// One run `list_subagents` read off a log, which the loaded chat may not hold.
struct SubagentSummary: Decodable {
    let id: String
    let sessionId: String
    let taskId: String?
    let label: String?
    let description: String?
    let startedAt: String
    let endedAt: String?
}

struct SubagentList: Decodable {
    let runs: [SubagentSummary]
    /// Opaque; handed back as the next page's cursor.
    let next: JSON?
}

/// Finished runs per page, the desktop's.
private let runsPage = 10

/// The subagents and background shells of a chat, newest session first: the desktop's
/// `BotRuns`. Running subagents always show; finished ones fold under the heading and page
/// in off the server's logs, since the chat holds only its tail.
struct RunsSections: View {
    @Environment(Store.self) private var store
    let keys: [SessionKey]
    /// The run a chat row opened the sheet on.
    var focus: String?
    /// Says so when there is nothing, where the sheet holds nothing else.
    var empty = false
    @State private var older: [SubagentSummary] = []
    @State private var next: JSON?
    @State private var loading = false
    @State private var showDone = false
    @State private var expanded: String?

    var body: some View {
        let all = runs()
        let agents = all.filter { !$0.shell }
        let running = agents.filter { !$0.done }
        let completed = agents.filter(\.done)
        let shells = all.filter { $0.shell && (!$0.done || $0.id == expanded) }
        VStack(alignment: .leading, spacing: 0) {
            if !running.isEmpty || !completed.isEmpty {
                heading("Subagents", stoppable: running.filter(stoppable), count: completed.count)
                ForEach(running) { row($0) }
                if showDone {
                    ForEach(completed) { row($0, at: $0.lastAt) }
                    if next != nil { more }
                }
            }
            if !shells.isEmpty {
                heading("Background tasks", stoppable: shells.filter(stoppable), count: 0)
                ForEach(shells) { row($0) }
            }
            if empty && all.isEmpty {
                Text("No subagents or background tasks.")
                    .font(Theme.Font.subhead).foregroundStyle(Theme.secondary)
                    .frame(maxWidth: .infinity).padding(.top, 120)
            }
        }
        .task(id: keys.first) {
            expanded = focus
            if let focus, all.contains(where: { $0.id == focus && $0.done && !$0.shell }) { showDone = true }
            await load(nil)
        }
    }

    /// What the loaded chat holds, then the logs' older runs, then live tasks neither accounts for:
    /// a shell started before the loaded tail, or any task on a server without `list_subagents`.
    private func runs() -> [Run] {
        let held = keys.flatMap { key in
            buildRuns(store.transcripts[key]?.events ?? [], session: key, live: live(key), busy: store.items[key]?.busy ?? false)
        }
        let ids = Set(held.map(\.id))
        let logged = older.filter { !ids.contains($0.id) }.map { s in
            let key = SessionKey(server: keys[0].server, id: s.sessionId)
            return Run(id: s.id, session: key, taskId: s.taskId, label: s.label, description: s.description,
                       done: s.endedAt != nil || !live(key).contains(s.taskId ?? s.id), lastAt: s.endedAt ?? s.startedAt)
        }
        let known = Set((held + logged).flatMap { [$0.id, $0.taskId ?? ""] })
        let orphans = keys.flatMap { key in
            (store.tasks[key] ?? []).filter { !known.contains($0.taskId) }.map {
                Run(id: $0.taskId, session: key, taskId: $0.taskId, label: $0.taskType, description: $0.description)
            }
        }
        return held + logged + orphans
    }

    private func live(_ key: SessionKey) -> Set<String> { Set((store.tasks[key] ?? []).map(\.taskId)) }

    /// Only a task the child holds can be stopped; `stop_task` answers success for any other.
    private func stoppable(_ run: Run) -> Bool {
        guard !run.done, let task = run.taskId else { return false }
        return live(run.session).contains(task) || store.items[run.session]?.busy == true
    }

    private func stop(_ run: Run) {
        guard let task = run.taskId else { return }
        Haptic.tap()
        Task {
            do {
                let _: JSON = try await store.call(run.session.server, "stop_task",
                                                   ["sessionId": .string(run.session.id), "taskId": .string(task)])
            } catch {
                store.lastError = error.localizedDescription
            }
        }
    }

    /// Stop all sits before the count, and only above two: with one, the row's own button is the job.
    private func heading(_ title: String, stoppable: [Run], count: Int) -> some View {
        let toggle = { if count > 0 { withAnimation(Theme.motion) { showDone.toggle() } } }
        return HStack(spacing: Theme.Space.s) {
            Button(action: toggle) {
                Text(title).frame(maxWidth: .infinity, alignment: .leading)
            }
            .buttonStyle(RowButtonStyle())
            .disabled(count == 0)
            if stoppable.count > 1 {
                Button("Stop all") { stoppable.forEach(stop) }
                    .font(Theme.Font.footnoteStrong)
                    .foregroundStyle(Theme.text)
            }
            if count > 0 {
                Button(action: toggle) {
                    HStack(spacing: Theme.Space.xs) {
                        Text(next == nil ? "\(count)" : "\(count)+").monospacedDigit()
                        Chevron(open: showDone)
                    }
                }
                .buttonStyle(RowButtonStyle())
                .accessibilityLabel("\(showDone ? "Hide" : "Show") completed subagents")
            }
        }
        .font(Theme.Font.footnote)
        .foregroundStyle(Theme.secondary)
        .padding(.horizontal, Theme.Space.m)
        .padding(.top, Theme.Space.l)
        .padding(.bottom, Theme.Space.xs)
        .accessibilityIdentifier("runsHeading")
    }

    private func row(_ run: Run, at: String? = nil) -> some View {
        RunRow(run: run, open: expanded == run.id, at: at, stoppable: stoppable(run),
               onToggle: { withAnimation(Theme.motion) { expanded = expanded == run.id ? nil : run.id } },
               onStop: { stop(run) })
    }

    /// A finished row's frame, so the plus sits in the marks' column.
    private var more: some View {
        Button { Task { await load(next) } } label: {
            HStack(spacing: 10) {
                Group {
                    if loading { ProgressView().controlSize(.small) } else { Image(systemName: "plus") }
                }
                .frame(width: 22, height: 22)
                Text(loading ? "Loading…" : "Load more")
                Spacer(minLength: 0)
            }
            .font(Theme.Font.subhead)
            .foregroundStyle(Theme.secondary)
            .padding(.horizontal, Theme.Space.m)
            .frame(height: 44)
        }
        .buttonStyle(RowButtonStyle())
        .disabled(loading)
    }

    /// A page of older runs. A server without `list_subagents` answers `unknown command`,
    /// which leaves the loaded runs and live tasks as the whole list.
    private func load(_ cursor: JSON?) async {
        guard let first = keys.first, !loading else { return }
        loading = true
        defer { loading = false }
        // Live tasks nothing loaded accounts for: the server reads back until it has met them.
        let held = keys.flatMap { buildRuns(store.transcripts[$0]?.events ?? [], session: $0, live: live($0), busy: false) }
        let known = Set((held.map(\.id) + held.compactMap(\.taskId) + older.map(\.id) + older.compactMap(\.taskId)))
        let unseen = keys.flatMap { live($0) }.filter { !known.contains($0) }
        guard let list = try? await store.call(first.server, "list_subagents", [
            "sessionId": .string(first.id), "also": .array(keys.dropFirst().map { .string($0.id) }),
            "cursor": cursor ?? .null, "limit": .number(Double(runsPage)), "live": .array(unseen.map(JSON.string)),
        ], as: SubagentList.self) else { return }
        let had = Set(older.map(\.id))
        older += list.runs.filter { !had.contains($0.id) }
        next = list.next
    }
}

/// One run: its mark, title and live step, its time once done, and Stop while the child holds it.
/// A tap opens what it is doing underneath.
struct RunRow: View {
    let run: Run
    let open: Bool
    let at: String?
    let stoppable: Bool
    let onToggle: () -> Void
    let onStop: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: Theme.Space.s) {
                Button(action: onToggle) {
                    HStack(spacing: 10) {
                        mark.frame(width: 22, height: 22)
                        VStack(alignment: .leading, spacing: 1) {
                            Text(run.title)
                                .font(Theme.Font.body)
                                .foregroundStyle(run.done ? Theme.secondary : Theme.text)
                                .lineLimit(1)
                                .shimmer(!run.done && run.shell)
                            if !run.shell, !run.done, let status = run.status {
                                Text(status).font(Theme.Font.footnote).foregroundStyle(Theme.tertiary).lineLimit(1).shimmer()
                            }
                        }
                        Spacer(minLength: 0)
                        if let at, let date = parseDate(at) {
                            Text(shortAge(date)).font(Theme.Font.footnote.font.monospacedDigit()).foregroundStyle(Theme.tertiary)
                        }
                    }
                    .frame(minHeight: 44)
                    .contentShape(.rect)
                }
                .buttonStyle(RowButtonStyle())
                .disabled(!run.opens)
                if stoppable {
                    Button(action: onStop) {
                        Image(systemName: "stop.fill").font(.system(size: 12)).foregroundStyle(Theme.secondary)
                            .frame(width: 32, height: 32).contentShape(.rect)
                    }
                    .buttonStyle(RowButtonStyle())
                    .accessibilityLabel(run.shell ? "Stop this task" : "Stop this subagent")
                }
            }
            .padding(.horizontal, Theme.Space.m)
            if open && run.opens {
                RunDetail(run: run)
                    .padding(.leading, Theme.Space.m + 32)
                    .padding(.trailing, Theme.Space.m)
                    .padding(.bottom, Theme.Space.m)
                    .transition(.opacity)
            }
        }
        .accessibilityIdentifier("runRow")
    }

    @ViewBuilder private var mark: some View {
        if run.shell {
            Image(systemName: "terminal").font(.system(size: 15)).foregroundStyle(Theme.secondary)
        } else if run.done {
            Image(systemName: "checkmark").font(.system(size: 13, weight: .semibold)).foregroundStyle(Theme.tertiary)
        } else {
            Orb(.delegating)
        }
    }
}

/// What a run is doing: a shell's command over the tail of its output, read off the server
/// while it runs; a subagent's brief over its own calls and messages, live as they land.
struct RunDetail: View {
    @Environment(Store.self) private var store
    let run: Run
    @State private var output: String?
    @State private var outputError: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if let command = run.command {
                Text("$ \(command)")
                    .font(.system(size: 13, design: .monospaced))
                    .foregroundStyle(Theme.text)
                    .textSelection(.enabled)
                    .padding(Theme.Space.s)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .well()
                if let output {
                    ScrollView(.horizontal) {
                        Text(output.isEmpty ? "No output yet." : output)
                            .font(.system(size: 12, design: .monospaced))
                            .foregroundStyle(Theme.secondary)
                            .textSelection(.enabled)
                            .padding(Theme.Space.s)
                            .accessibilityIdentifier("runOutput")
                    }
                    .well()
                } else if let outputError {
                    Text(outputError).font(Theme.Font.footnote).foregroundStyle(Theme.tertiary)
                }
            } else {
                if let brief = run.brief {
                    Text(brief).font(Theme.Font.footnote).foregroundStyle(Theme.secondary).lineLimit(6)
                }
                ForEach(runItems(run)) { ItemView(item: $0) }
                if run.events.isEmpty && !run.done {
                    Text("Nothing reported yet.").font(Theme.Font.footnote).foregroundStyle(Theme.tertiary)
                }
            }
        }
        .task(id: run.done) { await follow() }
    }

    /// Re-reads the shell's output file every two seconds until the run ends. The path is the
    /// one the spawning call's answer names; a harness that names none has no output to show.
    private func follow() async {
        guard run.command != nil else { return }
        guard let path = run.answer?.firstMatch(of: /\/\S+\.output/).map({ String($0.output) }) else {
            outputError = "This agent doesn't say where the output goes."
            return
        }
        struct Body: Decodable { let text: String? }
        while !Task.isCancelled {
            do {
                let body: Body = try await store.call(run.session.server, "read_file", ["path": .string(path)])
                // The tail: a dev server's log grows for hours, and what it says now is at the end.
                output = (body.text ?? "").split(separator: "\n", omittingEmptySubsequences: false)
                    .suffix(30).joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
                outputError = nil
            } catch {
                outputError = sentence(error.localizedDescription)
            }
            if run.done { return }
            try? await Task.sleep(for: .seconds(2))
        }
    }
}

/// The runs on their own: a task's sheet, opened from its background line or a subagent row.
struct RunsSheet: View {
    @Environment(\.dismiss) private var dismiss
    let key: SessionKey
    var focus: String?

    var body: some View {
        NavigationStack {
            ScrollView {
                RunsSections(keys: [key], focus: focus, empty: true)
                    .padding(.horizontal, Theme.Space.s)
                    .padding(.bottom, Theme.Space.l)
            }
            .navigationTitle("Subagents & tasks")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { Button("Done") { dismiss() } }
            .background(Theme.card.ignoresSafeArea())
        }
        .presentationDetents([.medium, .large])
        .presentationBackground(Theme.card)
    }
}
