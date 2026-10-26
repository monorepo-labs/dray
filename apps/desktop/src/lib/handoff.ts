import type { WorkStatus } from "@/types/events";

const RUN_SERVER_PROMPT = "start the dev server in the background";

/// One thing the reader can hand the session, as a button.
///
/// Mostly that is handing work *back* — commit it, propose it — but `runServer`
/// starts work instead, and it sits here because the bargain is the same one: a
/// click is a prompt the reader did not have to type. A second home for that
/// bargain would be the same button in two places.
///
/// **Every one of these is a prompt**, sent verbatim as if typed, and that is
/// the design: the agent writes the commit message with the context it just
/// worked in, so there is no second write path, no confirm dialog and no error
/// surface — whatever goes wrong is reported in the transcript like any other
/// tool failure. The shipped prompts stay a few words for the same reason. The
/// model knows how to commit and whether the branch has an upstream; a sentence
/// spelling it out here is a spec competing with the repo's own instructions,
/// and this repo has firm ones about commit messages.
///
/// There used to be a second kind. `push` ran a backend push command directly, on the
/// grounds that pushing has one correct implementation and nothing to decide —
/// and it owned both ends of its own feedback because it reported into no
/// transcript: a spinner on the button, an error banner above the composer, a
/// forced `work_status` re-read to correct the count it drew. All of that was
/// machinery for one button in a row with no room for it. `create a PR` pushes
/// on the way, and a bare push is a sentence anyone can type.
export type HandoffAction = {
  /// Unique in the row: a built-in's name, or the id a custom button was
  /// minted with.
  id: string;
  /// Which built-in this is, or `null` for one the reader added. Picks the
  /// glyph and the analytics name, so every custom button reports as one fixed
  /// `handoff_custom` and its text never leaves the machine.
  builtin: BuiltinHandoffId | null;
  label: string;
  /// Sent verbatim as if it were typed.
  prompt: string;
};

export type BuiltinHandoffId = "commit" | "pr" | "runServer";

/// The three that ship, in their shipped order: commit, then propose, then Run
/// server last — Commit sits where the eye lands, and a third kind of action
/// at the head displaces the thing most often wanted. The reader can reorder.
///
/// **Fixed, not editable.** Each is shown by a rule about the checkout, and
/// that rule is only right for the words it was written for: "commit your
/// changes" belongs on a dirty tree, a prompt rewritten into something else
/// does not. So the reader can switch one off, and writes their own words as a
/// button of their own.
export const BUILTIN_HANDOFF: { id: BuiltinHandoffId; label: string; prompt: string }[] = [
  { id: "commit", label: "Commit", prompt: "commit your changes" },
  { id: "pr", label: "Create PR", prompt: "create a PR" },
  { id: "runServer", label: "Run server", prompt: RUN_SERVER_PROMPT },
];

export function builtinHandoff(id: BuiltinHandoffId) {
  return BUILTIN_HANDOFF.find((b) => b.id === id)!;
}

function isBuiltinHandoff(id: unknown): id is BuiltinHandoffId {
  return BUILTIN_HANDOFF.some((b) => b.id === id);
}

/// A button the reader added. Shown whenever there is a session, since nothing
/// here can know what its prompt needs.
export type CustomHandoffButton = { kind: "custom"; id: string; label: string; prompt: string };

/// One entry in the reader's row: a built-in, switched on or off, or one of
/// their own.
export type HandoffEntry = { kind: "builtin"; id: BuiltinHandoffId; on: boolean } | CustomHandoffButton;

/// The reader's row, in local storage, in draw order — built-ins and their own
/// buttons in one list, since the reader orders them together.
export type HandoffConfig = HandoffEntry[];

export const DEFAULT_HANDOFF: HandoffConfig = BUILTIN_HANDOFF.map((b) => ({
  kind: "builtin",
  id: b.id,
  on: true,
}));

