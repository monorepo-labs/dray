import { describe, expect, it } from "vitest";

import { handoffActions } from "./handoff";
import type { WorkStatus } from "@/types/events";

const status = (over: Partial<WorkStatus> = {}): WorkStatus => ({
  dirty: 0,
  branch: "feature",
  upstream: "origin/feature",
  ahead: 0,
  defaultBranch: "main",
  aheadOfBase: 2,
  ...over,
});

const ids = (...args: Parameters<typeof handoffActions>) =>
  handoffActions(...args).map((a) => a.id);

describe("handoffActions", () => {
  it("offers nothing outside a repository", () => {
    expect(ids(status({ branch: null }), false)).toEqual([]);
    expect(ids(null, false)).toEqual([]);
  });

  it("offers nothing on a settled default branch", () => {
    expect(ids(status({ branch: "main" }), false)).toEqual([]);
  });

  // Reading across gives the two things anyone does here; reading down gives
  // each one's longer form.
  it("interleaves the local and remote ladders", () => {
    expect(ids(status({ dirty: 1 }), false)).toEqual([
      "commit",
      "pr",
      "commitPush",
      "draftPr",
    ]);
  });

  // One ladder shorter than the other must not leave a hole or reorder the rest.
  it("keeps order when only one ladder has entries", () => {
    expect(ids(status({ ahead: 2 }), false)).toEqual(["push", "pr", "draftPr"]);
  });

  it("offers no pull request from the branch it would land on", () => {
    expect(ids(status({ branch: "main", dirty: 2 }), false)).toEqual([
      "commit",
      "commitPush",
    ]);
  });

  it("offers no pull request where there is no remote to resolve one", () => {
    expect(ids(status({ defaultBranch: null, dirty: 1 }), false)).toEqual([
      "commit",
      "commitPush",
    ]);
  });

  // A branch level with its base and a clean tree has nothing to propose, and
  // the button there opens a pull request with no diff in it.
  it("offers no pull request from a branch holding nothing new", () => {
    expect(ids(status({ aheadOfBase: 0 }), false)).toEqual([]);
  });

  // The trap: `ahead` counts against the *upstream*, so a branch pushed in full
  // reads zero — and that is exactly when the pull request is most wanted.
  it("offers a pull request for a fully pushed branch", () => {
    expect(ids(status({ ahead: 0, aheadOfBase: 3 }), false)).toEqual(["pr", "draftPr"]);
  });

  // Uncommitted work is still work to propose: "create a PR" has the agent
  // commit on the way.
  it("offers a pull request for uncommitted work on an empty branch", () => {
    expect(ids(status({ aheadOfBase: 0, dirty: 2 }), false)).toEqual([
      "commit",
      "pr",
      "commitPush",
      "draftPr",
    ]);
  });

  // `origin/HEAD` can be a symref onto a ref that was never fetched, so the
  // count is unknowable. Over-offering costs a click; under-offering hides it.
  it("offers a pull request when the base count is unknown", () => {
    expect(ids(status({ aheadOfBase: null }), false)).toEqual(["pr", "draftPr"]);
  });

  // The panel is where an existing PR is acted on; a second button here would
  // open a duplicate against the same base.
  it("drops the pull request buttons once one exists", () => {
    expect(ids(status({ dirty: 1 }), true)).toEqual(["commit", "commitPush"]);
  });

  // With a dirty tree the commit comes first, and "Commit & push" already
  // carries the push — a third button would be the same action twice.
  it("does not offer push beside commit", () => {
    expect(ids(status({ dirty: 1, ahead: 3 }), true)).toEqual([
      "commit",
      "commitPush",
    ]);
  });

  it("offers push only once the tree is clean", () => {
    expect(ids(status({ ahead: 3 }), true)).toEqual(["push"]);
  });

  // A branch nobody has pushed is one nobody else can see, so the offer stands
  // even at zero ahead. `push_branch` sets the upstream itself, so this is the
  // same action rather than a second one.
  it("offers push for a branch with no upstream", () => {
    const [action] = handoffActions(status({ upstream: null }), true);
    expect(action.id).toBe("push");
    // No count: an unpublished branch is ahead of nothing, and "Push 0" would
    // answer a question nobody asked yet.
    expect(action.label).toBe("Push");
  });

  it("counts the commits in the push label", () => {
    expect(handoffActions(status({ ahead: 3 }), true)[0].label).toBe("Push 3");
  });

  // Push runs git directly; everything else asks the agent. Getting this wrong
  // either spends a model turn on a one-liner or silently drops a click.
  it("marks push as the only action that is not a prompt", () => {
    const all = [
      ...handoffActions(status({ dirty: 1 }), false),
      ...handoffActions(status({ ahead: 1 }), false),
    ];
    for (const action of all) {
      expect(action.kind).toBe(action.id === "push" ? "push" : "prompt");
    }
  });

  // Short enough to be what the reader would have typed. A longer prompt is a
  // spec competing with the repo's own instructions about commit messages.
  it("keeps the prompts to a few words", () => {
    for (const action of handoffActions(status({ dirty: 1 }), false)) {
      if (action.kind !== "prompt") continue;
      expect(action.prompt.split(" ").length).toBeLessThanOrEqual(5);
    }
  });

  // Every id needs a glyph in `HandoffRow`'s map, and a duplicate id in one row
  // would also collide as a React key.
  it("never repeats an id in one row", () => {
    for (const over of [{ dirty: 1 }, { ahead: 2 }, { upstream: null }, {}]) {
      const drawn = ids(status(over), false);
      expect(new Set(drawn).size).toBe(drawn.length);
    }
  });
});
