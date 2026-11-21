package com.yogesh.dray

import com.yogesh.dray.model.DiffRow
import com.yogesh.dray.model.DiffRow.Line
import com.yogesh.dray.model.DiffRow.NoNewline
import com.yogesh.dray.model.FileIconMap
import com.yogesh.dray.model.MergeVerdict
import com.yogesh.dray.model.PrUnavailable
import com.yogesh.dray.model.commentText
import com.yogesh.dray.model.mergeVerdict
import com.yogesh.dray.model.sessionBranch
import com.yogesh.dray.model.unifiedDiff
import com.yogesh.dray.wire.DrayError
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/** ChangesTests.swift and PrTests.swift, case for case. */
class ChangesTest {
    @Test fun unifiedDiffFoldsUnchangedLines() {
        val old = (1..20).joinToString("\n") { "l$it" } + "\n"
        val new = old.replace("l10\n", "ten\n") + "l21\n"
        val rows = unifiedDiff(old, new, context = 2)
        assertEquals(DiffRow.Gap(7), rows.first())
        assertTrue(Line('-', 10, "l10") in rows)
        assertTrue(Line('+', 10, "ten") in rows)
        assertEquals(Line('+', 21, "l21"), rows.last())
        assertEquals(listOf(Line('+', 1, "a"), Line('+', 2, "b"), NoNewline), unifiedDiff(null, "a\nb"))
        assertEquals(emptyList<DiffRow>(), unifiedDiff("same", "same"))
    }

    /** Adding or dropping the final newline is a change, said the way git says it. */
    @Test fun finalNewlineIsAChange() {
        assertEquals(listOf(Line(' ', 1, "a"), Line('-', 2, "b"), Line('+', 2, "b"), NoNewline), unifiedDiff("a\nb\n", "a\nb"))
        assertEquals(listOf(Line(' ', 1, "a"), Line('-', 2, "b"), NoNewline, Line('+', 2, "b")), unifiedDiff("a\nb", "a\nb\n"))
        assertEquals(emptyList<DiffRow>(), unifiedDiff("a", "a"))
    }

    /** Windows line endings split per line and keep their CR, so CRLF to LF is a change too. */
    @Test fun crlfSplitsPerLine() {
        val old = "a\r\nb\r\nc\r\n"
        assertEquals(listOf(Line(' ', 1, "a\r"), Line('-', 2, "b\r"), Line('+', 2, "B\r"), Line(' ', 3, "c\r")), unifiedDiff(old, "a\r\nB\r\nc\r\n"))
        assertEquals(
            listOf(Line(' ', 1, "a\r"), Line(' ', 2, "b\r"), Line('-', 3, "c\r"), Line('+', 3, "c"), NoNewline),
            unifiedDiff(old, "a\r\nb\r\nc"),
        )
        assertEquals(listOf(Line('-', 1, "a\r"), Line('+', 1, "a")), unifiedDiff(old, "a\nb\r\nc\r\n").filter { it is Line && it.sign != ' ' })
    }

    /** Edits scattered through a long file each come back alone, not as one block replaced. */
    @Test fun scatteredEditsStayMinimal() {
        val old = (1..500).map { "line $it" }
        val new = old.toMutableList().apply { this[99] = "changed"; removeAt(300); add(450, "inserted") }
        val changed = unifiedDiff(old.joinToString("\n", postfix = "\n"), new.joinToString("\n", postfix = "\n"), context = 0)
            .filterIsInstance<Line>()
        assertEquals(listOf(Line('-', 100, "line 100"), Line('+', 100, "changed"), Line('-', 301, "line 301"), Line('+', 451, "inserted")), changed)
    }

