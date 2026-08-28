/// Reading a tool call out of the fragments that are still arriving.
///
/// A tool call's arguments stream as `input_json_delta` fragments that only
/// parse once whole, and on a `Write` "whole" means after the entire file
/// content has landed — measured at 39.5s against a `content_block_start` that
/// named the tool immediately and carried its path 1.4s in. Waiting for the
/// committed event is what leaves the transcript blank for that whole stretch,
/// so these read the prefix directly instead.
///
/// Only the row *header* is derived here. The body still waits for the committed
/// event: a half-arrived diff is worse than no diff, while a half-arrived path
/// is just a path.
///
/// Reading is O(n²) over a stream: every fragment re-renders the row, which
/// rescans the whole accumulated prefix and re-decodes the content so far. That
/// is deliberate — it holds no state between frames, so a dropped or reordered
/// fragment cannot corrupt a running parse. The cost is small at the sizes this
/// sees (a 200KB write is ~100MB of cumulative scanning spread over 40s, a
/// fraction of a millisecond per frame). A multi-MB write is where it would
/// start to show, and the fix then is to resume from the previous offset rather
/// than to parse incrementally.

import { shortenPath } from "@/lib/tools";

/// A fragment can end mid-escape (`…\` or `…\u00`), which is not valid JSON on
/// its own. Trimming that tail costs at most one character of preview and keeps
/// the parse from throwing on every other frame.
function decode(raw: string): string {
  let text = raw.replace(/\\+$/, (run) => (run.length % 2 ? run.slice(0, -1) : run));
  text = text.replace(/\\u[0-9a-fA-F]{0,3}$/, "");
  try {
    return JSON.parse(`"${text}"`) as string;
  } catch {
    return text;
  }
}

/// The string value of `key` in a JSON object that is still arriving, or null
/// when the key hasn't been seen yet.
///
/// `complete` reports whether the closing quote has landed. The two callers want
/// opposite things from it: a target is only worth printing once complete, while
/// a line count wants exactly the partial value.
function readString(
  json: string,
  key: string,
): { value: string; complete: boolean } | null {
  const at = json.indexOf(`"${key}"`);
  if (at < 0) return null;

  let i = at + key.length + 2;
  while (i < json.length && /\s/.test(json[i])) i += 1;
  if (json[i] !== ":") return null;
  i += 1;
  while (i < json.length && /\s/.test(json[i])) i += 1;
  // Not a string value — `edits` is an array under a key this never asks for,
  // but a malformed prefix shouldn't be read as one either.
  if (json[i] !== '"') return null;
  i += 1;

  const start = i;
  let complete = false;
  while (i < json.length) {
    const ch = json[i];
    // Skips the escaped character whatever it is, so an escaped quote can't end
    // the scan early. Overshooting the end on a trailing backslash is fine — the
    // slice below clamps.
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === '"') {
      complete = true;
      break;
    }
    i += 1;
  }

  return { value: decode(json.slice(start, Math.min(i, json.length))), complete };
}

/// Keys that identify a call, in the order [`toolSummary`] prefers them — the
/// committed row reads the same fields, so the preview names the call the same
/// way and the swap changes nothing on screen.
///
/// These stay field-keyed, unlike `CONTENT_KEY_BY_TOOL`: a path is a path on
/// whatever tool carries it, so a nested hit still names the call truthfully.
/// That is what makes them safe on an MCP tool nobody has enumerated, and it is
/// the reason the fix for the `content` collision didn't extend to here.
///
/// The order carries a second job: a tool can hold two of these at once, and
/// the first *complete* key wins. Bash sends `command` and `description`, and
/// `description` is what the committed row will never show — so the two must
/// not race. They don't, twice over: `command` is checked first when both have
/// landed, and it arrives first on the wire (41 of 41 Bash calls across every
/// fixture emit `command,…`, since the model follows the tool's schema order).
/// Both halves are load-bearing — `description` cannot simply be dropped to
/// settle it, because it is how a subagent spawn names itself while its far
/// longer `prompt` is still streaming.
///
/// `path` marks the ones that get shortened to their last two segments. A
/// command is not a path — running `shortenPath` over `find /a/b -name x` would
/// cut it at the slashes and print a fragment of the command as if it were the
/// whole thing.
///
/// [`toolSummary`]: ./tools.ts
const TARGET_KEYS: [key: string, path: boolean][] = [
  ["file_path", true],
  ["path", true],
  ["notebook_path", true],
  ["command", false],
  ["pattern", false],
  ["query", false],
  ["url", false],
  ["description", false],
  ["skill", false],
];

/// Where a whole-file payload lives: `Write` calls it `content`, `NotebookEdit`
/// `new_source`. Both are the file itself, which is why they are what takes 40s
/// to arrive and the only thing worth counting while it does.
///
/// Keyed by tool, unlike `TARGET_KEYS`: `content` only means file content on
/// the tool that writes one. The scan finds nested keys too, and TodoWrite
/// carries a `content` string inside every todo — field-keyed, its preview
/// counted the first todo as "+1" added lines.
const CONTENT_KEY_BY_TOOL: Record<string, string> = {
  Write: "content",
  NotebookEdit: "new_source",
};

export type StreamingCall = {
  /// Null until the stream has carried the whole value. A path printed while
  /// still arriving would grow character by character, which reads as a glitch
  /// rather than as progress.
  target: string | null;
  /// Lines of file content seen so far, for the `+N` the settled row shows from
  /// its diff. Null for a call that writes no file.
  added: number | null;
};

/// Reads what can be shown of a tool call named `name` from the fragments so far.
export function streamingCall(name: string, partialJson: string): StreamingCall {
  let target: string | null = null;
  for (const [key, isPath] of TARGET_KEYS) {
    const found = readString(partialJson, key);
    if (found?.complete) {
      target = isPath ? shortenPath(found.value) : found.value;
      break;
    }
  }

  let added: number | null = null;
  const contentKey = CONTENT_KEY_BY_TOOL[name];
  const found = contentKey ? readString(partialJson, contentKey) : null;
  if (found) {
    // A trailing newline doesn't open a line that isn't there, and an empty
    // value is 0 rather than 1, so the counter stays hidden until content
    // actually arrives.
    const text = found.value;
    added =
      text.length === 0
        ? 0
        : text.endsWith("\n")
          ? text.split("\n").length - 1
          : text.split("\n").length;
  }

  return { target, added };
}
