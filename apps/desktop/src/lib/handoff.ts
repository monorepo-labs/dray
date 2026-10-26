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
/// tool failure. The prompts stay a few words for the same reason. The model
/// knows how to commit and whether the branch has an upstream; a sentence
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
  /// Sent verbatim as if it were typed. The shipped defaults are deliberately
  /// as short as the button — the model knows how to commit, and whether the
  /// branch has an upstream, better than a sentence written here does. A
  /// reader's own prompt can be any length.
  prompt: string;
};

export type BuiltinHandoffId = "commit" | "pr" | "runServer";

/// One button as the reader configured it, in local storage. **Empty means the
/// default** on a built-in, label and prompt alike, so the stored copy carries
/// only what the reader changed and a later build's wording still reaches
/// everyone who never touched it.
export type HandoffButton = { id: string; label: string; prompt: string };

/// The three that ship, and what each says when nobody has changed it.
export const BUILTIN_HANDOFF: Record<BuiltinHandoffId, { label: string; prompt: string }> = {
  commit: { label: "Commit", prompt: "commit your changes" },
  pr: { label: "Create PR", prompt: "create a PR" },
  runServer: { label: "Run server", prompt: RUN_SERVER_PROMPT },
};

/// The row as shipped, and what Reset brings back. Stored order is draw order:
/// commit, then propose, then Run server last — Commit sits where the eye
/// lands, and a third kind of action at the head displaces the thing most
/// often wanted. A custom button is appended after them.
export const DEFAULT_HANDOFF_BUTTONS: HandoffButton[] = [
  { id: "commit", label: "", prompt: "" },
  { id: "pr", label: "", prompt: "" },
  { id: "runServer", label: "", prompt: "" },
];

export function isBuiltinHandoff(id: string): id is BuiltinHandoffId {
  return Object.hasOwn(BUILTIN_HANDOFF, id);
}

/// A stored value read back, whatever is in there. Anything that is not a list
/// of buttons — a malformed write, a shape from another build — reads as the
/// defaults rather than breaking the row, and a bad entry inside a good list
/// is dropped alone. An empty list is a real answer: every button removed.
export function readHandoffButtons(raw: unknown): HandoffButton[] {
  if (!Array.isArray(raw)) return DEFAULT_HANDOFF_BUTTONS;
  const seen = new Set<string>();
  const out: HandoffButton[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const { id, label, prompt } = entry as Record<string, unknown>;
    if (typeof id !== "string" || !id || seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      label: typeof label === "string" ? label : "",
      prompt: typeof prompt === "string" ? prompt : "",
    });
  }
  return out.length === 0 && raw.length > 0 ? DEFAULT_HANDOFF_BUTTONS : out;
}

/// What an empty label falls back to on a custom button: the prompt's first
/// few words, which is roughly what the reader would have called it.
export function labelFromPrompt(prompt: string): string {
  return prompt.trim().split(/\s+/).slice(0, 3).join(" ");
}

/// A configured button made drawable, or `null` for a custom one with nothing
/// to send — an empty prompt never goes out. A built-in left empty falls back
/// to what it ships with.
function resolve(button: HandoffButton): HandoffAction | null {
  const label = button.label.trim();
  const prompt = button.prompt.trim();
  if (isBuiltinHandoff(button.id)) {
    const shipped = BUILTIN_HANDOFF[button.id];
    return {
      id: button.id,
      builtin: button.id,
      label: label || shipped.label,
      prompt: prompt || shipped.prompt,
    };
  }
  if (!prompt) return null;
  return { id: button.id, builtin: null, label: label || labelFromPrompt(prompt), prompt };
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

/// Which buttons the composer's action row draws, in the order they are drawn:
/// the reader's configured list, each built-in kept only where its rule offers
/// it. Relabelling or re-prompting one keeps that rule — a Commit renamed "Ship
/// it" still has nothing to ship on a clean tree.
///
/// Empty means no session — with one, Run server and any custom button keep
/// the row standing.
///
/// `hasPr` comes from the sidebar's own per-repo read rather than from git:
/// once a pull request exists, the panel is where it is acted on, and a second
/// "Create PR" button would open a duplicate.
///
/// Run server is the exception to the git rules: it wants a session and nothing
/// else, and a custom button takes the same rule, since nothing here can know
/// what the reader's prompt needs. Being parked behind the sliver is what makes
/// that bearable. Nothing tracks whether a server is already up — the cheap
/// signal, `tasksBySession`, answers "some background task is live" and not
/// "this project's server is up", so gating on it would hide the button through
/// an unrelated `Monitor` run. On permanent display the button asks a question
/// it cannot answer; behind the sliver only someone who went looking sees it,
/// and going looking is wanting it.
export function handoffActions(
  status: WorkStatus | null,
  hasPr: boolean,
  hasSession = false,
  buttons: HandoffButton[] = DEFAULT_HANDOFF_BUTTONS,
): HandoffAction[] {
  const offered = new Set<BuiltinHandoffId>();

  // Running a server needs no repository. Vague about which server — the agent
  // reads the repo — but "in the background" is load-bearing in the default:
  // without it the CLI runs `pnpm dev` in a foreground Bash, which times out
  // and takes the server down with it.
  if (hasSession) offered.add("runServer");

  if (status && status.branch !== null) {
    // **The row has a width, and that is what set the shipped count.** The
    // composer is `max-w-3xl` but shrinks with its column, so with the right
    // panel open it is nearer 415px. Five labelled buttons came to ~523px and
    // four to ~411px, both over; Commit & push, Draft PR and Push went for
    // that. A reader's own buttons can go past it, and `HandoffRow` answers by
    // truncating labels inside the composer's width.
    if (status.dirty > 0) offered.add("commit");
    if (canOpenPr(status) && !hasPr) offered.add("pr");
  }

  return buttons.flatMap((button) => {
    const shown = isBuiltinHandoff(button.id) ? offered.has(button.id) : hasSession;
    const action = shown ? resolve(button) : null;
    return action ? [action] : [];
  });
}