    /** The desktop's picks for the same paths, each an icon the assets hold. */
    @Test fun fileIconsMatchTheDesktop() {
        val assets = File("src/main/assets")
        val map = FileIconMap.parse(File(assets, "file-icons.json").readText())
        val cases = listOf(
            Triple("src/main.ts", false, "typescript"), Triple("package.json", false, "nodejs"),
            Triple("README.md", false, "readme"), Triple("a/b.swift", false, "swift"), Triple("x.unknownext", false, "file"),
            Triple("apps/src", true, "folder-src"), Triple("Dray", true, "folder"), Triple("Main.kt", false, "kotlin"),
        )
        for ((path, folder, want) in cases) {
            assertEquals(path, want, map.name(path, folder))
            assertTrue(want, File(assets, "file-icons/$want.svg").exists())
        }
    }

    private fun verdict(mergeable: String, status: String, state: String = "OPEN", draft: Boolean = false) =
        mergeVerdict(state, draft, mergeable, status)

    /** The readiness order is the logic; each case is one place a reordering would bite. */
    @Test fun readinessOrder() {
        // A closed or merged PR's merge state is stale.
        assertEquals(MergeVerdict.Merged, verdict("CONFLICTING", "DIRTY", state = "MERGED"))
        assertEquals(MergeVerdict.Closed, verdict("MERGEABLE", "CLEAN", state = "CLOSED"))
        // A conflict outranks a draft and an unknown.
        assertEquals(MergeVerdict.Conflict, verdict("CONFLICTING", "UNKNOWN", draft = true))
        assertEquals(MergeVerdict.Conflict, verdict("UNKNOWN", "DIRTY"))
        // A draft is stored, so an UNKNOWN window cannot hide it.
        assertEquals(MergeVerdict.Draft, verdict("UNKNOWN", "UNKNOWN", draft = true))
        // A leftover status is not trusted while GitHub recomputes.
        assertEquals(MergeVerdict.Unknown, verdict("UNKNOWN", "BLOCKED"))
        assertEquals(MergeVerdict.Unknown, verdict("MERGEABLE", "UNKNOWN"))
        assertEquals(MergeVerdict.Behind, verdict("MERGEABLE", "BEHIND"))
        assertEquals(MergeVerdict.Blocked, verdict("MERGEABLE", "BLOCKED"))
        assertEquals(MergeVerdict.Unstable, verdict("MERGEABLE", "UNSTABLE"))
        assertEquals(MergeVerdict.Ready, verdict("MERGEABLE", "CLEAN"))
        assertEquals(MergeVerdict.Ready, verdict("MERGEABLE", "HAS_HOOKS"))
    }

    @Test fun branchOfASession() {
        assertEquals("fix", sessionBranch("main", "a", false, "fix"))
        assertEquals("worktree-a", sessionBranch(null, "a", false, null))
        assertEquals("fix/pr", sessionBranch("fix/pr", "a", false, null))
        assertEquals("main", sessionBranch("main", null, false, null))
        // A relocated session's shared checkout never answers.
        assertEquals("worktree-a", sessionBranch("worktree-a", null, true, "main"))
    }

    @Test fun commentTextKeepsCode() {
        assertEquals("Use `Array<T>` &\n```\n<div>&amp;</div>\n```", commentText("<!-- x --><b>Use</b> `Array<T>` &amp;\n```\n<div>&amp;</div>\n```"))
        assertEquals("Title", commentText("[vc]: #abc `foo`\n<h2>Title</h2>"))
        assertEquals("Shown", commentText("<!-- hidden `state` -->Shown"))
        // Markers inside code are examples, and stay.
        assertEquals("Use `<!-- keep -->`\n```\n[vc]: #abc\n```", commentText("Use `<!-- keep -->`\n```\n[vc]: #abc\n```"))
    }

    @Test fun unavailableReadsTheServersObject() {
        val u = PrUnavailable.from(DrayError("""{"kind":"not_authenticated"}"""))
        assertEquals("not_authenticated", u.kind)
        assertTrue(u.keepsButton)
        assertEquals("Not connected", PrUnavailable.from(DrayError("Not connected")).sentence)
    }
}
