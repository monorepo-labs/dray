/// Whether this path is one the Docs panel can render.
///
/// `.mdx` is deliberately out. It is JSX inside markdown, and Streamdown has no
/// idea what a component is — a `<Callout>` would be drawn as prose or dropped
/// by the sanitizer, so the panel would show a confidently wrong version of the
/// file. It goes to the external editor with everything else.
export function isMarkdownPath(path: string): boolean {
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  return name.endsWith(".md") || name.endsWith(".markdown");
}

/// How many sections the panel draws on its first commit, and how many it adds
/// per deferred step after that.
///
/// Two is a screenful of prose at any height this app runs at, and a step of
/// two keeps each one to a few tens of milliseconds — the point is that the
/// main thread comes back between steps, not that the total gets smaller.
export const FIRST_SECTIONS = 2;
export const SECTION_STEP = 2;

/// The document cut at its top-level headings, in order.
///
/// Rendering a long file in one commit is what made this panel take seconds to
/// open: a 282KB document measured at 930ms of parsing alone, before any of the
/// 608KB of HTML it produces reached the DOM. Cut into sections, the top is on
/// screen at once and the rest mounts behind it.
///
/// A heading is the cut because an unindented ATX heading terminates every open
/// block before it — paragraph, list, blockquote — so stacking the pieces draws
/// what one render of the whole would. A blank line looks like the easier cut
/// and is not one: a list with blank lines between its items would come apart
/// into one list per item.
///
/// Fenced code is skipped, or the `#` on a comment inside a bash block would
/// cut the file mid-fence and leave both halves unparseable.
///
/// Joining the result with a newline gives the input back exactly, which is the
/// property worth holding on to — it is what makes "the pieces draw the whole"
/// checkable rather than asserted. It is not sufficient on its own, though:
/// concatenating to the input says the *text* survived, not that parsing the
/// pieces separately means what parsing the whole meant. `isSplittable` is
/// where that second half lives.
export function splitMarkdownSections(text: string): string[] {
  if (!isSplittable(text)) return [text];

  const sections: string[] = [];
  let current: string[] = [];
  let fence: string | null = null;

  for (const line of text.split("\n")) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];

    if (fence) {
      // Closed only by its own character, by at least as many of them, and by
      // nothing else on the line: a closing fence takes no info string, so
      // ```` ```not-a-close ```` opens a nested-looking block rather than
      // ending this one. Reading it as a close put the rest of the fence back
      // in play and cut the file at the next `#` inside it.
      if (marker && marker[0] === fence[0] && marker.length >= fence.length) {
        if (!line.slice(line.indexOf(marker) + marker.length).trim()) fence = null;
      }
    } else if (marker) {
      fence = marker;
    } else if (/^#{1,6}(\s|$)/.test(line) && current.length) {
      sections.push(current.join("\n"));
      current = [];
    }

    current.push(line);
  }

  sections.push(current.join("\n"));
  return sections;
}

/// Whether cutting this document at its headings draws what one render would.
///
/// A heading ends every open *block*, which is what makes it a safe cut — but
/// two things in markdown reach across one, and a section parsed alone cannot
/// see them:
///
/// - **A link reference definition.** `[text][ref]` resolves against a
///   `[ref]: url` line that may sit under a later heading, and in its own
///   section the link falls back to literal text.
/// - **An HTML block.** It runs until a blank line rather than until a heading,
///   so a `#` inside one is part of it, and cutting there leaves an unclosed
///   tag in one piece and an orphaned one in the next.
///
/// Front matter goes with them: a `---` at the top of the file is a block this
/// splitter has no concept of at all.
///
/// So the answer is the whole document's, not the section's — one construct
/// anywhere means the file renders in one commit. Slow is the safe side to be
/// wrong on here, and both tests are deliberately loose: an autolink alone on a
/// line reads as an HTML block by this rule and costs nothing but speed, where
/// missing a real one costs a wrong render.
function isSplittable(text: string): boolean {
  if (/^---\s*$/.test(text.split("\n", 1)[0] ?? "")) return false;

  let fence: string | null = null;
  for (const line of text.split("\n")) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence) {
      if (
        marker &&
        marker[0] === fence[0] &&
        marker.length >= fence.length &&
        !line.slice(line.indexOf(marker) + marker.length).trim()
      ) {
        fence = null;
      }
      continue;
    }
    if (marker) {
      fence = marker;
      continue;
    }
    if (/^ {0,3}\[[^\]]*\]:/.test(line)) return false;
    if (/^ {0,3}</.test(line)) return false;
  }

  return true;
}
