import type { WorkStatus } from "@/types/events";

/// One thing the reader can do with the work when a turn is over.
///
/// Almost all of these are **prompts**, sent verbatim as if typed, and that is
/// the design: the agent writes the commit message with the context it just
/// worked in, so there is no second write path, no confirm dialog and no error
/// surface — whatever goes wrong is reported in the transcript like any other
/// tool failure. The prompts are one or three words for the same reason. The
/// model knows how to commit and whether the branch has an upstream; a sentence
/// spelling it out here is a spec competing with the repo's own instructions,
/// and this repo has firm ones about commit messages.
///
/// `push` is the exception, and the line is whether there is a judgement to
/// make. Pushing has exactly one correct implementation and nothing to decide,
/// so it runs directly.
export type HandoffAction = {
  id: "commit" | "commitPush" | "push" | "pr" | "draftPr";
  label: string;
} & (
  | {
      /// Sent verbatim as if it were typed. Deliberately as short as the button
      /// — the model knows how to commit, and whether the branch has an
      /// upstream, better than a sentence written here does. Anything longer is
      /// a spec competing with the repo's own instructions.
      kind: "prompt";
      prompt: string;
    }
  | {
      /// Runs `push_branch` directly. The one action here with a single correct
      /// implementation and nothing to decide: `git push`, or `git push -u
      /// origin <branch>` where there is no upstream yet. Spending a model turn
      /// on that buys nothing and costs the reader a wait.
      kind: "push";
    }
);

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
/// Empty is the resting state and the row hides on it — outside a repo, on a
/// clean default branch with nothing to push, or anywhere the answer to "what
/// is left to do" is nothing.
///
/// `hasPr` comes from the sidebar's own per-repo read rather than from git:
/// once a pull request exists, the panel is where it is acted on, and a second
/// "Create PR" button would open a duplicate.
export function handoffActions(
  status: WorkStatus | null,
  hasPr: boolean,
): HandoffAction[] {
  if (!status || status.branch === null) return [];

  // Two ladders, each running plain-first then variant, and the row draws them
  // interleaved: Commit, Create PR, Commit & push, Draft PR. Reading across
  // gives the two things anyone does here; reading down gives each one's
  // longer form. Both ladders concatenated instead would put the two pull
  // request buttons at the far end, where the compound commit action sits
  // between the reader and the thing they most often want next.
  const local: HandoffAction[] = [];
  const remote: HandoffAction[] = [];

  if (status.dirty > 0) {
    local.push({ id: "commit", label: "Commit", kind: "prompt", prompt: "commit" });
    local.push({
      id: "commitPush",
      label: "Commit & push",
      kind: "prompt",
      prompt: "commit and push",
    });
  } else if (status.ahead > 0 || status.upstream === null) {
    // Only where there is nothing to commit: with a dirty tree the reader wants
    // the commit first, and "Commit & push" above already carries the push.
    //
    // One action for both cases, because `push_branch` is already both — it
    // sets the upstream where there isn't one. A branch nobody has pushed is
    // one nobody else can see, so the offer stands at zero commits ahead, and
    // the count comes off the label there since it would read as zero.
    local.push({
      id: "push",
      label: status.upstream === null ? "Push" : `Push ${status.ahead}`,
      kind: "push",
    });
  }

  if (canOpenPr(status) && !hasPr) {
    // Both spelled out rather than one behind the other's menu: a draft is a
    // different decision, not a variant of the same one, and burying it makes
    // the reader open a menu to find out it is there.
    remote.push({ id: "pr", label: "Create PR", kind: "prompt", prompt: "create a PR" });
    remote.push({
      id: "draftPr",
      label: "Draft PR",
      kind: "prompt",
      prompt: "create a draft PR",
    });
  }

  const actions: HandoffAction[] = [];
  for (let i = 0; i < Math.max(local.length, remote.length); i++) {
    if (local[i]) actions.push(local[i]);
    if (remote[i]) actions.push(remote[i]);
  }
  return actions;
}
