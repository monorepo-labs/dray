import SwiftUI

// The block half of a message's markdown, shared with the island by path:
// each app draws the blocks its own way, inline runs through `inlineMarkdown`,
// and a table through `MarkdownTable`, which takes the font and ink around it.

enum MarkdownBlock {
    case prose(String), code(String), heading(Int, String), quote(String), rule
    case list([(marker: String, text: String, indent: Int)])
    /// Cells by row, the first being the header.
    case table([[String]])
    /// A line holding one image and nothing else; an image inside a sentence stays text.
    case image(alt: String, url: String)
}

/// A line holding one markdown image and nothing else.
private let imageLine = /!\[([^\]]*)\]\(<?([^)\s>]+)>?(?:\s+"[^"]*")?\)/

/// `| a | b |` → ["a", "b"]; `\|` is a pipe inside a cell, not a border.
private func cells(_ line: String) -> [String] {
    var s = Substring(line.replacingOccurrences(of: "\\|", with: "\u{0}"))
    if s.hasPrefix("|") { s = s.dropFirst() }
    if s.hasSuffix("|") { s = s.dropLast() }
    return s.split(separator: "|", omittingEmptySubsequences: false).map {
        $0.replacingOccurrences(of: "\u{0}", with: "|").trimmingCharacters(in: .whitespaces)
    }
}

/// The `|---|:--:|` line under a table's header.
private func isDelimiter(_ line: some StringProtocol) -> Bool {
    line.trimmingCharacters(in: .whitespaces).wholeMatch(of: /\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?/) != nil
}

func markdownBlocks(_ text: String) -> [MarkdownBlock] {
    var out: [MarkdownBlock] = []
    var prose: [Substring] = [], code: [Substring] = [], quote: [String] = []
    var list: [(marker: String, text: String, indent: Int)] = []
    var table: [[String]] = []
    // Set once the header's delimiter is skipped, so a data row of dashes stays a row.
    var delimited = false
    var fenced = false
    func flush() {
        let p = prose.joined(separator: "\n").trimmingCharacters(in: .newlines)
        if !p.isEmpty { out.append(.prose(p)) }
        if !list.isEmpty { out.append(.list(list)) }
        if !quote.isEmpty { out.append(.quote(quote.joined(separator: "\n"))) }
        if !table.isEmpty { out.append(.table(table)) }
        prose = []; list = []; quote = []; table = []; delimited = false
    }
    let lines = text.split(separator: "\n", omittingEmptySubsequences: false)
    for (i, line) in lines.enumerated() {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        if trimmed.hasPrefix("```") {
            if fenced {
                out.append(.code(code.joined(separator: "\n")))
                code = []
            } else {
                flush()
            }
            fenced.toggle()
            continue
        }
        if fenced { code.append(line); continue }
        // A table opens only on a header with its delimiter line under it, so prose
        // that happens to start with a pipe stays prose.
        if trimmed.hasPrefix("|"), !table.isEmpty || (i + 1 < lines.count && isDelimiter(lines[i + 1])) {
            if table.isEmpty { flush() }
            if table.count == 1, !delimited, isDelimiter(trimmed) { delimited = true; continue }
            table.append(cells(trimmed))
            continue
        }
        if !table.isEmpty { flush() }
        let indent = (line.prefix { $0 == " " }.count) / 2
        if let m = trimmed.wholeMatch(of: imageLine) {
            flush()
            out.append(.image(alt: String(m.1), url: String(m.2)))
        } else if let m = trimmed.firstMatch(of: /^(#{1,6})\s+(.+)$/) {
            flush()
            out.append(.heading(m.1.count, String(m.2)))
        } else if let m = trimmed.firstMatch(of: /^[-*+]\s+(.+)$/) {
            if !prose.isEmpty || !quote.isEmpty { flush() }
            list.append(("•", String(m.1), indent))
        } else if let m = trimmed.firstMatch(of: /^(\d+)[.)]\s+(.+)$/) {
            if !prose.isEmpty || !quote.isEmpty { flush() }
            list.append(("\(m.1).", String(m.2), indent))
        } else if let m = trimmed.firstMatch(of: /^>\s?(.*)$/) {
            if !prose.isEmpty || !list.isEmpty { flush() }
            quote.append(String(m.1))
        } else if trimmed.wholeMatch(of: /(-{3,}|\*{3,}|_{3,})/) != nil {
            flush()
            out.append(.rule)
        } else if trimmed.isEmpty {
            flush()
        } else if !list.isEmpty && indent > 0 {
            // A wrapped list item's continuation.
            list[list.count - 1].text += " " + trimmed
        } else {
            if !list.isEmpty || !quote.isEmpty { flush() }
            prose.append(line)
        }
    }
    // An unclosed fence still shows what it holds.
    if fenced, !code.isEmpty { out.append(.code(code.joined(separator: "\n"))) }
    flush()
    return out
}

