import { parseDiffFromFile } from "@pierre/diffs";

import type { JsonValue } from "@/types/serde_json/JsonValue";

/// The two sides a `file_edit` call renders as a diff, already resolved to the
/// strings the viewer compares. `oldText` is null for a file that did not exist
/// before — the viewer shows an addition rather than a diff against "".
export type EditSides = {
  path: string;
  oldText: string | null;
  newText: string;
};

function str(input: Record<string, JsonValue>, key: string): string | null {
  const value = input[key];
  return typeof value === "string" ? value : null;
}

function obj(input: JsonValue): Record<string, JsonValue> | null {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return null;
  return input as Record<string, JsonValue>;
}

/// Resolves a `file_edit` tool's input into the two sides of a diff, or null
/// when the call carries nothing comparable.
///
/// The three built-in editors disagree on shape, so each is read on its own
/// terms rather than through one guessed set of keys:
///
/// - `Edit` sends `old_string`/`new_string` — a fragment of the file, not the
///   whole thing. The diff is therefore of the replaced region alone, which is
///   also the only region worth reading.
/// - `MultiEdit` sends an `edits` array of those same pairs. They apply in
///   sequence to one file, so the sides are the concatenation of each end.
/// - `Write` sends `content` and no prior text. Treated as a creation even when
///   it overwrites, since the call never reports what it replaced.
export function editSides(input: JsonValue): EditSides | null {
  const root = obj(input);
  if (!root) return null;

  const path = str(root, "file_path") ?? str(root, "path") ?? str(root, "notebook_path");
  if (!path) return null;

  const edits = root.edits;
  if (Array.isArray(edits)) {
    const pairs = edits
      .map(obj)
      .filter((e): e is Record<string, JsonValue> => e !== null)
      .map((e) => [str(e, "old_string") ?? "", str(e, "new_string") ?? ""] as const)
      .filter(([before, after]) => before !== "" || after !== "");

    if (!pairs.length) return null;
    return {
      path,
      oldText: pairs.map(([before]) => before).join("\n"),
      newText: pairs.map(([, after]) => after).join("\n"),
    };
  }

  const oldText = str(root, "old_string");
  const newText = str(root, "new_string");
  if (oldText !== null || newText !== null) {
    return { path, oldText: oldText ?? "", newText: newText ?? "" };
  }

  // NotebookEdit calls its payload `new_source`; Write calls it `content`.
  const content = str(root, "content") ?? str(root, "new_source");
  if (content !== null) return { path, oldText: null, newText: content };

  return null;
}

/// The basename, which is what the diff header shows. The library infers the
/// syntax-highlighting language from this, so the extension has to survive.
export function fileName(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/// FNV-1a over the text, hex. Content identity, not a cryptographic hash: a
/// collision here costs one mis-coloured diff.
function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

/// One side of a diff as the viewer takes it, keyed on its own content.
///
/// The library falls back to the file *name* as `cacheKey` when none is given,
/// and its worker pool caches highlighted line arrays on that key alone. So two
/// diffs of one file — a second `Edit` to it, the changes panel re-reading it a
/// snapshot later, an `index.ts` in another directory — silently share one
/// tokenized result, and the longer one walks off its end ("deletionLine and
/// additionLine are null"). Keying on full path and text means a new side can
/// only ever miss the cache, never hit a stale entry.
export function diffSide(path: string, contents: string) {
  return {
    name: fileName(path),
    contents,
    cacheKey: `${path}#${contents.length}:${fnv1a(contents)}`,
  };
}

/// Both sides, spread into `parseDiffFromFile`. `oldText` null = creation.
export function diffSides(sides: EditSides) {
  return [
    sides.oldText === null ? null : diffSide(sides.path, sides.oldText),
    diffSide(sides.path, sides.newText),
  ] as const;
}

/// Lines added and removed, for the collapsed row's `+N -M`.
///
/// Counted from the same hunks the viewer renders, so the row and the diff
/// underneath it can never disagree. A hand-rolled prefix/suffix scan is close
/// but not identical: `Edit` fragments usually lack a trailing newline, and the
/// diff algorithm then treats the boundary line as changed on both sides —
/// appending two lines to `"a\nb"` really is `+3/-1` in the rendered diff, not
/// `+2/-0`. Better to report what the reader is about to see.
///
/// A changed line counts once on each side, as `git --stat` reports it.
export function countChanges(sides: EditSides): { added: number; removed: number } {
  const diff = parseDiffFromFile(...diffSides(sides));

  let added = 0;
  let removed = 0;
  for (const hunk of diff.hunks) {
    added += hunk.additionLines;
    removed += hunk.deletionLines;
  }
  return { added, removed };
}

/// The same `+N -M`, for a harness that hands over a unified diff already.
///
/// Codex reports a patch as a real diff per file, so there are no two sides to
/// reconstruct and nothing to re-run the diff algorithm over — the counting is
/// just reading the prefixes it already carries. Without this a Codex edit drew
/// no size at all beside it, where the same edit from Claude drew `+22 -12`.
///
/// `+++` and `---` are file headers, not content, and they are the one pair of
/// prefixes that would otherwise be counted as a line each.
export function countUnifiedChanges(diffs: (string | null)[]): {
  added: number;
  removed: number;
} {
  let added = 0;
  let removed = 0;

  for (const diff of diffs) {
    if (!diff) continue;
    for (const line of diff.split("\n")) {
      if (line.startsWith("+++") || line.startsWith("---")) continue;
      if (line.startsWith("+")) added += 1;
      else if (line.startsWith("-")) removed += 1;
    }
  }

  return { added, removed };
}

/// A range read, resolved to the text and the line it starts at.
export type ReadRange = {
  path: string;
  text: string;
  /// 1-based line number of `text`'s first line, so the gutter matches the file.
  startLine: number;
};

function num(input: Record<string, JsonValue>, key: string): number | null {
  const value = input[key];
  return typeof value === "number" ? value : null;
}

/// Resolves a `file_read` call into the slice it read, or null when it read the
/// whole file.
///
/// Only a *ranged* read renders as code. A full read is usually the agent
/// pulling a file into context rather than showing it to the reader, and
/// rendering hundreds of highlighted lines mid-transcript buries the
/// conversation — the collapsed row already says which file was read.
///
/// The range comes from the call's own `offset`/`limit`, not from the result:
/// Read prefixes each output line with its number, so the text has to be
/// stripped back to source before it can be highlighted.
export function readRange(input: JsonValue, output: string): ReadRange | null {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return null;
  const root = input as Record<string, JsonValue>;

  const path = str(root, "file_path") ?? str(root, "path");
  if (!path) return null;

  const offset = num(root, "offset");
  const limit = num(root, "limit");
  if (offset === null && limit === null) return null;

  const text = stripLineNumbers(output);
  if (!text.trim()) return null;

  return { path, text, startLine: offset ?? 1 };
}

// Read returns `cat -n` style output — a right-aligned line number, a tab, then
// the source. The number is data about the line, not part of it, so it has to
// come off before highlighting or every line starts with a stray integer.
const NUMBERED_LINE = /^\s*\d+\t/;

function stripLineNumbers(output: string): string {
  const lines = output.split("\n");
  // Only strip when the shape holds for the lines that have content — a file
  // whose own text happens to start with digits and a tab would otherwise lose
  // characters. Blank lines carry no prefix and so can't vote.
  const meaningful = lines.filter((line) => line.trim());
  if (!meaningful.length || !meaningful.every((line) => NUMBERED_LINE.test(line))) {
    return output;
  }
  return lines.map((line) => line.replace(NUMBERED_LINE, "")).join("\n");
}
