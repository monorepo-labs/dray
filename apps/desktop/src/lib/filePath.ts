/// Which runs of ordinary prose name a file, and what absolute path each one
/// resolves to.
///
/// Two consumers that must not disagree: the `@mention` in the reader's own
/// message, whose path is relative to the session's cwd, and the bare path an
/// agent writes into a sentence, which is already absolute. Both end at
/// `openFile`, so the rule for what counts as a path lives here once.

/// A path is only picked out where it opens a word. Deliberately strict, and
/// this set is the whole of why: `https://host/a/b` and `and/or` both hold a
/// slash with a letter in front of it, and a rule that reached past a letter
/// would turn every URL in a transcript into a dead file link.
const OPENS_PATH = /[\s([{<"']/;

/// Punctuation that ends a sentence rather than a filename. Stripped from the
/// right, so `(/Users/me/a.ts)` is a path and the bracket stays prose.
const TRAILING = new Set([...".,;:!?)]}>\"'"]);

export type FilePathMatch = { start: number; end: number; path: string };

/// Whether `path` is an absolute path worth offering to open.
///
/// Two segments at least, so a lone `/compact` in a sentence stays a slash
/// command and `I/O` stays prose. No `//`, which is what is left of a URL after
/// its scheme.
export function isFilePath(path: string): boolean {
  if (!path.startsWith("/") || path.includes("//")) return false;
  return path.split("/").filter(Boolean).length >= 2;
}

/// Every absolute path in `text`, in order.
///
/// Nothing here asks whether the file exists. It cannot, being synchronous and
/// running on every message the transcript draws, and it does not need to:
/// `openFile` falls back to revealing, and revealing a path that is gone is a
/// click that does nothing rather than an error. Over-matching costs a dead
/// link, so the rule is written to under-match instead.
export function findFilePaths(text: string): FilePathMatch[] {
  const found: FilePathMatch[] = [];

  for (let i = 0; i < text.length; i += 1) {
    if (text[i] !== "/") continue;
    if (i > 0 && !OPENS_PATH.test(text[i - 1])) continue;

    let end = i;
    while (end < text.length && !/\s/.test(text[end])) end += 1;
    while (end > i && TRAILING.has(text[end - 1])) end -= 1;

    const path = text.slice(i, end);
    if (!isFilePath(path)) continue;

    found.push({ start: i, end, path });
    i = end - 1;
  }

  return found;
}

/// `raw` as something `open` can be handed, or `null` where it cannot be.
///
/// A mention is written against the agent's own working directory, which is the
/// one thing a message does not carry — so an unanchored relative path answers
/// `null` and the word stays inert rather than becoming a link to whatever that
/// path means from wherever the app happens to be running.
export function absolutePath(raw: string, cwd: string | null): string | null {
  if (!raw) return null;
  if (raw.startsWith("/")) return raw;
  if (!cwd) return null;

  return `${cwd.replace(/\/+$/, "")}/${raw.replace(/^\.\//, "")}`;
}
