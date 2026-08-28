import type { JsonValue } from "@/types/serde_json/JsonValue";
import type { ToolType } from "@/types/events";

/// `input` is always an object per the mapper's contract, but it arrives as an
/// untyped `JsonValue` — this narrows it without trusting the shape.
function field(input: JsonValue, key: string): string | null {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return null;
  const value = (input as Record<string, JsonValue>)[key];
  return typeof value === "string" ? value : null;
}

/// The interesting argument, shown next to the tool name. Claude Code leaves
/// `title` null on every call, so the row has to derive its own summary and each
/// tool keeps whichever field actually identifies the work.
export function toolSummary(
  name: string,
  toolType: ToolType,
  input: JsonValue,
): string | null {
  // Tool-keyed rather than field-keyed: the harness classifies `Skill` as
  // `other`, and its only identifying field is the skill's own name.
  if (name === "Skill") return field(input, "skill");

  const path = field(input, "file_path") ?? field(input, "path") ?? field(input, "notebook_path");
  if (path) return shortenPath(path);

  switch (toolType) {
    case "shell":
      return field(input, "command");
    case "search":
      return field(input, "pattern") ?? field(input, "query");
    case "web":
      return field(input, "url") ?? field(input, "query");
    case "subagent_spawn":
      return field(input, "description") ?? field(input, "subagent_type");
    default:
      break;
  }

  // A tool the mapper classified as `other` still deserves a label, so fall back
  // to whichever conventional field it happens to carry.
  return (
    field(input, "description") ??
    field(input, "command") ??
    field(input, "query") ??
    field(input, "prompt") ??
    (name ? null : null)
  );
}

/// Present/past labels per tool, so a row reads as an action rather than an API
/// name. Only the built-in tools get one — an MCP tool's name is arbitrary, and
/// conjugating it would produce nonsense, so those fall back to the name itself.
///
/// Bash stays literal in both tenses on a row: "Running"/"Ran" describes the
/// command, not the tool, and the command is already shown beside it.
///
/// The third field is the noun a collapsed run counts ("Read 4 **files**") — the
/// group label needs it, a single row doesn't.
type Verbs = [running: string, done: string, noun: string];

const TOOL_VERBS: Record<string, Verbs> = {
  Read: ["Reading", "Read", "file"],
  NotebookRead: ["Reading", "Read", "notebook"],
  Edit: ["Editing", "Edited", "file"],
  NotebookEdit: ["Editing", "Edited", "notebook"],
  Write: ["Writing", "Wrote", "file"],
  Bash: ["Bash", "Bash", "command"],
  BashOutput: ["Reading output", "Read output", "output"],
  KillShell: ["Killing shell", "Killed shell", "shell"],
  Grep: ["Searching", "Searched", "pattern"],
  Glob: ["Searching", "Searched", "pattern"],
  WebFetch: ["Fetching", "Fetched", "page"],
  WebSearch: ["Searching web", "Searched web", "query"],
  AskUserQuestion: ["Asking", "Asked", "question"],
  Skill: ["Launching", "Launched", "skill"],
};

/// The brief a `Skill` call was given — the sentence the model wrote for the
/// skill, not an argument to it. Null where the model named a skill and left it
/// to read its own instructions, which is the common case.
export function skillBrief(input: JsonValue): string | null {
  const args = field(input, "args")?.trim();
  return args ? args : null;
}

/// The label for a single tool-call row. `pending` picks the tense — a live call
/// reads "Reading", a settled one "Read".
export function toolLabel(name: string, pending: boolean): string {
  const verbs = TOOL_VERBS[name];
  if (!verbs) return name;
  return pending ? verbs[0] : verbs[1];
}

/// Verbs that differ in a group. Two reasons a tool lands here: Bash reads
/// better conjugated than its row does ("Bash" beside a command, but "Ran 6
/// commands" for a count), and the verbs carrying their own object would
/// otherwise say it twice — "Searching web 4 queries".
const GROUP_VERBS: Record<string, [running: string, done: string]> = {
  Bash: ["Running", "Ran"],
  BashOutput: ["Reading", "Read"],
  KillShell: ["Killing", "Killed"],
  WebSearch: ["Searching", "Searched"],
};

/// English plurals only where the nouns here need it — a trailing `y` after a
/// consonant. Nothing in `TOOL_VERBS` is irregular, so this stays a rule rather
/// than a table.
function plural(noun: string, count: number): string {
  if (count === 1) return noun;
  return /[^aeiou]y$/.test(noun) ? `${noun.slice(0, -1)}ies` : `${noun}s`;
}

