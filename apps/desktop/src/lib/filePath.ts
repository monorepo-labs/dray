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

/// A trailing `:12`, `:12:5`, `:L12` or `#L12`, its line in the first group
/// that matched.
///
/// The app's own harness prompt asks for `file_path:line_number`, so this is
/// the commonest shape an absolute path takes in a transcript. The locator is
/// no part of the file, so `path` is read without it — left on, the link named
/// a file that does not exist and the click did nothing — but the match keeps
/// it, so the link the reader sees is the whole reference and not a filename
/// with `:12` dangling beside it in plain text, which read as half-converted.
///
/// `:L12` is the shape agents reach for most after the bare number — it is what
/// this repo's own review comments use — and it failed *silently*: the run kept
/// the suffix, so the last segment stopped ending in a filename and the path
/// was not picked out at all. The `L` is optional rather than a fourth
/// alternative, since `:12` and `:L12` are one idea spelled two ways.
const LOCATOR = /(?::L?(\d+)(?::\d+)?|#L(\d+))$/;

/// `end` reaches past the locator where there is one, so the whole reference is
/// the link; `path` never holds it, so what opens is the file.
type FilePathMatch = { start: number; end: number; path: string; line?: number };

/// Whether `path` is an absolute path worth offering to open.
///
/// Two segments at least, so a lone `/compact` in a sentence stays a slash
/// command and `I/O` stays prose. No `//`, which is what is left of a URL after
/// its scheme.
export function isFilePath(path: string): boolean {
  if (!path.startsWith("/") || path.includes("//")) return false;
  return path.split("/").filter(Boolean).length >= 2;
}

/// A relative path's last segment has to name a file, and the extension has to
/// open with a letter.
///
/// This is the whole of what separates `apps/desktop/src/lib/highlight.ts` from
/// the prose that shares its shape, and every part of it is load-bearing:
/// `and/or`, `TCP/IP`, `24/7` and `9/9/2026` all hold a slash between two words
/// and none of them names a file. The letter rule is what keeps `3.5/5.0` out,
/// which a bare `\\.\\w+` would have taken.
const NAMES_FILE = /\.[A-Za-z][A-Za-z0-9]{0,9}$/;

/// A first segment shaped like a hostname.
///
/// `github.com/org/repo/a.ts` is a URL somebody left the scheme off, not a
/// directory in this checkout, and it is the commonest thing to type that this
/// rule would otherwise resolve against the working directory. A leading dot is
/// not matched, so `.github/workflows/ci.yml` stays the path it is.
const HOSTNAME = /^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,24}$/i;

/// A host with a port, and an IPv4 address.
///
/// Neither carries a dotted TLD, so [HOSTNAME] misses both — and they are the
/// two an agent writes most while a dev server is up. `localhost:3000/api/x.json`
/// and `127.0.0.1/api/x.json` were being resolved against the working directory
/// and drawn as files in this checkout.
const HOST_PORT = /:\d+$/;
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/// Whether a path's first segment names a host rather than a directory.
///
/// `localhost` is named outright because it is the one host with no dot, no
/// port and no digits — it matches none of the shapes above and is written more
/// than any of them.
function namesAHost(segment: string): boolean {
  if (segment.toLowerCase() === "localhost") return true;
  return HOSTNAME.test(segment) || IPV4.test(segment) || HOST_PORT.test(segment);
}

/// Whether `path` is a relative path worth resolving against a working
/// directory.
///
/// Stricter than [isFilePath] on purpose. An absolute path announces itself
/// with its leading slash, so two segments are enough to tell it from prose; a
/// relative one announces nothing, so it has to earn the reading by ending in a
/// filename.
export function isRelativePath(path: string): boolean {
  if (path.startsWith("/") || path.includes("//")) return false;

  const parts = path.split("/");
  if (parts.length < 2 || parts.some((part) => !part)) return false;
  if (namesAHost(parts[0])) return false;

  return NAMES_FILE.test(parts.at(-1) ?? "");
}

