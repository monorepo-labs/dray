/// Splits a prompt into the runs that get a colour: the leading slash command,
/// and every `@file` mention.
///
/// One function rather than two, and one place rather than two, because it has
/// two consumers that must not disagree: the overlay painted over the composer's
/// textarea, and the same text echoed back into the transcript. Colouring a word
/// while typing that goes plain once sent — or the reverse — reads as a bug in
/// whichever surface the reader noticed second.
import { OPENERS, parseIdentifier } from "@/lib/issue";
import { parseSlashCommand } from "@/lib/slash";

type Segment = {
  kind: "text" | "command" | "mention" | "issue" | "url";
  text: string;
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

const SPACE = /\s/;

/// The runs of `text` in order. Concatenating them returns `text` exactly —
/// which is what lets the overlay use this without the glyphs drifting out of
/// register with the textarea underneath.
export function highlightSegments(text: string): Segment[] {
  const segments: Segment[] = [];
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
