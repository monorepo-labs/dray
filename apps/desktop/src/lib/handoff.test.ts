import { describe, expect, it } from "vitest";

import { DEFAULT_HANDOFF, handoffActions, labelFromPrompt, readHandoffConfig } from "./handoff";
import type { CustomHandoffButton, HandoffEntry } from "./handoff";
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
  // panel beside it rather than clipping. Three is what fits. A reader's own
  // buttons can go past it; the row truncates those.
  it("never draws more than three buttons as shipped", () => {
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
  // it longer — "in the background" — is the one clause it cannot lose, since
  // without it the CLI runs the server in a foreground Bash that times out.
  it("keeps the prompts to a few words", () => {
    for (const action of handoffActions(status({ dirty: 1 }), false, true)) {
      if (action.id === "runServer") {
        expect(action.prompt).toContain("in the background");
        continue;
      }
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

const custom = (id: string, label: string, prompt: string): CustomHandoffButton => ({
  kind: "custom",
  id,
  label,
  prompt,
});
const builtin = (id: "commit" | "pr" | "runServer", on = true): HandoffEntry => ({
  kind: "builtin",
  id,
  on,
});

describe("handoffActions with the reader's config", () => {
  const dirty = status({ dirty: 1 });

  it("hides a built-in the reader switched off", () => {
    const config = [builtin("commit", false), builtin("pr"), builtin("runServer")];
    expect(ids(dirty, false, true, config)).toEqual(["pr", "runServer"]);
  });

  // The switch only takes a built-in away; it never shows one its rule refuses.
  it("keeps a switched-on built-in's rule", () => {
    expect(ids(status(), false, true, DEFAULT_HANDOFF)).not.toContain("commit");
  });

  it("draws in the reader's order, built-ins and their own mixed", () => {
    const config = [builtin("runServer"), custom("c1", "Lint", "lint"), builtin("commit"), builtin("pr")];
    expect(ids(dirty, false, true, config)).toEqual(["runServer", "c1", "commit", "pr"]);
  });

  it("draws a custom button whenever there is a session, and never without", () => {
    const config = [...DEFAULT_HANDOFF, custom("c1", "Lint", "run the linter")];
    expect(ids(null, false, true, config)).toEqual(["runServer", "c1"]);
    expect(ids(dirty, false, false, config)).toEqual(["commit", "pr"]);
  });

  it("marks a custom button as no built-in, so it reports as one fixed name", () => {
    const [action] = handoffActions(null, false, true, [custom("c1", "L", "lint")]);
    expect(action.builtin).toBeNull();
  });

  // An empty prompt must never go out as a send.
  it("drops a custom button with nothing to send", () => {
    expect(ids(null, false, true, [custom("c1", "Lint", "  \n ")])).toEqual([]);
  });

  it("names an unlabelled custom button after its prompt's first words", () => {
    const [action] = handoffActions(null, false, true, [
      custom("c1", "", "  open a draft\npull request please"),
    ]);
    expect(action.label).toBe("open a draft");
    expect(action.prompt).toBe("open a draft\npull request please");
  });
});

describe("readHandoffConfig", () => {
  // Nothing stored, or a shape this build cannot read, must leave the row as
  // shipped rather than empty or broken.
  it("reads anything that is not a list as the defaults", () => {
    for (const raw of [null, undefined, "commit", 3, { off: [], custom: [] }]) {
      expect(readHandoffConfig(raw)).toEqual(DEFAULT_HANDOFF);
    }
  });

  it("keeps the stored order and appends a built-in it lacks, switched on", () => {
    expect(readHandoffConfig([custom("c1", "L", "p"), builtin("runServer", false)])).toEqual([
      custom("c1", "L", "p"),
      builtin("runServer", false),
      builtin("commit"),
      builtin("pr"),
    ]);
  });

  it("drops bad entries and repeated ids, and fills missing fields", () => {
    expect(
      readHandoffConfig([
        { kind: "builtin", id: "commit", on: "yes" },
        { kind: "builtin", id: "commit", on: false },
        { kind: "builtin", id: "push" },
        { kind: "custom", id: "pr", label: "x", prompt: "x" },
        { kind: "custom", id: "c1", label: 5 },
        { kind: "custom", id: "", label: "x", prompt: "x" },
        { id: "c2", label: "no kind", prompt: "x" },
        "junk",
        builtin("pr"),
        builtin("runServer"),
      ]),
    ).toEqual([builtin("commit"), custom("c1", "", ""), builtin("pr"), builtin("runServer")]);
  });
});

describe("labelFromPrompt", () => {
  it("takes the first three words", () => {
    expect(labelFromPrompt("run the  tests\tin watch mode")).toBe("run the tests");
    expect(labelFromPrompt("   ")).toBe("");
  });
});
