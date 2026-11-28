package com.yogesh.dray.model

// The block half of a message's markdown, the iOS app's Markdown.swift: blocks here,
// inline runs (bold, italics, code spans, links) in the view.

sealed interface MdBlock {
    data class Prose(val text: String) : MdBlock
    data class Code(val text: String) : MdBlock
    data class Heading(val level: Int, val text: String) : MdBlock
    data class Quote(val text: String) : MdBlock
    data object Rule : MdBlock
    data class ListItem(val marker: String, val text: String, val indent: Int)
    data class Bullets(val items: List<ListItem>) : MdBlock
    /** Cells by row, the first being the header. */
    data class Table(val rows: List<List<String>>) : MdBlock
    /** A line holding one image and nothing else; an image inside a sentence stays text. */
    data class Image(val alt: String, val url: String) : MdBlock
}

private val imageLine = Regex("""!\[([^\]]*)]\(<?([^)\s>]+)>?(?:\s+"[^"]*")?\)""")
private val delimiter = Regex("""\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?""")
private val heading = Regex("""^(#{1,6})\s+(.+)$""")
private val bullet = Regex("""^[-*+]\s+(.+)$""")
private val numbered = Regex("""^(\d+)[.)]\s+(.+)$""")
private val quote = Regex("""^>\s?(.*)$""")
private val rule = Regex("""(-{3,}|\*{3,}|_{3,})""")

/** `| a | b |` → ["a", "b"]; `\|` is a pipe inside a cell, not a border. */
private fun cells(line: String): List<String> {
    var s = line.replace("\\|", "\u0000")
    if (s.startsWith("|")) s = s.drop(1)
    if (s.endsWith("|")) s = s.dropLast(1)
    return s.split("|").map { it.replace("\u0000", "|").trim() }
}

private fun isDelimiter(line: String) = delimiter.matches(line.trim())

fun markdownBlocks(text: String): List<MdBlock> {
    val out = mutableListOf<MdBlock>()
    val prose = mutableListOf<String>()
    val code = mutableListOf<String>()
    val quoted = mutableListOf<String>()
    val list = mutableListOf<MdBlock.ListItem>()
    val table = mutableListOf<List<String>>()
    // Set once the header's delimiter is skipped, so a data row of dashes stays a row.
    var delimited = false
    var fenced = false
    fun flush() {
        val p = prose.joinToString("\n").trim('\n')
        if (p.isNotEmpty()) out += MdBlock.Prose(p)
        if (list.isNotEmpty()) out += MdBlock.Bullets(list.toList())
        if (quoted.isNotEmpty()) out += MdBlock.Quote(quoted.joinToString("\n"))
        if (table.isNotEmpty()) out += MdBlock.Table(table.toList())
        prose.clear(); list.clear(); quoted.clear(); table.clear(); delimited = false
    }
    val lines = text.split("\n")
    for ((i, line) in lines.withIndex()) {
        val trimmed = line.trim()
        if (trimmed.startsWith("```")) {
            if (fenced) {
                out += MdBlock.Code(code.joinToString("\n"))
                code.clear()
            } else {
                flush()
            }
            fenced = !fenced
            continue
        }
        if (fenced) { code += line; continue }
        // A table opens only on a header with its delimiter line under it, so prose starting with a pipe stays prose.
        if (trimmed.startsWith("|") && (table.isNotEmpty() || (i + 1 < lines.size && isDelimiter(lines[i + 1])))) {
            if (table.isEmpty()) flush()
            if (table.size == 1 && !delimited && isDelimiter(trimmed)) { delimited = true; continue }
            table += cells(trimmed)
            continue
        }
        if (table.isNotEmpty()) flush()
        val indent = line.takeWhile { it == ' ' }.length / 2
        val image = imageLine.matchEntire(trimmed)
        when {
            image != null -> { flush(); out += MdBlock.Image(image.groupValues[1], image.groupValues[2]) }
            heading.find(trimmed) != null -> {
                val m = heading.find(trimmed)!!
                flush(); out += MdBlock.Heading(m.groupValues[1].length, m.groupValues[2])
            }
            bullet.find(trimmed) != null -> {
                if (prose.isNotEmpty() || quoted.isNotEmpty()) flush()
                list += MdBlock.ListItem("•", bullet.find(trimmed)!!.groupValues[1], indent)
            }
            numbered.find(trimmed) != null -> {
                if (prose.isNotEmpty() || quoted.isNotEmpty()) flush()
                val m = numbered.find(trimmed)!!
                list += MdBlock.ListItem("${m.groupValues[1]}.", m.groupValues[2], indent)
            }
            quote.find(trimmed) != null -> {
                if (prose.isNotEmpty() || list.isNotEmpty()) flush()
                quoted += quote.find(trimmed)!!.groupValues[1]
            }
            rule.matches(trimmed) -> { flush(); out += MdBlock.Rule }
            trimmed.isEmpty() -> flush()
            list.isNotEmpty() && indent > 0 -> {
                // A wrapped list item's continuation.
                val last = list.removeAt(list.lastIndex)
                list += last.copy(text = last.text + " " + trimmed)
            }
            else -> {
                if (list.isNotEmpty() || quoted.isNotEmpty()) flush()
                prose += line
            }
        }
    }
    // An unclosed fence still shows what it holds.
    if (fenced && code.isNotEmpty()) out += MdBlock.Code(code.joinToString("\n"))
    flush()
    return out
}

