import { RUN_SERVER_PROMPT } from "@/lib/runServer";
import type { WorkStatus } from "@/types/events";

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
/// There used to be a second kind. `push` ran `push_branch` directly, on the
/// grounds that pushing has one correct implementation and nothing to decide —
/// and it owned both ends of its own feedback because it reported into no
/// transcript: a spinner on the button, an error banner above the composer, a
/// forced `work_status` re-read to correct the count it drew. All of that was
/// machinery for one button in a row with no room for it. `create a PR` pushes
/// on the way, and a bare push is a sentence anyone can type.
export type HandoffAction = {
  id: "commit" | "pr" | "runServer";
  label: string;
  /// Sent verbatim as if it were typed. Deliberately as short as the button —
  /// the model knows how to commit, and whether the branch has an upstream,
  /// better than a sentence written here does. Anything longer is a spec
  /// competing with the repo's own instructions.
  prompt: string;
};

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

/// Which buttons the composer's action row draws, in the order they are drawn.
///
/// Empty means no session — with one, Run server alone keeps the row standing.
///
/// `hasPr` comes from the sidebar's own per-repo read rather than from git:
/// once a pull request exists, the panel is where it is acted on, and a second
/// "Create PR" button would open a duplicate.
///
/// Run server is the exception to all of it: it wants a session and nothing
/// else, so it survives both refusals below and is the one action offered
/// unconditionally. Being parked behind the sliver is what makes that bearable.
/// Nothing tracks whether a server is already up — the cheap signal,
/// `tasksBySession`, answers "some background task is live" and not "this
/// project's server is up", so gating on it would hide the button through an
/// unrelated `Monitor` run, and a real answer is the config-and-detection
/// feature that was deliberately dropped. On permanent display the button asks
/// a question it cannot answer; behind the sliver only someone who went looking
/// sees it, and going looking is wanting it.
///
/// The cost, accepted: with a session open the row never hides, so the empty
/// return below is near-dead and the composer permanently carries the reserve.
export function handoffActions(
  status: WorkStatus | null,
  hasPr: boolean,
  hasSession = false,
): HandoffAction[] {
  // Built ahead of the git checks rather than beside them, because running a
  // server needs no repository to run in.
  const run: HandoffAction[] = hasSession
    ? [{ id: "runServer", label: "Run server", prompt: RUN_SERVER_PROMPT }]
    : [];

  if (!status || status.branch === null) return run;

  // Two git actions, in the order the work moves: commit it, then propose it.
  //
  // **The row has a width, and that is what set this count.** The composer is
  // `max-w-3xl` but shrinks with its column, so with the right panel open it is
  // nearer 415px — 391px inside its padding. The zone that draws these is
  // `absolute w-fit`, bound by nothing, so a row too wide does not clip: it
  // draws over the panel beside it. Five labelled buttons came to ~523px and
  // four to ~411px, both over. Commit & push, Draft PR and Push went for that,
  // leaving ~289px.
  //
  // None of them put anything out of reach. Commit & push is two clicks a turn
  // apart, since committing is what leaves a clean tree behind. A draft and a
  // bare push are both sentences in the composer — the same bargain every
  // button here already is — and `create a PR` pushes on the way regardless.
  const actions: HandoffAction[] = [];

  if (status.dirty > 0) {
    actions.push({ id: "commit", label: "Commit", prompt: "commit your changes" });
  }

  if (canOpenPr(status) && !hasPr) {
    actions.push({ id: "pr", label: "Create PR", prompt: "create a PR" });
  }

  // Last, never first. Commit sits where the eye lands, and a third kind of
  // action at the head displaces the thing most often wanted.
  return [...actions, ...run];
}
