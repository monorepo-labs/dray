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

  // The order the work moves in: commit it, then propose it.
  it("draws the local action before the remote one", () => {
    expect(ids(status({ dirty: 1 }), false)).toEqual(["commit", "pr"]);
  });

  // The row has a width: the composer shrinks with its column, and the zone
  // that draws these is bound by nothing, so a row too wide draws over the
  // panel beside it rather than clipping. Three is what fits.
  it("never draws more than three buttons", () => {
    for (const over of [
      { dirty: 1 },
      { ahead: 2 },
      { upstream: null },
      { dirty: 9, ahead: 9, upstream: null, aheadOfBase: null },
      {},
    ]) {
      expect(ids(status(over), false, true).length).toBeLessThanOrEqual(3);
    }
  });

  // Push ran git directly and was the only action that did. It went with the
  // width, and nothing replaced it: `create a PR` pushes on the way, and a bare
  // push is a sentence in the composer.
  it("offers no push at all", () => {
    for (const over of [{ ahead: 3 }, { upstream: null }, { ahead: 3, dirty: 1 }]) {
      expect(ids(status(over), false, true)).not.toContain("push");
    }
  });

  it("offers no pull request from the branch it would land on", () => {
    expect(ids(status({ branch: "main", dirty: 2 }), false)).toEqual(["commit"]);
  });

  it("offers no pull request where there is no remote to resolve one", () => {
    expect(ids(status({ defaultBranch: null, dirty: 1 }), false)).toEqual(["commit"]);
  });

  // A branch level with its base and a clean tree has nothing to propose, and
  // the button there opens a pull request with no diff in it.
  it("offers no pull request from a branch holding nothing new", () => {
    expect(ids(status({ aheadOfBase: 0 }), false)).toEqual([]);
  });

  // The trap: `ahead` counts against the *upstream*, so a branch pushed in full
  // reads zero — and that is exactly when the pull request is most wanted.
  it("offers a pull request for a fully pushed branch", () => {
    expect(ids(status({ ahead: 0, aheadOfBase: 3 }), false)).toEqual(["pr"]);
  });

  // Uncommitted work is still work to propose: "create a PR" has the agent
  // commit on the way.
  it("offers a pull request for uncommitted work on an empty branch", () => {
    expect(ids(status({ aheadOfBase: 0, dirty: 2 }), false)).toEqual(["commit", "pr"]);
  });

  // `origin/HEAD` can be a symref onto a ref that was never fetched, so the
  // count is unknowable. Over-offering costs a click; under-offering hides it.
  it("offers a pull request when the base count is unknown", () => {
    expect(ids(status({ aheadOfBase: null }), false)).toEqual(["pr"]);
  });

  // The panel is where an existing PR is acted on; a second button here would
  // open a duplicate against the same base.
  it("drops the pull request button once one exists", () => {
    expect(ids(status({ dirty: 1 }), true)).toEqual(["commit"]);
  });

  // Nothing here reads `ahead` or `upstream` any more — those two only ever
  // answered "is there anything to push", and the row no longer asks.
  it("ignores the push counts entirely", () => {
    expect(ids(status({ ahead: 3, upstream: null }), true, true)).toEqual([
      "runServer",
    ]);
  });

  // Every action asks the agent. Push was the one that ran git itself, and it
  // owned a spinner, an error banner and a forced re-read to say so — all of it
  // gone with the button.
  it("makes every action a prompt", () => {
    const all = [
      ...handoffActions(status({ dirty: 1 }), false, true),
      ...handoffActions(status({ ahead: 1 }), false, true),
    ];
    expect(all.length).toBeGreaterThan(0);
    for (const action of all) {
      expect(typeof action.prompt).toBe("string");
      expect(action.prompt.length).toBeGreaterThan(0);
    }
  });

  // Short enough to be what the reader would have typed. A longer prompt is a
  // spec competing with the repo's own instructions about commit messages.
  //
  // `hasSession` is true so the row is the whole row, and `runServer` is then
  // skipped by name rather than dodged by leaving it out: the clause that makes
  // it longer — "in the background" — is the one clause it cannot lose, and
  // `runServer.test.ts` pins that instead. Left to the default this rule would
  // read as covered while quietly testing every button but the one it misses.
  it("keeps the prompts to a few words", () => {
    for (const action of handoffActions(status({ dirty: 1 }), false, true)) {
      if (action.id === "runServer") continue;
      expect(action.prompt.split(" ").length).toBeLessThanOrEqual(5);
    }
  });

  // Last, never first: Commit sits where the eye lands, and a third kind of
  // action at the head displaces the thing most often wanted.
  it("puts run server last in the row", () => {
    expect(ids(status({ dirty: 1 }), false, true)).toEqual(["commit", "pr", "runServer"]);
  });

  // Running a server needs no repository, so it outlives every refusal above —
  // including the two that make the row empty.
  it("offers run server where git offers nothing", () => {
    expect(ids(status({ branch: null }), false, true)).toEqual(["runServer"]);
    expect(ids(null, false, true)).toEqual(["runServer"]);
    expect(ids(status({ branch: "main" }), false, true)).toEqual(["runServer"]);
  });

  // A prompt needs somewhere to land, and the new-task composer has no session.
  it("offers no run server without a session", () => {
    expect(ids(status({ dirty: 1 }), false)).not.toContain("runServer");
    expect(ids(null, false)).toEqual([]);
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
