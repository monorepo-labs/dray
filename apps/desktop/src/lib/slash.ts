/// Where the composer's slash-command picker opens, what it filters to, and how
/// a pick lands back in the text.
///
/// Pure and separated from the component for the same reason [streaming.ts]
/// is: the caret arithmetic is the part that can be wrong in ways a glance at
/// the UI won't catch, and it is cheap to pin.
///
/// [streaming.ts]: ./streaming.ts
import type { SlashCommand } from "@/types/events";

/// The command name being typed, or `null` when the caret isn't in one.
///
/// Only a *leading* slash counts, because that is the only one the CLI treats as
/// a command — a slash mid-sentence is prose, and opening a picker over it would
/// fire on every file path someone types.
///
/// The caret has to be inside the first token rather than the text merely
/// lacking a space, so backspacing into `/review some args` to fix the name
/// reopens the picker instead of leaving it shut until the line is cleared.
export function slashQuery(text: string, caret: number): string | null {
  if (!text.startsWith("/")) return null;

  const space = text.search(/\s/);
  const end = space === -1 ? text.length : space;
  if (caret < 1 || caret > end) return null;

  return text.slice(1, end);
}

/// Commands matching `query`, best first.
///
/// Ranked rather than filtered so a typed prefix beats a chance mention in some
/// other command's description. The sort is stable and an empty query scores
/// every command alike, so "just opened" shows the CLI's own ordering — which
/// groups user commands ahead of built-ins — rather than a re-alphabetized list.
export function filterCommands(commands: SlashCommand[], query: string): SlashCommand[] {
  const q = query.toLowerCase();

  return commands
    .map((command) => ({ command, score: score(command, q) }))
    .filter((match) => match.score !== null)
    .sort((a, b) => a.score! - b.score!)
    .map((match) => match.command);
}

/// `null` when the command doesn't match at all. Lower is better.
function score(command: SlashCommand, query: string): number | null {
  const name = command.name.toLowerCase();
  if (name.startsWith(query)) return 0;
  if (command.aliases.some((alias) => alias.toLowerCase().startsWith(query))) return 1;

  // A namespaced command should still be findable by its bare half, so
  // `railway:deploy` matches "deploy" ahead of anything that only mentions it.
  if (name.slice(name.indexOf(":") + 1).startsWith(query)) return 2;
  if (name.includes(query)) return 3;
  if (command.description.toLowerCase().includes(query)) return 4;

  return null;
}

/// Replaces the command being typed with `name`, leaving any arguments alone.
///
/// Always lands the caret past a trailing space: every pick is either finished
/// (the space is harmless) or about to take arguments (the space is needed), and
/// the CLI reads `/model` and `/model ` identically.
export function applyCommand(text: string, name: string): { text: string; caret: number } {
  const space = text.search(/\s/);
  const args = space === -1 ? "" : text.slice(space);
  const head = `/${name}`;

  return { text: head + (args || " "), caret: head.length + 1 };
}

/// Where a command came from, as far as the CLI will tell us.
///
/// The `initialize` payload carries no scope field — only `name`, `description`,
/// `argumentHint` and `aliases` — so this reads the two signals that are
/// recoverable: a plugin namespaces its commands into the name, and a
/// user- or project-scoped one has the scope appended to its *description*.
///
/// `harness` therefore means "neither of those", which lumps the CLI's true
/// built-ins (`/compact`, `/model`) together with the skills Anthropic ships
/// alongside them (`/dataviz`, `/code-review`). Nothing distinguishes those two,
/// and for the reader they are the same thing: commands that were there without
/// anyone installing them.
///
/// The description test is the fragile half, since it reads display text rather
/// than a field. It fails benignly — a reworded suffix files a command under the
/// wrong heading and changes nothing else — so it is not worth a sturdier scheme
/// that the wire doesn't support.
export type CommandSource = "harness" | "plugin" | "user";

const SCOPE_SUFFIX = /\((?:user|project)\)\s*$/;

export function commandSource(command: SlashCommand): CommandSource {
  if (command.name.includes(":")) return "plugin";
  return SCOPE_SUFFIX.test(command.description) ? "user" : "harness";
}

/// A run of commands drawn together. `label` is set only where the grouping
/// isn't self-evident from the contents.
///
/// Structurally a `PickerGroup<SlashCommand>` — the field is `items` rather than
/// `commands` so it can be handed to the shared menu without a mapping step
/// whose only job would be renaming it.
export type CommandGroup = {
  label: string | null;
  items: SlashCommand[];
};

/// Kept short on purpose: the list shows seven rows at a time, so a longer
/// recents run would fill the window and leave nothing else visible — at which
/// point it stops being a shortcut and becomes the whole list.
const RECENT_LIMIT = 4;

/// The browse ordering: what you just used, then what came with the harness,
/// then everything installed.
///
/// A partition rather than an overlay — a command promoted into recents leaves
/// its own group. Showing it twice would spend two of seven visible rows saying
/// the same thing, and the groups below stay complete in the only sense that
/// matters, which is that every command is reachable exactly once.
///
/// Only used with no query. A search is ranked flat by
/// [`filterCommands`](#filterCommands): headers while filtering hide matches
/// behind section chrome, which turns "is my match on screen" into a scan.
export function groupCommands(commands: SlashCommand[], recent: string[]): CommandGroup[] {
  const byName = new Map(commands.map((command) => [command.name, command]));

  // Driven off the stored order, so recency ranks these; a name whose command
  // has since been uninstalled simply drops out.
  const recentCommands = recent
    .map((name) => byName.get(name))
    .filter((command): command is SlashCommand => command !== undefined)
    .slice(0, RECENT_LIMIT);

  const promoted = new Set(recentCommands.map((command) => command.name));
  const rest = commands.filter((command) => !promoted.has(command.name));

  return [
    { label: "Recently used", items: recentCommands },
    { label: null, items: rest.filter((c) => commandSource(c) === "harness") },
    { label: null, items: rest.filter((c) => commandSource(c) !== "harness") },
  ].filter((group) => group.items.length > 0);
}

/// Splits a sent message into its command and the rest, or `null` for ordinary
/// prose. What the transcript renders as a command chip is decided here, so it
/// can't disagree with what the picker offered.
///
/// Deliberately not checked against the known command list: the transcript
/// outlives the session, and a command that has since been uninstalled was still
/// a command when it was sent.
export function parseSlashCommand(text: string): { name: string; args: string } | null {
  const match = /^\/([^\s/]\S*)(.*)$/s.exec(text);
  if (!match) return null;

  return { name: match[1], args: match[2].trim() };
}
