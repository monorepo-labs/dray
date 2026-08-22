/// Splits a prompt into the runs that get a colour: the leading slash command,
/// and every `@file` mention.
///
/// One function rather than two, and one place rather than two, because it has
/// two consumers that must not disagree: the overlay painted over the composer's
/// textarea, and the same text echoed back into the transcript. Colouring a word
/// while typing that goes plain once sent — or the reverse — reads as a bug in
/// whichever surface the reader noticed second.
import { parseSlashCommand } from "@/lib/slash";

export type Segment = {
  kind: "text" | "command" | "mention";
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
};

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
    if (text[i] !== "@") continue;
    // Must open a word, which is what keeps an email address plain. Note this
    // also holds at `i === plainFrom` right after a command, where the previous
    // character is the last of the command name rather than a space.
    if (i > 0 && !SPACE.test(text[i - 1])) continue;

    let end = i + 1;
    while (end < text.length && !SPACE.test(text[end])) end += 1;

    // A lone `@` is someone starting to type, not a mention. Left plain so the
    // colour arrives with the path rather than flashing on the `@` itself.
    if (end === i + 1) continue;

    if (i > plainFrom) segments.push({ kind: "text", text: text.slice(plainFrom, i) });
    segments.push({ kind: "mention", text: text.slice(i, end) });

    plainFrom = end;
    i = end - 1;
  }

  if (plainFrom < text.length) {
    segments.push({ kind: "text", text: text.slice(plainFrom) });
  }

  return segments;
}
