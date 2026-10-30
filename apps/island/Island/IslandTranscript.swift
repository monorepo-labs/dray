import SwiftUI

/// The pinned session's last three turns, over the input, and three more each
/// time the reader scrolls to the top. The whole transcript stays Dray's.
struct IslandTranscript: View {
    @Environment(Store.self) private var store
    let key: SessionKey
    let openInApp: () -> Void
    @State private var count = Self.page
    /// An older page being read off the server, under the spinner at the top.
    @State private var loading = false
    /// The turn that was topmost when more were asked for, scrolled back to once they land.
    @State private var keep: String?
    /// Far enough above the newest turn to want the way back down.
    @State private var scrolledUp = false
    private static let page = 3

    var body: some View {
        let busy = store.items[key]?.busy ?? false
        let turns = buildTurns(store.transcripts[key]?.events ?? [], busy: busy)
        let live = busy && turns.last?.running == true
        let shown = Array(turns.suffix(count))
        let earlier = count < turns.count || store.transcripts[key]?.olderBefore != nil
        // A stack, not a Group: a Group hands `.task` to its children, and with no turns yet it has none.
        VStack(spacing: 0) {
            if shown.isEmpty, let error = store.transcriptErrors[key] {
                HStack(spacing: 8) {
                    FailureLine(text: error)
                    Button("Retry") { Task { await store.retryLoad(key) } }
                        .buttonStyle(.plain)
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(.white.opacity(0.7))
                }
            }
            if !shown.isEmpty {
                ViewThatFits(in: .vertical) {
                    // Fitting, there is no top to scroll to, so earlier turns are a line to click.
                    list(shown, live: live, earlier: earlier ? { Task { await more(turns.count, top: shown.first?.id) } } : nil)
                    ScrollViewReader { proxy in
                        ScrollView { list(shown, live: live) }
                            .scrollIndicators(.never)
                            // Follows a running turn as it grows.
                            .defaultScrollAnchor(.bottom)
                            .defaultScrollAnchor(.bottom, for: .sizeChanges)
                            // "Show earlier" overflowing the cap swaps the plain list for this one,
                            // which opens at the bottom: bring the turns asked for into view, above
                            // the one that was on top. After the bottom anchor has had its say.
                            .onAppear {
                                guard let k = keep else { return }
                                DispatchQueue.main.async { proxy.scrollTo(k, anchor: .bottom) }
                            }
                            // Reaching the top, not a marker appearing: the edge is crossed
                            // once per scroll, where an appear can fire on every rebuild.
                            .onScrollGeometryChange(for: Bool.self, of: { $0.contentOffset.y < 24 }) { was, now in
                                if now, !was { Task { await more(turns.count, top: shown.first?.id) } }
                            }
                            // Turns landing above would leave the offset where it was, showing the
                            // newest of them; the reader stays on the turn they were reading.
                            .onChange(of: count) {
                                if let keep { proxy.scrollTo(keep, anchor: .top) }
                                keep = nil
                            }
                            .onScrollGeometryChange(for: Bool.self, of: {
                                $0.contentSize.height - $0.contentOffset.y - $0.containerSize.height > 60
                            }) { _, up in
                                withAnimation(.easeOut(duration: 0.15)) { scrolledUp = up }
                            }
                            // Turns above the cap fade out under the card's black, as the draft's rows do.
                            .overlay(alignment: .top) {
                                LinearGradient(colors: [.black, .black.opacity(0)], startPoint: .top, endPoint: .bottom)
                                    .frame(height: 28)
                                    .allowsHitTesting(false)
                            }
                            .overlay(alignment: .bottom) {
                                if scrolledUp, let last = shown.last?.id {
                                    Button {
                                        withAnimation(.snappy(duration: 0.3)) { proxy.scrollTo(last, anchor: .bottom) }
                                    } label: {
                                        Image(systemName: "arrow.down")
                                            .font(.system(size: 11, weight: .bold))
                                            .foregroundStyle(.white.opacity(0.8))
                                            .frame(width: 24, height: 24)
                                            .background(Color(white: 0.2), in: Circle())
                                            .contentShape(Circle())
                                    }
                                    .buttonStyle(.plain)
                                    .help("Scroll to bottom")
                                    .transition(.scale(scale: 0.6).combined(with: .opacity))
                                }
                            }
                    }
                }
                .frame(maxHeight: 240)
                .fixedSize(horizontal: false, vertical: true)
            }
        }
        .environment(\.imageServer, store.connection(key.server))
        // Follows without marking read: looking at the island is not opening the session.
        .task(id: key) { await store.load(key) }
        // Spent by whichever of the two lists drew this count, or by nobody where it
        // still fits; never left for a later swap to jump to.
        .onChange(of: count) { DispatchQueue.main.async { keep = nil } }
    }

