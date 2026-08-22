/// Where the composer's `@` file picker opens, and how a pick lands back in the
/// text.
///
/// The sibling of [slash.ts], and deliberately not the same shape. A command is
/// the *whole* first token of a prompt, so the slash picker can key off position
/// zero; a mention is a word inside a sentence, appears any number of times, and
/// has to be told apart from the `@` in an email address. So the caret finds its
/// own token here rather than the token being found once up front.
///
/// [slash.ts]: ./slash.ts

/// The mention token the caret is sitting in.
///
/// The span is returned rather than just the query because [`applyMention`]
/// needs to know what to replace — a mention can be anywhere in the line, so
/// unlike a command there is no "from the start" to rewrite from.
export type MentionSpan = {
  start: number;
  end: number;
  /// Everything after the `@`, up to the end of the token — not up to the
  /// caret. Backing up to fix a typo mid-path filters on the corrected whole,
  /// which is what makes the correction visible in the list.
  query: string;
};

/// Whitespace ends a mention, which is also the reason a path containing a space
/// can't be mentioned. The CLI parses `@path` out of the prompt the same way, so
/// this is its limit rather than one this picker adds.
const SPACE = /\s/;

/// The mention being typed, or `null` when the caret isn't in one.
export function mentionSpan(text: string, caret: number): MentionSpan | null {
  // A caret before the `@` is not inside the mention yet, and at 0 there is no
  // token behind it to be in.
  if (caret < 1 || caret > text.length) return null;

  let start = caret;
  while (start > 0 && !SPACE.test(text[start - 1])) start -= 1;

  // The walk stops at whitespace or the start of the line, so reaching an `@`
  // here proves it opens a word. That is the whole email guard: in
  // `me@example.com` the walk runs past the `@` to the `m` and fails this test.
  if (text[start] !== "@") return null;

  let end = caret;
  while (end < text.length && !SPACE.test(text[end])) end += 1;

  return { start, end, query: text.slice(start + 1, end) };
}

/// Replaces the mention being typed with `path`.
///
/// Always leaves exactly one space after it, reusing the one already there when
/// the mention has text behind it. Two mentions run together would parse as one
/// token, so this separator is load-bearing rather than cosmetic.
export function applyMention(
  text: string,
  span: MentionSpan,
  path: string,
): { text: string; caret: number } {
  const head = `${text.slice(0, span.start)}@${path}`;
  const tail = text.slice(span.end);

  return {
    text: head + (tail.startsWith(" ") ? tail : ` ${tail}`),
    caret: head.length + 1,
  };
}
