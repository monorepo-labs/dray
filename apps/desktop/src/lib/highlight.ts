/// Splits a prompt into the runs that get a colour — the leading slash command,
/// every `@file` mention, issue tag and URL — and the inline marks a sentence
/// carries: bold, italic, code, strikethrough and links.
///
/// Markdown lives here rather than in the `Markdown` component because a prompt
/// bubble draws *inline* marks only, and there is no way to ask a block parser
/// for that: a heading, a bullet or a fence typed into a prompt has to stay the
/// literal text it was typed as, and a single newline has to stay a newline
/// where markdown would fold it into a paragraph. One scanner also keeps a
/// mention findable beside a mark, which two passes over the same string could
/// not promise.
///
/// One function rather than two, and one place rather than two, because it has
/// two consumers that must not disagree: the overlay painted over the composer's
/// textarea, and the same text echoed back into the transcript. Colouring a word
/// while typing that goes plain once sent — or the reverse — reads as a bug in
/// whichever surface the reader noticed second.
import { findPromptPaths } from "@/lib/filePath";
import { OPENERS, parseIdentifier } from "@/lib/issue";
import { parseSlashCommand } from "@/lib/slash";

export type Segment = {
  kind:
    | "text"
    | "command"
    | "mention"
    | "issue"
    | "url"
    | "strong"
    | "em"
    | "code"
    | "strike"
    | "link"
    | "path";
  text: string;
  /// What sits between an inline mark's delimiters, for the surface that draws
  /// the mark rather than the markup. `text` keeps the delimiters, which is what
  /// preserves the round trip the composer's overlay is laid out by.
  inner?: string;
  /// Where a markdown link points. `http(s)` only, the same bar `urlAt` takes.
  href?: string;
};

/// What each run is painted, kept here with the rule that produces it so the
/// composer and the transcript cannot colour the same word differently. Plain
/// text takes no class at all — it inherits, which is what lets the composer's
/// overlay and the message bubble sit on different backgrounds.
export const SEGMENT_COLOR: Record<Segment["kind"], string> = {
  text: "",
  command: "text-accent-command",
  mention: "text-accent-mention",
  issue: "text-accent-issue",
  // Underlined and nothing else: a URL is already its own colour of word,
  // and it must read the same in the composer, where it is only text.
  url: "underline decoration-muted-foreground underline-offset-2",
  // An inline mark takes no class here, and that is the rule rather than an
  // omission: the composer paints this over a textarea that still lays out the
  // delimiters, so bolding or shrinking a run would slide every glyph after it
  // out of register. The transcript draws the mark and drops the delimiters,
  // the same divergence `splitMention` already makes and for the same reason.
  strong: "",
  em: "",
  code: "",
  strike: "",
  link: "",
  // A bare path is the same thing a mention is — a file to open — so it takes
  // the same colour rather than inventing a second one for one idea.
  path: "text-accent-mention",
};

