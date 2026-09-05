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

/// Any whitespace but a line break.
///
/// The match itself stops on `\s`, so the read that looks for a broken path has
/// to resume on the same set — checking the ASCII space alone left a path cut
/// by a tab or a non-breaking space halved, which is the one failure this whole
/// rule exists to prevent. `&nbsp;` in agent HTML makes that an ordinary input.
/// A line break stays the bound, since a path does not span one.
const GAP = /[^\S\r\n]/;

/// A trailing `:12`, `:12:5` or `#L12`.
///
/// The app's own harness prompt asks for `file_path:line_number`, so this is
/// the commonest shape an absolute path takes in a transcript. `open -a` cannot
/// be handed a line, so the number stays prose and the path is what opens —
/// left on, the link named a file that does not exist and the click did
/// nothing.
const LOCATOR = /(?::\d+(?::\d+)?|#L\d+)$/;

type FilePathMatch = { start: number; end: number; path: string };

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

    let stop = i;
    while (stop < text.length && !/\s/.test(text[stop])) stop += 1;

    let end = stop;
    while (end > i && TRAILING.has(text[end - 1])) end -= 1;

    // After the punctuation strip, so `(/a/b.ts:12)` loses the bracket first
    // and the locator second.
    const locator = LOCATOR.exec(text.slice(i, end));
    if (locator) end -= locator[0].length;

    const path = text.slice(i, end);
    if (!isFilePath(path)) continue;
    // A scan that stops at whitespace cuts `/Users/me/My Project/a.ts` in half,
    // and the half is a real path — one that can exist and open the wrong
    // directory. Nothing here can tell where the name ended, so an ambiguous
    // run is dropped rather than guessed at.
    if (continuesPath(text, stop, path)) continue;

    found.push({ start: i, end, path });
    i = end - 1;
  }

  return found;
}

/// Whether a final segment reads as a filename rather than as a directory.
///
/// A dot and nothing more, so it is a guess: `project.v2` is a directory that
/// answers yes. It is only ever used to stop the read *early*, never to accept
/// a match outright, which is what keeps the guess from deciding anything on
/// its own.
function namesAFile(path: string): boolean {
  return (path.split("/").filter(Boolean).at(-1) ?? "").includes(".");
}

/// Whether what follows `stop` looks like the rest of a path this scan cut in
/// half.
///
/// Reads over any whitespace but a line break, not the ASCII space alone: the
/// match stops on `\s`, so a tab or a non-breaking space breaks a path exactly
/// as a space does.
///
/// The word straight after the break decides it wherever it can, and it can
/// twice over. One holding a slash is the rest of this path, so the match is a
/// truncation — that holds however finished the match looks, which is what
/// catches `/Users/me/project.v2 source/a.ts`. One *opening* with a slash is a
/// path of its own, which tells `open /a/b now and see /c/d` from a break.
///
/// Only past that word does how the match looks matter. A path can hold several
/// spaces, so `/Users/me/My Project Sub/a.ts` puts two plain words between the
/// break and its giveaway slash, and the read has to cross them — but reading
/// on from a match that already `namesAFile` would cost `Updated /a/b/x.ts and
/// src/foo.ts` its link to a relative path four words later. So a finished-
/// looking match stops at one word and an unfinished one reads to the end of
/// the line, which a path does not span.
///
/// None of it is conclusive: `see /a/b and/or c` reads as truncated and is not,
/// so that link is lost. Losing a link is the side to be wrong on, because the
/// alternative opens a directory the reader never named.
function continuesPath(text: string, stop: number, path: string): boolean {
  const finished = namesAFile(path);

  let at = stop;
  while (GAP.test(text[at] ?? "")) {
    let end = at + 1;
    while (end < text.length && !/\s/.test(text[end])) end += 1;

    const word = text.slice(at + 1, end);
    if (word.startsWith("/")) return false;
    if (word.includes("/")) return true;
    if (finished) return false;

    at = end;
  }

  return false;
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
