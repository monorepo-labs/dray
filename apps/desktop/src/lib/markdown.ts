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
/// checkable rather than asserted.
export function splitMarkdownSections(text: string): string[] {
  const sections: string[] = [];
  let current: string[] = [];
  let fence: string | null = null;

  for (const line of text.split("\n")) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];

    if (fence) {
      // Closed only by its own character, and only by at least as many of them.
      if (marker && marker[0] === fence[0] && marker.length >= fence.length) fence = null;
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
