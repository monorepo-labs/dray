/// What the composer draws as an atomic chip, and how its text maps onto the
/// DOM that draws it.
///
/// **The composer still holds a plain string.** It is the same string
/// [`highlightSegments`] parses, the same one `useDraft` keys by session and the
/// same one that crosses the bridge — none of that moves. What moves is only how
/// it is *drawn*: a `contenteditable` whose placed tags are `contenteditable=false`
/// spans, where a `<textarea>` could only ever show its value character for
/// character.
///
/// That tie is the whole reason the old overlay existed — a second copy of the
/// text painted over transparent glyphs, held in register by a shared padding
/// constant — and the reason `&Title (uuid)` put 36 characters of address in the
/// reader's sentence. Breaking it is the point of this file.
///
/// So the one property everything here rests on: **reading the tree back yields
/// the string that built it, exactly.** A chip shortens its *label* and never its
/// `data-tag`, which is what [`readValue`] reads. Anything that breaks that shows
/// up as a prompt sending different words than the reader typed.
///
/// [`highlightSegments`]: ./highlight.ts
import { fileIconSrc } from "@/lib/fileIcon";
import { issueFace, splitMention, withIssueTitles } from "@/lib/highlight";
import type { Segment } from "@/lib/highlight";
import { placedIssueTitle } from "@/lib/issue";

/// Where a chip keeps the run it stands for. Read back verbatim, so this is the
/// attribute the round trip depends on.
export const TAG_ATTR = "data-tag";

/// A break the browser needs to show a trailing newline and that carries no
/// text of its own. A `pre-wrap` box does not render the last `\n` in its
/// content, so pressing ⇧⏎ at the end would move the caret nowhere visible
/// without one — and reading it back as a newline would grow the value by one
/// character on every render.
export const FILLER_ATTR = "data-filler";

/// The three runs drawn as chips.
///
/// `command` is deliberately absent: `/caveman` is already the short form of
/// itself, so a chip there would buy only whole-token deletion and cost the
/// reader the ability to edit the name they are half-way through typing. URLs,
/// bare paths and inline markdown marks are absent for a plainer reason — the
/// reader typed those as prose rather than picking them off a menu, and there is
/// nothing hidden behind them to stand for.
const CHIP_KINDS = new Set<Segment["kind"]>(["mention", "session", "issue"]);

/// How much of an issue's title a chip shows before it gives up and elides.
///
/// A title is somebody else's sentence and can be any length, where the other
/// two faces are bounded by what they name — a filename, a session title the
/// reader chose. Elided in code rather than by `truncate`, because CSS
/// truncation needs `overflow: hidden`, and that moves an inline-block's
/// baseline to its bottom edge and drops the chip below the line it sits on.
const ISSUE_LABEL_MAX = 28;

function elide(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/// What a chip says on its face, or `null` where the segment is not one.
///
/// Every one of these is *shorter* than the run it stands for, which is the
/// feature: the full run stays in `data-tag` and in the prompt that gets sent.
///
/// - a mention keeps its filename and drops the `@` — the file glyph beside it
///   says it is a file, and says which kind, which the sigil never did;
/// - a session tag keeps its title, dropping the uuid that made it addressable —
///   the reader picked a row off a menu and never wanted to read an address;
/// - an issue tag keeps the `#` and swaps the identifier for the **title**,
///   elided. `DRA-269` is the half a reader cannot read anything off; the words
///   are why they picked that row. The identifier stands in where no title was
///   written, which is what a hand-typed tag is.
export function chipLabel(segment: Segment): string | null {
  if (!CHIP_KINDS.has(segment.kind)) return null;

  switch (segment.kind) {
    case "mention":
      return splitMention(segment.text).name;
    // `inner` is the sigil-and-identifier half on both of these, so the split
    // is made once by whoever built the segment rather than the parser being
    // asked for a third spelling of the same tag.
    case "session":
      return segment.inner ? segment.inner.slice(1) : segment.text.slice(1);
    default:
      return elide(issueFace(segment), ISSUE_LABEL_MAX + 1);
  }
}

/// One run, placed, and whether it is drawn as a chip.
export type Placed = {
  segment: Segment;
  /// Index into the whole string. The DOM is built in this order, so this is
  /// also what `locate` counts up to.
  start: number;
  /// The chip's face. `null` draws the run as text, coloured as before.
  label: string | null;
  /// The glyph drawn before the face, where the kind has one. Files alone: the
  /// mark carries the file's *type*, which is the one thing about a mention its
  /// filename may not say.
  icon: string | null;
};

/// The segments with their offsets, and the chip decision made for each.
///
/// **A tag chips only once the word is finished and the caret has left it.**
/// That rule is what keeps the caret still: `@s` is already a mention to the
/// parser, so chipping on the parser's word alone would rebuild the DOM under
/// the reader on every keystroke of a path — which is the exact fragility the
/// overlay had and the reason it is being replaced. Waiting until the caret is
/// strictly outside the run means the rebuild lands once, on the keystroke that
/// leaves it, and never while the run is being typed.
///
/// A caret *at* either edge counts as still being in it. The end edge is the
/// one that matters: it is where the caret sits for every character of a tag
/// being typed, so treating it as outside would chip on every one of them.
///
/// `caret` of `null` means nothing is focused here, and everything chips — a
/// blurred composer has no run being edited.
export function placeSegments(segments: Segment[], caret: number | null): Placed[] {
  const placed: Placed[] = [];
  let start = 0;

  for (const segment of withIssueTitles(segments, placedIssueTitle)) {
    const end = start + segment.text.length;
    const editing = caret !== null && caret >= start && caret <= end;
    const label = editing ? null : chipLabel(segment);

    placed.push({
      segment,
      start,
      label,
      icon: label !== null && segment.kind === "mention" ? fileIconSrc(segment.text.slice(1)) : null,
    });

    start = end;
  }

  return placed;
}

/// Whether two renderings would produce a different tree.
///
/// The composer is uncontrolled while ordinary prose is typed — the browser owns
/// the DOM and React never writes to it — so the only question asked on each
/// keystroke is whether the *chips* moved. Ordinary typing answers no and the
/// tree is left exactly as the browser left it, caret and undo stack included.
///
/// Compared on the chips alone rather than on the whole segment list: a text run
/// growing by a character is the common case and must not count, where a chip
/// appearing, vanishing or changing its face is precisely when the tree has to
/// be rebuilt.
export function chipSignature(placed: Placed[]): string {
  return placed
    .filter((p) => p.label !== null)
    .map((p) => `${p.start}:${p.segment.text.length}:${p.label}`)
    .join("\u0000");
}
