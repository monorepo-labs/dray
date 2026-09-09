/// Carrying a markdown list marker onto the next line, the way every editor
/// does it — the one piece of markdown the composer has to *know* about, since
/// a textarea will happily let the reader retype `- ` on every line.
///
/// Caret arithmetic and nothing else, so it sits beside `slash.ts` and
/// `mention.ts` rather than in the composer: the rules are worth a test and the
/// component is not testable here.

/// A list item at the caret's line: indent, marker, the gap after it, and
/// whatever body has been typed so far. `[ \t]` rather than `\s`, or the class
/// eats the newline that ends the line above.
const ITEM = /^([ \t]*)([-*+]|\d+[.)])([ \t]+)(.*)$/;

/// The numbered half of `ITEM`, for the lines below the one being edited.
const ORDERED = /^([ \t]*)(\d+)[.)][ \t]+/;

/// The lines from `from` on, renumbered from `next` while they stay in the same
/// list — same indent, one after another. A deeper item is a nested list and is
/// stepped over untouched; anything else ends the list. Without this an item
/// added in the middle leaves two `2.`s, which markdown renders fine and the
/// reader does not.
function renumber(text: string, from: number, indent: string, next: number): string {
  const lines = text.slice(from).split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const match = ORDERED.exec(lines[i]);
    if (!match) break;
    if (match[1].length > indent.length) continue;
    if (match[1] !== indent) break;
    lines[i] = `${indent}${next}${lines[i].slice(match[1].length + match[2].length)}`;
    next += 1;
  }
  return text.slice(0, from) + lines.join("\n");
}

/// Where the line after `at` begins, or the text's end when there is none.
function nextLine(text: string, at: number): number {
  const cut = text.indexOf("\n", at);
  return cut === -1 ? text.length : cut + 1;
}

/// What the newline about to be inserted should produce, or `null` where the
/// caret is not in a list and the textarea's own newline is right.
///
/// Two answers, and the second is why this can't be a prefix-only insert: an
/// item with nothing typed in it is the reader leaving the list, so the marker
/// is *taken back off* and no line is added. Ending a list otherwise means
/// deleting a bullet the app just wrote, which is the thing the feature exists
/// to stop.
///
/// The body is read up to the caret alone, so splitting an item mid-word
/// carries the marker and leaves the rest of the line under it — same as
/// pressing Return in the middle of any other list.
export function continueList(text: string, caret: number): { text: string; caret: number } | null {
  const start = text.lastIndexOf("\n", caret - 1) + 1;
  const match = ITEM.exec(text.slice(start, caret));
  if (!match) return null;

  const [, indent, marker, gap, body] = match;
  const digits = /^(\d+)([.)])$/.exec(marker);
  const number = digits ? Number(digits[1]) : 0;

  // Only where the rest of the line is empty too — a caret parked at `- |item`
  // is someone editing, not someone finishing.
  const rest = text.slice(caret);
  if (!body && (rest === "" || rest.startsWith("\n"))) {
    let out = text.slice(0, start) + rest;
    if (digits) out = renumber(out, nextLine(out, start), indent, number);
    return { text: out, caret: start };
  }

  const next = digits ? `${number + 1}${digits[2]}` : marker;
  const insert = `\n${indent}${next}${gap}`;
  let out = text.slice(0, caret) + insert + rest;
  if (digits) out = renumber(out, nextLine(out, caret + insert.length), indent, number + 2);

  return { text: out, caret: caret + insert.length };
}