/// Bold, italics, code spans and links inside one block.
func inlineMarkdown(_ s: String) -> AttributedString {
    (try? AttributedString(markdown: s, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)))
        ?? AttributedString(s)
}

/// A table on a grid, scrolling sideways when it is wider than the message.
struct MarkdownTable: View {
    let rows: [[String]]

    var body: some View {
        let width = rows.map(\.count).max() ?? 0
        ScrollView(.horizontal) {
            Grid(alignment: .leading, horizontalSpacing: 14, verticalSpacing: 6) {
                ForEach(Array(rows.enumerated()), id: \.offset) { i, row in
                    GridRow {
                        ForEach(0..<width, id: \.self) { c in
                            Text(inlineMarkdown(c < row.count ? row[c] : ""))
                                .fontWeight(i == 0 ? .semibold : nil)
                                .fixedSize(horizontal: false, vertical: true)
                                .frame(maxWidth: 280, alignment: .leading)
                        }
                    }
                    if i == 0 {
                        Rectangle().fill(.primary.opacity(0.15)).frame(height: 1).gridCellUnsizedAxes(.horizontal)
                    }
                }
            }
            .padding(.vertical, 2)
        }
        .scrollIndicators(.never)
    }
}

// An image file a reply names by its absolute path — a `dray image add`
// screenshot, a file the agent wrote: drawn where the reply names it, and paged
// in its turn's gallery. Here rather than beside `recordingPaths`, since the
// island compiles this file and `Transcript.swift`'s gallery reads it. A `//`
// start is a URL's host, not a path.
private let imagePattern = #/(?:^|[\s"'`(<>\[=:])(\/[^\/\s"'`()<>][^\s"'`()<>]*\.(?:png|jpe?g|gif|webp))(?=$|[\s"'`()<>\],;:!?]|\.(?:$|\s))/#
    .ignoresCase()

/// Each line, and whether it is code: inside a fence, or the fence itself.
private func fencedLines(_ text: String) -> [(line: Substring, code: Bool)] {
    var fenced = false
    return text.split(separator: "\n", omittingEmptySubsequences: false).map { line in
        if line.trimmingCharacters(in: .whitespaces).hasPrefix("```") { fenced.toggle(); return (line, true) }
        return (line, fenced)
    }
}

/// Every image path a message names outside code, once each, in the order it
/// names them. One written as a markdown image line is left out: that block draws it already.
func imagePaths(in text: String) -> [String] {
    var seen = Set(markdownBlocks(text).compactMap { block -> String? in
        guard case .image(_, let url) = block else { return nil }
        return url
    })
    return fencedLines(text).filter { !$0.code }.flatMap { $0.line.matches(of: imagePattern) }.compactMap { match in
        let path = String(match.output.1)
        return seen.insert(path).inserted ? path : nil
    }
}

/// The text with `paths` taken out — bare, in a code span, or as a markdown
/// link or inline image — since the picture or player drawn for each names it
/// already. Code and a markdown image line stay whole, and a line left with no
/// words goes.
func hiding(_ paths: [String], in text: String) -> String {
    guard !paths.isEmpty else { return text }
    let named = Set(paths)
    return fencedLines(text).compactMap { line, code -> String? in
        let original = String(line)
        if code || original.trimmingCharacters(in: .whitespaces).wholeMatch(of: imageLine) != nil { return original }
        // Whole tokens only, bounded the way the finders bound them, so `/a.png`
        // never takes a bite out of `/a.png.bak`.
        let out = original
            .replacing(/!?\[[^\]]*\]\(<?([^)\s>]+)>?(?:\s+"[^"]*")?\)/) { named.contains(String($0.1)) ? "" : String($0.0) }
            .replacing(/`([^`]+)`/) { named.contains(String($0.1)) ? "" : String($0.0) }
            .replacing(#/(^|[\s"'(<>\[=:])(\/[^\s"'`()<>]*[^\s"'`()<>\].,;:!?])(?=$|[\s"'`()<>\],;:!?]|\.(?:$|\s))/#) {
                named.contains(String($0.2)) ? String($0.1) : String($0.0)
            }
        guard out != original else { return out }
        guard out.contains(where: { $0.isLetter || $0.isNumber }) else { return nil }
        // Indent is left alone: a list item's nesting reads off it.
        return out.replacing(/\ +([.,;:!?])/) { String($0.1) }
            .replacing(/([:,;])[.,;:]+/) { String($0.1) }
            .replacing(/(\S) {2,}/) { "\($0.1) " }
            .replacing(/\ +$/, with: "")
    }.joined(separator: "\n")
}