    private func list(_ turns: [Turn], live: Bool, earlier: (() -> Void)? = nil) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            if loading {
                ProgressView().controlSize(.small).frame(maxWidth: .infinity)
            } else if let earlier {
                Button("Show earlier", action: earlier)
                    .buttonStyle(.plain)
                    .font(.system(size: 12))
                    .foregroundStyle(.white.opacity(0.4))
                    .frame(maxWidth: .infinity)
            }
            ForEach(turns) { turn in
                Group {
                    if live && turn.id == turns.last?.id { LiveTurn(turn: turn, openInApp: openInApp) } else { settled(turn) }
                }
                .id(turn.id)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// Three more turns: from what is held, then from the server's older pages.
    private func more(_ available: Int, top: String?) async {
        guard !loading else { return }
        if count >= available {
            guard store.transcripts[key]?.olderBefore != nil else { return }
            loading = true
            await store.loadOlder(key)
            loading = false
        }
        keep = top
        var still = Transaction()
        still.disablesAnimations = true
        withTransaction(still) { count += Self.page }
    }

    /// The last message, under a line that opens the whole turn in Dray.
    private func settled(_ turn: Turn) -> some View {
        let work = turn.work.filter { !$0.isPrompt }
        // An interrupted turn has no `finalText`, so its newest message ends it.
        let answer = turn.finalText ?? work.reversed().lazy.compactMap { if case .text(_, let t) = $0 { t } else { nil } }.first
        return VStack(alignment: .leading, spacing: 8) {
            if let p = turn.prompt { PromptBubble(text: p.text, images: p.images, openInApp: openInApp) }
            // The work is Dray's to show: the line leads there and the island closes.
            if !work.isEmpty {
                Button(action: openInApp) {
                    Text(summaryLabel(work)).monospacedDigit()
                    .font(.system(size: 12))
                    .foregroundStyle(.white.opacity(0.4))
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .help("Open in Dray")
            }
            if let answer { MessageText(text: answer) }
            if let failure = turn.failure { FailureLine(text: failure) }
        }
    }
}

/// A running turn: the newest message over the latest call.
private struct LiveTurn: View {
    let turn: Turn
    let openInApp: () -> Void

    var body: some View {
        let text = turn.work.reversed().lazy.compactMap { if case .text(_, let t) = $0 { t } else { nil } }.first
        let call = turn.work.reversed().lazy.compactMap { item -> ToolCall? in
            switch item {
            case .tool(let c): c
            case .group(_, _, let calls, _, _): calls.last
            default: nil
            }
        }.first
        VStack(alignment: .leading, spacing: 8) {
            if let p = turn.prompt { PromptBubble(text: p.text, images: p.images, openInApp: openInApp) }
            if let text { MessageText(text: text) }
            Group {
                if let call { CallLine(call: call) } else {
                    Text("Working").font(.system(size: 13)).foregroundStyle(.white.opacity(0.5)).shimmer()
                }
            }
            .animation(.easeOut(duration: 0.15), value: call?.id)
        }
    }
}

/// "Editing Composer.swift": a call's verb and what it acted on.
private struct CallLine: View {
    let call: ToolCall

    var body: some View {
        let failed = call.state == .failed && !isRoutineError(call.output)
        let summary = call.name.hasPrefix("mcp__") ? mcpSummary(call.name) : call.summary
        HStack(spacing: 6) {
            Text(toolLabel(call.name, pending: call.state == .pending))
                .foregroundStyle(failed ? .red : .white.opacity(0.55))
                .shimmer(call.state == .pending)
            if let summary {
                Text(summary.split(separator: "\n").first.map(String.init) ?? summary)
                    .font(.system(size: 13).monospaced())
                    .foregroundStyle(.white.opacity(0.35))
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
        }
        .font(.system(size: 13))
    }
}

private struct PromptBubble: View {
    let text: String
    let images: [ImageRef]
    let openInApp: () -> Void

    var body: some View {
        VStack(alignment: .trailing, spacing: 4) {
            if !images.isEmpty {
                ThumbnailRow(spacing: 4) {
                    // Seen at size in Dray: a click leads there, as the summary line does.
                    ForEach(Array(images.enumerated()), id: \.offset) { _, ref in
                        Button(action: openInApp) {
                            RemoteImage(ref: ref, fill: true)
                                .frame(width: 44, height: 44)
                                .clipShape(RoundedRectangle(cornerRadius: 8))
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .help("Open in Dray")
                    }
                }
            }
            if !text.isEmpty {
                Text(text)
                    .font(.system(size: 13))
                    .lineLimit(2)
                    .foregroundStyle(.white.opacity(0.85))
                    .padding(.horizontal, 10)
                    .padding(.vertical, 6)
                    .background(.white.opacity(0.1), in: RoundedRectangle(cornerRadius: 12))
            }
        }
        .frame(maxWidth: .infinity, alignment: .trailing)
        .padding(.leading, 64)
    }
}

/// The iOS app's markdown blocks, drawn at the island's size on its black.
private struct MessageText: View {
    let text: String

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(Array(markdownBlocks(text).enumerated()), id: \.offset) { _, block in
                switch block {
                case .prose(let s):
                    Text(inlineMarkdown(s))
                case .heading(let level, let s):
                    Text(inlineMarkdown(s)).font(.system(size: level <= 2 ? 15 : 13, weight: .semibold))
                        .foregroundStyle(.white).padding(.top, 2)
                case .list(let items):
                    VStack(alignment: .leading, spacing: 4) {
                        ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                            HStack(alignment: .firstTextBaseline, spacing: 6) {
                                Text(item.marker).monospacedDigit().foregroundStyle(.white.opacity(0.4))
                                Text(inlineMarkdown(item.text))
                            }
                            .padding(.leading, CGFloat(item.indent) * 14)
                        }
                    }
                case .quote(let s):
                    Text(inlineMarkdown(s)).foregroundStyle(.white.opacity(0.55))
                        .padding(.leading, 10)
                        .overlay(alignment: .leading) { Rectangle().fill(.white.opacity(0.2)).frame(width: 2) }
                case .code(let s):
                    ScrollView(.horizontal) {
                        Text(s).font(.system(size: 11).monospaced()).padding(8)
                    }
                    .scrollIndicators(.never)
                    .background(.white.opacity(0.06), in: RoundedRectangle(cornerRadius: 8))
                case .rule:
                    Rectangle().fill(.white.opacity(0.15)).frame(height: 1).padding(.vertical, 2)
                case .table(let rows):
                    MarkdownTable(rows: rows)
                case .image(_, let url):
                    // Clipped before the frame, so the corners are the picture's and not the column's.
                    RemoteImage(ref: ImageRef(path: nil, url: url, mimeType: nil))
                        .clipShape(RoundedRectangle(cornerRadius: 8))
                        .frame(maxWidth: 200, maxHeight: 120, alignment: .leading)
                }
            }
        }
        .font(.system(size: 13))
        .foregroundStyle(.white.opacity(0.85))
        // Not selectable: a selectable text answers right-click with the text menu, over the island's own.
        .fixedSize(horizontal: false, vertical: true)
    }
}

private struct FailureLine: View {
    let text: String

    var body: some View {
        Label(text, systemImage: "exclamationmark.circle.fill")
            .font(.system(size: 12))
            .foregroundStyle(.red)
            .lineLimit(3)
    }
}