// An image file a reply names by its absolute path — a screenshot, a file the agent wrote —
// drawn where the reply names it. A `//` start is a URL's host, not a path.
private val imagePattern = Regex(
    """(?:^|[\s"'`(<>\[=:])(/[^/\s"'`()<>][^\s"'`()<>]*\.(?:png|jpe?g|gif|webp))(?=$|[\s"'`()<>\],;:!?]|\.(?:$|\s))""",
    RegexOption.IGNORE_CASE,
)

private val recordingPattern = Regex(
    """(?:^|[\s"'`(<>\[=:])(/[^\s"'`()<>]*/browser(?:-dev)?/recordings/[^/\s"'`()<>]+/[^/\s"'`()<>]+\.mp4)""",
    RegexOption.MULTILINE,
)

/** Each line, and whether it is code: inside a fence, or the fence itself. */
private fun fencedLines(text: String): List<Pair<String, Boolean>> {
    var fenced = false
    return text.split("\n").map { line ->
        if (line.trim().startsWith("```")) { fenced = !fenced; line to true } else line to fenced
    }
}

/** Every image path a message names outside code, once each. One written as a markdown image line is left out: that block draws it. */
fun imagePaths(text: String): List<String> {
    val seen = markdownBlocks(text).mapNotNull { (it as? MdBlock.Image)?.url }.toMutableSet()
    return fencedLines(text).filter { !it.second }
        .flatMap { (line, _) -> imagePattern.findAll(line).map { it.groupValues[1] }.toList() }
        .filter { seen.add(it) }
}

/** Every browser recording a message names, once each, in order. */
fun recordingPaths(text: String): List<String> {
    val seen = mutableSetOf<String>()
    return recordingPattern.findAll(text).map { it.groupValues[1] }.filter { seen.add(it) }.toList()
}

private val linkOrImage = Regex("""!?\[[^\]]*]\(<?([^)\s>]+)>?(?:\s+"[^"]*")?\)""")
private val codeSpan = Regex("""`([^`]+)`""")
private val barePath = Regex("""(^|[\s"'(<>\[=:])(/[^\s"'`()<>]*[^\s"'`()<>\].,;:!?])(?=$|[\s"'`()<>\],;:!?]|\.(?:$|\s))""")

/** `line` with `change` run on what sits outside its code spans. A span with more than the path in it is a command, and taking the path out breaks it (#1487). */
private fun outsideCodeSpans(line: String, change: (String) -> String): String {
    val out = StringBuilder()
    var at = 0
    for (span in codeSpan.findAll(line)) {
        out.append(change(line.substring(at, span.range.first))).append(span.value)
        at = span.range.last + 1
    }
    return out.append(change(line.substring(at))).toString()
}

/**
 * The text with `paths` taken out — bare, in a code span, or as a markdown link or image —
 * since the picture or player drawn for each names it already. A line left with no words goes.
 */
fun hiding(paths: List<String>, text: String): String {
    if (paths.isEmpty()) return text
    val named = paths.toSet()
    return fencedLines(text).mapNotNull { (original, code) ->
        if (code || imageLine.matches(original.trim())) return@mapNotNull original
        val out = original
            .replace(linkOrImage) { if (it.groupValues[1] in named) "" else it.value }
            .replace(codeSpan) { if (it.groupValues[1] in named) "" else it.value }
            .let { line -> outsideCodeSpans(line) { it.replace(barePath) { m -> if (m.groupValues[2] in named) m.groupValues[1] else m.value } } }
        if (out == original) return@mapNotNull out
        if (out.none { it.isLetterOrDigit() }) return@mapNotNull null
        // Indent is left alone: a list item's nesting reads off it.
        out.replace(Regex(""" +([.,;:!?])"""), "$1")
            // `[:` opens a POSIX class to Android's ICU, which throws; the escape keeps it a colon.
            .replace(Regex("""([\:,;])[.,;:]+"""), "$1")
            .replace(Regex("""(\S) {2,}"""), "$1 ")
            .replace(Regex(""" +$"""), "")
    }.joinToString("\n")
}