/// A stored value read back, whatever is in there. Anything that is not a list
/// — a malformed write, a shape from another build — reads as the defaults
/// rather than breaking the row, and a bad entry inside a good list is dropped
/// alone. A built-in the stored list lacks is appended switched on, so one a
/// later build adds reaches every reader.
export function readHandoffConfig(raw: unknown): HandoffConfig {
  if (!Array.isArray(raw)) return DEFAULT_HANDOFF;
  const seen = new Set<string>();
  const out: HandoffConfig = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const { kind, id, on, label, prompt } = entry as Record<string, unknown>;
    if (typeof id !== "string" || !id || seen.has(id)) continue;
    if (kind === "builtin" && isBuiltinHandoff(id)) {
      out.push({ kind, id, on: on !== false });
    } else if (kind === "custom" && !isBuiltinHandoff(id)) {
      // A built-in's id would collide with it as a React key in the row.
      out.push({
        kind,
        id,
        label: typeof label === "string" ? label : "",
        prompt: typeof prompt === "string" ? prompt : "",
      });
    } else {
      continue;
    }
    seen.add(id);
  }
  for (const b of DEFAULT_HANDOFF) if (!seen.has(b.id)) out.push(b);
  return out;
}

/// What an empty label falls back to on a custom button: the prompt's first
/// few words, which is roughly what the reader would have called it.
export function labelFromPrompt(prompt: string): string {
  return prompt.trim().split(/\s+/).slice(0, 3).join(" ");
}

/// Whether a pull request from this checkout would contain anything.
///
/// Two separate refusals. The default branch is where work lands, so opening a
/// pull request from it is a request against itself, and a repo with no remote
/// resolves no default branch and has nowhere to push one.
///
/// Then: an empty branch. A branch level with its base and a clean tree has
/// nothing to propose, and the button there opens a pull request with no diff
/// in it. `aheadOfBase` and not `ahead` — the second counts against the
/// *upstream*, so a branch pushed in full reads as zero and that is exactly
/// when a pull request is most wanted. `null` is "couldn't tell" and counts as
/// something, since over-offering costs a wasted click where under-offering
/// hides the action.
function canOpenPr(status: WorkStatus): boolean {
  if (status.branch === null || status.defaultBranch === null) return false;
  if (status.branch === status.defaultBranch) return false;
  return status.dirty > 0 || status.aheadOfBase === null || status.aheadOfBase > 0;
}

/// Which buttons the composer's action row draws, in the reader's order: each
/// built-in this checkout earns and the reader has not switched off, and each
/// of the reader's own that has something to send.
///
/// Empty means no session — with one, Run server and any custom button keep
/// the row standing.
///
/// `hasPr` comes from the sidebar's own per-repo read rather than from git:
/// once a pull request exists, the panel is where it is acted on, and a second
/// "Create PR" button would open a duplicate.
///
/// Run server is the exception to the git rules: it wants a session and nothing
/// else, and a custom button takes the same rule. Being parked behind the
/// sliver is what makes that bearable. Nothing tracks whether a server is
/// already up — the cheap signal, `tasksBySession`, answers "some background
/// task is live" and not "this project's server is up", so gating on it would
/// hide the button through an unrelated `Monitor` run. On permanent display the
/// button asks a question it cannot answer; behind the sliver only someone who
/// went looking sees it, and going looking is wanting it.
export function handoffActions(
  status: WorkStatus | null,
  hasPr: boolean,
  hasSession = false,
  config: HandoffConfig = DEFAULT_HANDOFF,
): HandoffAction[] {
  const offered = new Set<BuiltinHandoffId>();

  // Running a server needs no repository. Vague about which server — the agent
  // reads the repo — but "in the background" is load-bearing: without it the
  // CLI runs `pnpm dev` in a foreground Bash, which times out and takes the
  // server down with it.
  if (hasSession) offered.add("runServer");

  if (status && status.branch !== null) {
    // **The row has a width, and that is what set the shipped count.** The
    // composer is `max-w-3xl` but shrinks with its column, so with the right
    // panel open it is nearer 415px. Five labelled buttons came to ~523px and
    // four to ~411px, both over; Commit & push, Draft PR and Push went for
    // that. A reader's own buttons can go past it, and `HandoffRow` scrolls.
    if (status.dirty > 0) offered.add("commit");
    if (canOpenPr(status) && !hasPr) offered.add("pr");
  }

  return config.flatMap((entry): HandoffAction[] => {
    if (entry.kind === "builtin") {
      if (!entry.on || !offered.has(entry.id)) return [];
      return [{ ...builtinHandoff(entry.id), builtin: entry.id }];
    }
    // An empty prompt never goes out as a send.
    const prompt = entry.prompt.trim();
    if (!hasSession || !prompt) return [];
    return [{ id: entry.id, builtin: null, label: entry.label.trim() || labelFromPrompt(prompt), prompt }];
  });
}
