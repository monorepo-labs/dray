/// Where the composer's `#` issue picker opens, what a pick writes into the
/// text, and how the issues page groups what it lists.
///
/// The third sibling of [slash.ts] and [mention.ts], and it is shaped like the
/// second: an issue tag is a word inside a sentence, can appear any number of
/// times, and has to be told apart from a colour (`#fff`) and from a markdown
/// heading. So the caret finds its own token here, exactly as a mention does.
///
/// The identifier's shape is what separates a tag from either — a team key and
/// a number. That rule lives twice, here and in Rust's `issue_tags`, because
/// the picker needs it before a prompt is sent and the backend needs it after;
/// the two are pinned by tests on both sides rather than by one calling the
/// other, which neither can.
///
/// [slash.ts]: ./slash.ts
/// [mention.ts]: ./mention.ts
import type { Issue, IssueRef, IssueStateKind } from "@/types/events";

/// The tag token the caret is sitting in.
export type IssueSpan = {
  start: number;
  end: number;
  /// Everything after the `#`, to the end of the token — not to the caret, so
  /// backing up to fix a typo filters on the corrected whole.
  query: string;
};

const SPACE = /\s/;

/// Punctuation a tag can open behind, so `(#DRA-53)` is a tag inside a
/// sentence rather than prose. Skipped rather than treated as part of the
/// token, and the *same* set Rust's `issue_tags` trims — the two decide
/// respectively what gets painted and what gets linked, and a word painted as a
/// tag that links nothing is the drift worth guarding against.
export const OPENERS = "([\"'";

/// The tag being typed, or `null` when the caret isn't in one.
///
/// A bare `#` counts: it opens the picker on the reader's own assigned issues,
/// which is the list they most often want and the reason the empty query is not
/// treated as "nothing typed yet".
export function issueSpan(text: string, caret: number): IssueSpan | null {
  if (caret < 1 || caret > text.length) return null;

  let start = caret;
  while (start > 0 && !SPACE.test(text[start - 1])) start -= 1;

  // The walk stops at whitespace or the line's start, so landing on a `#` here
  // proves it opens a word — which is the whole of the `#fff`-mid-sentence
  // guard, exactly as the mention walk guards an email address. Bracketing
  // punctuation is stepped over first, since it opens the word too.
  while (start < text.length && OPENERS.includes(text[start])) start += 1;
  if (text[start] !== "#") return null;

  // A markdown heading is `#` followed by a space, so the token is the `#`
  // alone and the caret is behind it. That case is *allowed* to open the picker
  // — someone typing `# ` to make a heading has a picker flash open on one
  // keystroke, where refusing it would take the bare `#` list away entirely.

  let end = caret;
  while (end < text.length && !SPACE.test(text[end])) end += 1;

  return { start, end, query: text.slice(start + 1, end) };
}

/// The text of a tag: the identifier, then the title.
///
/// The same string Rust's `tag_text` writes when `--issue` names one, and both
/// are pinned — a tag picked from the menu and a tag appended by the CLI have
/// to be one shape, or the transcript draws two things for one idea.
///
/// The title is *in the text* rather than drawn beside it, and that is what
/// makes the whole feature cheap: the model reads it, the transcript reads it,
/// and the composer's overlay stays in register with the textarea underneath
/// because there is nothing painted that isn't really there.
export function issueTag(identifier: string, title: string): string {
  return title ? `#${identifier} ${title}` : `#${identifier}`;
}

/// The text with the tag at `span` replaced, and where the caret goes after.
///
/// A trailing space, because a tag is almost never the last thing typed and the
/// alternative is every reader pressing space themselves. Not added when one is
/// already there, or picking twice leaves a gap.
export function applyIssue(
  text: string,
  span: IssueSpan,
  identifier: string,
  title: string,
): { text: string; caret: number } {
  const tag = issueTag(identifier, title);
  const after = text.slice(span.end);
  const spaced = after.startsWith(" ") ? after : ` ${after}`;

  return {
    text: `${text.slice(0, span.start)}${tag}${spaced}`,
    caret: span.start + tag.length + 1,
  };
}

/// `DRA-53` out of a token, or `null` when it isn't an identifier.
///
/// The frontend's copy of Rust's `parse_identifier`, and it has to agree with
/// it: this decides what the transcript paints as a tag, and that one decides
/// what actually gets linked. A word painted as a tag that links nothing is the
/// drift worth watching for.
export function parseIdentifier(text: string): string | null {
  const match = /^([A-Za-z][A-Za-z0-9]*)-(\d+)/.exec(text);
  if (!match) return null;

  return `${match[1].toUpperCase()}-${match[2]}`;
}

/// Where an identifier points, from the links a message carries.
///
/// `null` for a tag whose issue was never resolved — an unreachable tracker at
/// send time, or a tag naming an issue that does not exist. Those stay drawn as
/// plain coloured text rather than becoming a link to nowhere.
export function issueUrl(issues: IssueRef[], identifier: string): string | null {
  // An empty URL is as good as none, and reaches here whenever a link was made
  // by `dray issue link` with no `--url`: the app writes down what the caller
  // gave it and asks the tracker nothing, so the field can simply be blank.
  // Left unchecked, the tag becomes a button that opens nowhere.
  return issues.find((issue) => issue.identifier === identifier)?.url || null;
}

/// The status buckets the issues page draws, in the order it draws them.
///
/// Keyed on the state's *kind* rather than its name: a name is per-team prose
/// ("Shipping", "In Review", "Icebox"), so grouping by it turns a list spanning
/// three teams into a dozen headings for what are really the same few states.
/// The kind is a fixed six-way vocabulary, which is what makes the grouping
/// stable across a whole workspace.
///
/// Started first and settled last — the order work moves through, which is also
/// the order attention should reach it in.
const GROUPS: { key: IssueStateKind; label: string }[] = [
  { key: "started", label: "In Progress" },
  { key: "triage", label: "Triage" },
  { key: "unstarted", label: "Todo" },
  { key: "backlog", label: "Backlog" },
  { key: "completed", label: "Done" },
  { key: "canceled", label: "Cancelled" },
  // Last, because it only ever holds a state Linear added and we don't model —
  // rare, and never the thing the reader came for.
  { key: "other", label: "Other" },
];

export type IssueGrouping = {
  key: IssueStateKind;
  label: string;
  issues: Issue[];
};

/// `issues` bucketed by state, with empty buckets dropped.
///
/// Order *within* a bucket is left exactly as it arrived — the backend has
/// already sorted by priority, and re-sorting here would be a second opinion
/// about the same question.
export function groupIssues(issues: Issue[]): IssueGrouping[] {
  return GROUPS.map((group) => ({
    ...group,
    issues: issues.filter((issue) => issue.state.kind === group.key),
  })).filter((group) => group.issues.length > 0);
}