/// The verb a collapsed run reads under — "Reading" live, "Read" once settled.
/// A tool with no entry falls back to its own name, which needs no upkeep as
/// tools come and go. Exported for a run that hit a single target and names it
/// rather than counting to one: the row supplies the target, this the verb.
export function groupVerb(name: string, pending: boolean): string {
  const override = GROUP_VERBS[name];
  if (override) return override[pending ? 0 : 1];
  const verbs = TOOL_VERBS[name];
  return verbs ? verbs[pending ? 0 : 1] : name;
}

/// Labels a collapsed run: "Reading 4 files" live, "Read 4 files" once settled.
/// A tool with no `TOOL_VERBS` noun counts bare calls ("ToolSearch 4 calls").
export function groupLabel(name: string, count: number, pending: boolean): string {
  const noun = plural(TOOL_VERBS[name]?.[2] ?? "call", count);
  return `${groupVerb(name, pending)} ${count} ${noun}`;
}

/// The label a streaming call reads under before its arguments have arrived —
/// "Writing a file", "Running a command". The tool name lands at
/// `content_block_start`, its target up to a second and a half later on a large
/// call, so this covers the window where the tool is known and nothing else is.
///
/// Uses the group verb, since the same reason Bash reads better conjugated in a
/// group applies here: there is no command beside it yet to make "Bash" a label.
/// A tool with no entry gets its own name, which is still better than a blank
/// row.
export function streamingLabel(name: string): string {
  const noun = TOOL_VERBS[name]?.[2];
  if (!noun) return groupVerb(name, true);
  return `${groupVerb(name, true)} ${/^[aeiou]/i.test(noun) ? "an" : "a"} ${noun}`;
}

/// Absolute paths dominate the row otherwise; the last two segments are enough
/// to recognize a file and still fit beside the tool name.
export function shortenPath(path: string): string {
  const parts = path.split("/").filter(Boolean);
  if (parts.length <= 2) return path;
  return parts.slice(-2).join("/");
}

/// Formats a duration the way a reader scans it, not to full precision.
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

/// Pretty-prints tool input for the expanded view, dropping the fields the row
/// header already shows so the body isn't a duplicate of the summary line.
export function formatToolInput(input: JsonValue, omit: string[]): string | null {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return input === null ? null : JSON.stringify(input, null, 2);
  }

  const rest = Object.fromEntries(
    Object.entries(input as Record<string, JsonValue>).filter(([k]) => !omit.includes(k)),
  );

  return Object.keys(rest).length ? JSON.stringify(rest, null, 2) : null;
}

/// The identifying argument of a call whose tool type isn't to hand — the
/// permission card sees raw wire input and no `ToolType`. Same field precedence
/// as `toolSummary`, minus the per-type branch it can't make.
export function toolArgument(input: JsonValue): string | null {
  const path = field(input, "file_path") ?? field(input, "path") ?? field(input, "notebook_path");
  if (path) return shortenPath(path);

  return (
    field(input, "command") ??
    field(input, "pattern") ??
    field(input, "query") ??
    field(input, "url") ??
    // Field-keyed where `toolSummary` keys on the tool: the card sees raw wire
    // input and no name, and a `skill` string names a skill whatever carries it.
    field(input, "skill") ??
    null
  );
}

// An errored call the reader never has to act on. Every one of these is the
// agent probing — a path it guessed at, a binary it checked for, a command the
// harness declined — and it recovers on the next call without anyone looking.
// Measured over ten sessions of real logs: 38 of 45 failed `Bash` calls were
// one of these five, so colouring on `isError` alone made red the transcript's
// resting state and left nothing to mark the seven that mattered.
//
// Matched anywhere in the text, not anchored: a shell failure arrives as
// "Exit code 1" with the message on the line under it. `Blocked:` is the
// exception and is anchored per-line, because it opens the harness's own
// refusal rather than appearing inside output.
const ROUTINE_ERRORS = [
  // A worktree-isolated session refusing a command it can't prove stays inside
  // its own tree. Not a failure at all — the command never ran.
  /is isolated in the worktree|too complex to verify that it stays inside the worktree/i,
  /no such file or directory/i,
  // zsh's own wording when a glob matches nothing, which is the same miss.
  /no matches found:/i,
  /command not found:/i,
  /^Blocked:/m,
];

/// Whether a failed call's error is one the reader can safely ignore, so the
/// row reports it without the alarm. The row still reads as failed — only the
/// red goes.
export function isRoutineError(text: string | undefined): boolean {
  if (!text) return false;
  return ROUTINE_ERRORS.some((pattern) => pattern.test(text));
}
