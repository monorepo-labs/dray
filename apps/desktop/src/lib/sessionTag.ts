/// Where the composer's `&` session picker opens, what a pick writes into the
/// text, and how that text is read back out.
///
/// The fourth sibling of [slash.ts], [mention.ts] and [issue.ts], and it is
/// shaped like the last two: a session tag is a word inside a sentence and can
/// appear any number of times, so the caret finds its own token here rather
/// than the token being found once up front.
///
/// **The id is in the text because the id is the address.** `dray send` takes
/// a session id and matches it exactly — there is no prefix or title lookup —
/// so a tag naming a session by title alone would leave the agent running
/// `dray ls` and guessing between two sessions that share one. That is the same
/// bargain [issue.ts] makes by writing the identifier and the title both, and
/// the same one Rust's `attribute` already makes when it prefixes a relayed
/// message with `the Dray session "title" (id)`.
///
/// So nothing crosses the bridge for this: no command, no wire field, no Rust.
/// The picker writes text, the agent reads text.
///
/// [slash.ts]: ./slash.ts
/// [mention.ts]: ./mention.ts
/// [issue.ts]: ./issue.ts
import type { SessionIndexItem } from "@/types/events";

/// The tag token the caret is sitting in.
type SessionSpan = {
  start: number;
  end: number;
  /// Everything after the `&`, to the end of the token — not to the caret, so
  /// backing up to fix a typo filters on the corrected whole.
  query: string;
};

const SPACE = /\s/;

/// A v7 uuid, which is what every session id here is. Spelled out rather than
/// matched loosely because this decides what gets *painted* as a tag, and a
/// word painted as a tag the agent cannot address is the drift worth guarding
/// against — the same rule `parseIdentifier` takes next door.
const ID = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";

/// A whole placed tag, from the `&` to the closing paren.
///
/// **Lazy in the title, so the *first* id closes the tag rather than the last,
/// and that is a deliberate trade rather than an oversight.** Two tags in one
/// sentence is an ordinary prompt — "ask &A (id) and &B (id) to compare" — and
/// a greedy read swallows everything between the first `&` and the last id,
/// taking the second tag into the first one's title and losing it.
///
/// What it costs is the opposite case: a *title* that itself carries a
/// parenthesised id, which a session titled after a prompt holding a tag can
/// have. There the tag paints short and the real id is left beside it as plain
/// text. Cosmetic only — the text is sent untouched, so the agent still reads
/// both ids — where the greedy read loses a tag outright. Both pinned by test.
const TAG = new RegExp(`^&(.+?) \\((${ID})\\)`);

/// The tag being typed, or `null` when the caret isn't in one.
///
/// A bare `&` counts, and opens the list on every session in the project — the
/// same reading the `#` picker takes of a bare `#`.
export function sessionSpan(text: string, caret: number): SessionSpan | null {
  if (caret < 1 || caret > text.length) return null;

  let start = caret;
  while (start > 0 && !SPACE.test(text[start - 1])) start -= 1;

  // The walk stops at whitespace or the line's start, so landing on a `&` here
  // proves it opens a word — the same guard the mention walk uses against an
  // email address, and what keeps `A&B` plain prose.
  if (text[start] !== "&") return null;

  // A placed tag holds spaces, so the token the caret sits in can only ever be
  // the query being typed. Re-editing one replaces that token alone and leaves
  // the old title behind, exactly as re-editing `#DRA-53 Title` does.
  let end = caret;
  while (end < text.length && !SPACE.test(text[end])) end += 1;

  return { start, end, query: text.slice(start + 1, end) };
}

/// The text of a tag: the title, then the id in parentheses.
///
/// Title first because it is what the reader recognises the row by, and the id
/// is 36 characters of nothing they can read — reversed, every tag would open
/// with the same shapeless run and the sentence would be unscannable. The
/// picker's overlay and the transcript both dim the parenthesised half for that
/// reason, the way `splitMention` dims a path's directory.
export function sessionTag(title: string, id: string): string {
  return `&${title} (${id})`;
}

/// A placed tag at `text[i]`, or `null` where one does not start there.
///
/// Answers the whole run and its two halves, since every surface that draws one
/// wants a different amount of it: the composer paints all of it and dims
/// `trail`, the transcript drops `trail` entirely, and `head + trail` is the
/// run back exactly — the property the overlay's register depends on.
export function parseSessionTag(
  text: string,
  i: number,
): { text: string; head: string; trail: string; id: string } | null {
  const match = TAG.exec(text.slice(i));
  if (!match) return null;

  const [whole, title, id] = match;

  return { text: whole, head: `&${title}`, trail: whole.slice(title.length + 1), id };
}

/// The text with the tag at `span` replaced, and where the caret goes after.
///
/// A trailing space for the reason [`applyIssue`] gives: a tag is almost never
/// the last thing typed, and one is not added where there is one already.
export function applySession(
  text: string,
  span: SessionSpan,
  title: string,
  id: string,
): { text: string; caret: number } {
  const tag = sessionTag(title, id);
  const after = text.slice(span.end);
  const spaced = after.startsWith(" ") ? after : ` ${after}`;

  return {
    text: `${text.slice(0, span.start)}${tag}${spaced}`,
    caret: span.start + tag.length + 1,
  };
}

/// What the picker offers, out of the list the sidebar is already drawing.
///
/// The project narrowing is **not** here, deliberately: `visibleSessions` in
/// `App` is where the space and the project filter are applied once, so that
/// this list, the sidebar and the ⌘⇧↑/↓ walk read one array. What is left is
/// the two rules this picker owns — a session cannot be handed to itself, and a
/// settled one is not work anybody is pointing at.
///
/// Matched on title alone by substring. The query cannot hold a space, since
/// the span stops at whitespace, so this only ever narrows on one word — which
/// is enough to find a title and deliberately weaker than a fuzzy rank would
/// be: a row it misses is one the reader keeps typing for, where a row it
/// invents is a session they did not mean.
export function filterSessions(
  sessions: SessionIndexItem[],
  selfId: string | null,
  query: string,
): SessionIndexItem[] {
  const needle = query.trim().toLowerCase();

  return sessions.filter(
    (s) =>
      s.sessionId !== selfId &&
      !s.archived &&
      (!needle || s.title.toLowerCase().includes(needle)),
  );
}

/// The titles this list holds more than once.
///
/// A title is the whole row, so two rows carrying one are the same row twice
/// and the reader picks between them by guessing — which addresses a real and
/// *different* session, silently. Titles are generated from a first prompt, so
/// two goes at one task genuinely collide.
///
/// The Files view's `tabLabels` takes exactly this reading: a name only stops
/// being unambiguous when a second one arrives, so the row that has to say more
/// is decided by the list rather than by the row. Nothing is added to the
/// ordinary row, which is the whole point of computing this at all.
export function ambiguousTitles(sessions: SessionIndexItem[]): Set<string> {
  const seen = new Set<string>();
  const twice = new Set<string>();

  for (const { title } of sessions) {
    if (seen.has(title)) twice.add(title);
    seen.add(title);
  }

  return twice;
}