/// Punctuation a sentence puts after a URL, not in it. A closing paren stays
/// only where the URL opened one, as Wikipedia's do.
const URL_TAIL = /[.,;:!?'"»›]+$/;

/// The URL a run of non-space characters starting at `text[i]` holds, or
/// `null`. Only `http(s)://` — a bare `example.com` is a word until proven
/// otherwise, and the cost of a miss is one un-clickable link.
function urlAt(text: string, i: number): string | null {
  if (!/^https?:\/\/\S/i.test(text.slice(i, i + 9))) return null;
  let end = i;
  while (end < text.length && !SPACE.test(text[end])) end += 1;
  let url = text.slice(i, end).replace(URL_TAIL, "");
  while (url.endsWith(")") && (url.match(/\(/g) ?? []).length < (url.match(/\)/g) ?? []).length) {
    url = url.slice(0, -1);
  }
  return url;
}

/// A mention split into the part worth reading and the part that is only there
/// to disambiguate it.
///
/// The two surfaces use this differently *because they have to*, and that is the
/// one place they legitimately diverge. The transcript draws `name` alone — a
/// deep path is most of a line and says little the filename doesn't. The
/// composer can't: its overlay is painted over a textarea that still lays out
/// the full string, so dropping characters would slide the caret, the selection
/// band, and everything after the mention out of register. It dims `dir`
/// instead, which reaches the same reading order without touching a glyph.
///
/// `dir` keeps the leading `@` and the trailing slash, so `dir + name` is the
/// segment back exactly — the property the overlay depends on.
export function splitMention(text: string): { dir: string; name: string } {
  const cut = text.lastIndexOf("/");
  if (cut === -1) return { dir: "@", name: text.slice(1) };

  return { dir: text.slice(0, cut + 1), name: text.slice(cut + 1) };
}

/// A literal `\n` — the backslash and the letter, not a line break — turned
/// into the break it was meant to be.
///
/// A **render** concern, and the composer must never reach it: an overlay that
/// dropped a character would slide every glyph after it out of register, and
/// what the reader typed is what the textarea has to keep holding.
///
/// The sender is why this exists. An agent relaying through `dray send` writes
/// its message inside a shell string, where `\n` is left uninterpreted, so the
/// two characters arrive verbatim and the whole report drew as one paragraph.
/// Applied before anything is segmented, so a mark cannot span the break and a
/// path scan sees the same whitespace the reader does.
export function withLineBreaks(text: string): string {
  return text.replace(/\\n/g, "\n");
}

/// The same runs with every bare path in the plain text pulled out as its own.
///
/// A pass over the finished segments rather than another case in the scanner,
/// for two reasons. A path has no opening character to key on — it is known by
/// its shape, which `findPromptPaths` decides — and this must not reach the
/// composer, where a path colouring itself mid-word while the reader is still
/// typing it is noise rather than help.
///
/// Only `text` runs are searched, so a path already inside a mention, a URL or
/// a code span is left exactly where it is. Slices come off the run itself
/// rather than from the match's own `path`, which is what keeps the round trip
/// exact even where the two could differ.
export function withPaths(segments: Segment[]): Segment[] {
  const out: Segment[] = [];

  for (const segment of segments) {
    if (segment.kind !== "text") {
      out.push(segment);
      continue;
    }

    let at = 0;
    for (const { start, end } of findPromptPaths(segment.text)) {
      if (start > at) out.push({ kind: "text", text: segment.text.slice(at, start) });
      out.push({ kind: "path", text: segment.text.slice(start, end) });
      at = end;
    }

    if (at < segment.text.length) out.push({ kind: "text", text: segment.text.slice(at) });
  }

  return out;
}

const SPACE = /\s/;

/// Emphasis delimiters, longest first so `**` reads as bold rather than as two
/// empty italics, and `~~` before a lone `~`, which opens nothing.
const MARKS: [string, Segment["kind"]][] = [
  ["**", "strong"],
  ["__", "strong"],
  ["~~", "strike"],
  ["*", "em"],
  ["_", "em"],
];

/// Every character that could open an inline mark, so the scanner skips the
/// ordinary ones in a single test.
const MARK_OPENERS = new Set(["*", "_", "~", "`", "["]);

/// What the scanner has already proved absent, keyed by the delimiter it looked
/// for and holding the index its failed search reached.
///
/// Every one of these searches runs forward to the end of the line or the end of
/// the text, so a search that found nothing before that point cannot be helped
/// by starting later — a later opener's span is a subset of the one that already
/// failed. Without the memo each unpaired opener re-scans the whole remainder:
/// 72k characters shaped as `*a *a *a` took 8.1s, and this runs on every
/// keystroke in the composer.
type Exhausted = Map<string, number>;

/// Where the line holding `from` ends, which is how far a mark may reach.
function lineEnd(text: string, from: number): number {
  const nl = text.indexOf("\n", from);
  return nl === -1 ? text.length : nl;
}

/// Where `mark` closes the run opened at `from`, or `-1`.
///
/// Written to under-match, the reading `findFilePaths` takes: a closing
/// delimiter cannot follow a space, since `a * b * c` is arithmetic rather than
/// emphasis, and a run cannot cross a line — an unpaired `*` would otherwise
/// reach down the message and emphasize half of it.
function closeIndex(text: string, mark: string, from: number): number {
  for (let j = from + 1; j < text.length; j += 1) {
    if (text[j] === "\n") return -1;
    if (!text.startsWith(mark, j) || SPACE.test(text[j - 1])) continue;

    // A one-character delimiter must not close on half of a doubled one, or
    // `Use *args, **kwargs` — an ordinary thing to type — reads as an italic
    // `args, *` with `kwargs` left outside it.
    if (mark.length === 1 && (text[j - 1] === mark || text[j + 1] === mark)) continue;

    return j;
  }
  return -1;
}

/// The inline mark opening at `text[i]`, or `null`.
///
/// Only what a sentence holds — emphasis, code, strikethrough, links. A block
/// construct is deliberately not read: a heading, a bullet or a fence stays the
/// literal text it was typed as, because a prompt is one person's sentence and
/// the bubble drawing it is not a document.
function inlineAt(text: string, i: number, exhausted: Exhausted): Segment | null {
  // Must open a word, the rule an issue tag already takes. Without it
  // `snake_case_name` is an italic and so is `2 * 3 * 4`, and both are ordinary
  // things to type into a prompt.
  const previous = i > 0 ? text[i - 1] : " ";
  if (!SPACE.test(previous) && !OPENERS.includes(previous)) return null;

  if (text[i] === "`") {
    if (i < (exhausted.get("`") ?? -1)) return null;

    // A single-backtick span only, which is also what keeps a fence literal:
    // the ``` opening one closes against its own second backtick and is
    // refused for holding nothing.
    const close = text.indexOf("`", i + 1);
    if (close === -1) {
      exhausted.set("`", text.length);
      return null;
    }
    if (close === i + 1) return null;

    const inner = text.slice(i + 1, close);
    if (inner.includes("\n")) return null;

    return { kind: "code", text: text.slice(i, close + 1), inner };
  }

  if (text[i] === "[") return linkAt(text, i, exhausted);

  for (const [mark, kind] of MARKS) {
    if (!text.startsWith(mark, i)) continue;
    if (i < (exhausted.get(mark) ?? -1)) continue;

    const from = i + mark.length;
    // The content has to start straight away, or a list bullet — `* ` at the
    // head of a line — opens an italic reaching the next `*` in the message.
    if (from >= text.length || SPACE.test(text[from])) continue;

    const close = closeIndex(text, mark, from);
    if (close === -1) {
      exhausted.set(mark, lineEnd(text, from));
      continue;
    }

    return { kind, text: text.slice(i, close + mark.length), inner: text.slice(from, close) };
  }

  return null;
}

/// The `[label](href)` opening at `text[i]`, or `null`.
///
/// `http(s)` only, the bar `urlAt` holds: a link is a thing that opens in a
/// browser, so a `mailto:` or a relative path stays the text it was typed as
/// rather than becoming a button that goes nowhere.
function linkAt(text: string, i: number, exhausted: Exhausted): Segment | null {
  if (i < (exhausted.get("]") ?? -1)) return null;

  // A link does not span a line, so the label is looked for on this one only.
  // That bound is also what makes the memo below sound: every rejection past it
  // is settled by the label and the href, and an opener sharing this line
  // resolves both to exactly the same pair.
  //
  // Testing the *run* for a break instead was the bug this replaces. That test
  // reads `i`, so caching it suppressed the openers between here and the label
  // — whose runs are shorter and may hold no break at all — and
  // `[bad⏎newline [good](https://example.com)` lost its real link.
  const bound = lineEnd(text, i);
  const label = text.indexOf("]", i + 1);
  if (label === -1 || label > bound) {
    exhausted.set("]", bound);
    return null;
  }

  const spent = () => {
    exhausted.set("]", label + 1);
    return null;
  };

  if (text[label + 1] !== "(") return spent();

  const close = hrefEnd(text, label + 2);
  if (close === -1 || close === label + 2) return spent();

  const href = text.slice(label + 2, close);
  if (!/^https?:\/\//i.test(href)) return spent();

  // Last, and never memoized: the empty label is the one test that reads the
  // opener's own position rather than the label and href both.
  if (label === i + 1) return null;

  return {
    kind: "link",
    text: text.slice(i, close + 1),
    inner: text.slice(i + 1, label),
    href,
  };
}

/// The `)` closing an href opened at `from`, or `-1`.
///
/// Parens inside the URL are balanced rather than stopped at, the same reading
/// `urlAt` takes of a bare one: Wikipedia's own links carry a pair, and stopping
/// at the first `)` links to a truncated URL while leaving the rest as prose —
/// a wrong link that looks exactly like a right one.
function hrefEnd(text: string, from: number): number {
  let depth = 0;

  for (let j = from; j < text.length; j += 1) {
    const c = text[j];
    if (c === "\n") return -1;
    if (c === "(") depth += 1;
    else if (c === ")") {
      if (depth === 0) return j;
      depth -= 1;
    }
  }

  return -1;
}

/// The runs of `text` in order. Concatenating them returns `text` exactly —
/// which is what lets the overlay use this without the glyphs drifting out of
/// register with the textarea underneath.
export function highlightSegments(text: string): Segment[] {
  const segments: Segment[] = [];
  // Per call, not module-level: it describes this string and nothing else.
  const exhausted: Exhausted = new Map();
  let plainFrom = 0;
  let i = 0;

  // The command is matched only at the start, by the same parse the transcript
  // and the picker use — a slash mid-sentence is a path separator.
  const command = parseSlashCommand(text);
  if (command) {
    segments.push({ kind: "command", text: `/${command.name}` });
    i = command.name.length + 1;
    plainFrom = i;
  }

  for (; i < text.length; i += 1) {
    const opener = text[i];
    if (opener === "h" && (i === 0 || SPACE.test(text[i - 1]) || OPENERS.includes(text[i - 1]))) {
      const url = urlAt(text, i);
      if (!url) continue;
      if (i > plainFrom) segments.push({ kind: "text", text: text.slice(plainFrom, i) });
      segments.push({ kind: "url", text: url });
      plainFrom = i + url.length;
      i = plainFrom - 1;
      continue;
    }
    if (MARK_OPENERS.has(opener)) {
      const mark = inlineAt(text, i, exhausted);
      if (!mark) continue;

      if (i > plainFrom) segments.push({ kind: "text", text: text.slice(plainFrom, i) });
      segments.push(mark);
      plainFrom = i + mark.text.length;
      i = plainFrom - 1;
      continue;
    }

    if (opener !== "@" && opener !== "#") continue;
    // Must open a word, which is what keeps an email address and a `#fff`
    // colour plain. Note this also holds at `i === plainFrom` right after a
    // command, where the previous character is the last of the command name
    // rather than a space.
    //
    // Bracketing punctuation counts as opening one — `(#DRA-53)` is a tag in a
    // sentence — and only for a tag, because that is the rule the backend
    // links by. A mention is left as strict as it was: the CLI parses `@path`
    // out of the prompt itself, so widening it here would paint mentions the
    // harness will not read.
    const previous = i > 0 ? text[i - 1] : " ";
    const opensWord =
      SPACE.test(previous) || (opener === "#" && OPENERS.includes(previous));
    if (!opensWord) continue;

    let end = i + 1;
    while (end < text.length && !SPACE.test(text[end])) end += 1;

    // A lone `@` is someone starting to type, not a mention. Left plain so the
    // colour arrives with the path rather than flashing on the `@` itself.
    if (end === i + 1) continue;

    let kind: Segment["kind"];
    let stop = end;

    if (opener === "@") {
      kind = "mention";
    } else {
      // A tag is coloured only where it is a real identifier, because that is
      // exactly what will be linked — `#fff` at the start of a line, or a
      // markdown heading's word, must read as the prose they are. The scan
      // stops at the number's end rather than the token's, so the comma in
      // `#DRA-53,` stays plain like the sentence it belongs to.
      const identifier = parseIdentifier(text.slice(i + 1, end));
      if (!identifier) continue;

      kind = "issue";
      stop = i + 1 + identifier.length;
    }

    if (i > plainFrom) segments.push({ kind: "text", text: text.slice(plainFrom, i) });
    segments.push({ kind, text: text.slice(i, stop) });

    plainFrom = stop;
    i = stop - 1;
  }

  if (plainFrom < text.length) {
    segments.push({ kind: "text", text: text.slice(plainFrom) });
  }

  return segments;
}