/// `stop` pulled back past the punctuation a sentence puts after a path: `end`
/// is where the match ends, `pathEnd` where the file's own name does, and the
/// two differ by exactly the locator.
///
/// Shared by both scans so a path picked out either way loses its bracket and
/// its `:12` the same way. Order matters: the punctuation strip runs first, so
/// `(src/a.ts:12)` loses the bracket before the locator is looked for.
function trimTail(
  text: string,
  from: number,
  stop: number,
): { end: number; pathEnd: number; line?: number } {
  let end = stop;
  while (end > from && TRAILING.has(text[end - 1])) end -= 1;

  const locator = LOCATOR.exec(text.slice(from, end));
  if (!locator) return { end, pathEnd: end };

  return { end, pathEnd: end - locator[0].length, line: Number(locator[1] ?? locator[2]) };
}

/// Every relative path in `text`, in order.
///
/// A run holding a space is never read as one. The absolute scan reaches across
/// a break because the half it would otherwise keep is itself a real path that
/// opens the wrong directory; a relative half resolves to nothing and costs a
/// dead click, so the cheaper rule is the right one here.
export function findRelativePaths(text: string): FilePathMatch[] {
  const found: FilePathMatch[] = [];

  for (let i = 0; i < text.length; i += 1) {
    // Word-opening only, so `see and/or` is never read from partway in.
    if (i > 0 && !OPENS_PATH.test(text[i - 1])) continue;
    // ...and never *on* the opener itself, or `(src/a.ts)` keeps its bracket:
    // the absolute scan gets this free by keying on the leading slash, where
    // this one has no such anchor and has to say it.
    if (OPENS_PATH.test(text[i])) continue;

    // The run ends at the next opener as well as at whitespace, so `open(src/a.ts)`
    // is read as `open` and then as `src/a.ts` rather than as one candidate
    // spelled `open(src/a.ts`. It is also what keeps this linear: a token full
    // of internal openers would otherwise be rescanned whole from each of them.
    let stop = i;
    while (stop < text.length && !OPENS_PATH.test(text[stop])) stop += 1;

    const { end, pathEnd, line } = trimTail(text, i, stop);
    const path = text.slice(i, pathEnd);
    if (!isRelativePath(path)) continue;

    found.push({ start: i, end, path, line });
    i = end - 1;
  }

  return found;
}

/// Every path in a prompt the reader wrote, absolute or relative, in order and
/// never overlapping.
///
/// Two scans rather than one rule, because the two shapes are told from prose
/// by different evidence — see [isRelativePath]. The ranges *can* overlap
/// though, and the claim that they could not was wrong: an absolute path
/// holding an opener starts a relative candidate inside itself, so
/// `/tmp/(src/a.ts)` is found twice. The caller slices a string by these, so an
/// overlap does not cost a duplicate link — it duplicates the *characters*, and
/// the run stops concatenating back to what the reader wrote.
///
/// Resolved by taking the earliest match and skipping anything that starts
/// before it ends. Longer wins a tie, so the absolute reading is kept where
/// both begin at the same character.
export function findPromptPaths(text: string): FilePathMatch[] {
  const all = [...findFilePaths(text), ...findRelativePaths(text)].sort(
    (a, b) => a.start - b.start || b.end - a.end,
  );

  const kept: FilePathMatch[] = [];
  let at = 0;

  for (const match of all) {
    if (match.start < at) continue;
    kept.push(match);
    at = match.end;
  }

  return kept;
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

    const { end, pathEnd, line } = trimTail(text, i, stop);
    const path = text.slice(i, pathEnd);
    if (!isFilePath(path)) continue;
    // A scan that stops at whitespace cuts `/Users/me/My Project/a.ts` in half,
    // and the half is a real path — one that can exist and open the wrong
    // directory. Nothing here can tell where the name ended, so an ambiguous
    // run is dropped rather than guessed at.
    if (continuesPath(text, stop, path)) continue;

    found.push({ start: i, end, path, line });
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
