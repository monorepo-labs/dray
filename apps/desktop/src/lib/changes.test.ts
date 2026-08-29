import { describe, expect, it } from "vitest";

import { changeRange, splitPath } from "@/lib/changes";
import type { AgentEvent } from "@/types/events";

/// A prompt carrying a snapshot, or one that failed to take one. Only the
/// fields `changeRange` reads are filled — the rest of the envelope has no
/// bearing on which prompt gets picked.
///
/// `queued` is always false here: a queued prompt never carries a baseline, so
/// it is exactly the `null` case below under a different name.
function prompt(baseline: string | null): AgentEvent {
  return {
    id: `e-${baseline ?? "none"}`,
    sessionId: "s",
    harness: "claude_code",
    seq: 0,
    ts: "2026-08-11T00:00:00Z",
    turnId: null,
    subagent: null,
    payload: {
      type: "user_message",
      text: "hi",
      images: [],
      issues: [],
      baseline,
      queued: false,
      from: null,
      cwd: null,
    },
    raw: null,
  } as AgentEvent;
}

/// A turn's close, carrying the frozen tree it finished on — or null for a
/// non-repo, and for every turn logged before the field existed.
function turnEnd(head: string | null): AgentEvent {
  return {
    ...prompt(null),
    payload: {
      type: "turn_completed",
      status: "success",
      stopReason: null,
      finalText: null,
      usage: null,
      durationMs: null,
      head,
    },
  } as AgentEvent;
}

function noise(): AgentEvent {
  return { ...prompt(null), payload: { type: "assistant_text", block: null, text: "ok" } } as AgentEvent;
}

describe("changeRange", () => {
  it("takes the newest snapshot, so the range is the last turn", () => {
    const events = [prompt("aaa"), noise(), prompt("bbb"), noise(), prompt("ccc")];

    expect(changeRange(events).baseline).toBe("ccc");
  });

  it("freezes the head on the turn's own close", () => {
    // An idle session must stop absorbing what later touches the checkout —
    // the head is the tree the turn finished on, not the tree as of the read.
    const events = [prompt("aaa"), noise(), turnEnd("hhh")];

    expect(changeRange(events)).toEqual({ baseline: "aaa", head: "hhh" });
  });

  it("leaves the head open while the turn is still running", () => {
    // The previous turn's close sits *before* the newest prompt, so it must
    // not cap a turn it didn't end — a running turn diffs against "now".
    const events = [prompt("aaa"), turnEnd("old"), prompt("bbb"), noise()];

    expect(changeRange(events)).toEqual({ baseline: "bbb", head: null });
  });

  it("takes the newest close, so a report-back turn supersedes the prompt's own", () => {
    // A background subagent writes past its turn's result; the promptless
    // turn that narrates its findings closes on a fresher tree.
    const events = [prompt("aaa"), turnEnd("first"), turnEnd("later")];

    expect(changeRange(events).head).toBe("later");
  });

  it("skips a close that carried no snapshot rather than stopping at it", () => {
    const events = [prompt("aaa"), turnEnd("hhh"), turnEnd(null)];

    expect(changeRange(events).head).toBe("hhh");
  });

  it("falls through a prompt that took no snapshot rather than giving up", () => {
    // Otherwise the newest prompt would answer null and hide a diff the
    // previous baseline can still produce. Reachable on a worktree session,
    // whose first prompt has no tree to snapshot yet.
    expect(changeRange([prompt("aaa"), prompt(null)]).baseline).toBe("aaa");
    expect(changeRange([prompt(null), prompt("bbb")]).baseline).toBe("bbb");
  });

  it("is null when nothing recorded a snapshot", () => {
    // The ordinary state of a session in a plain directory, and of every
    // prompt logged before the field existed. Not an error.
    expect(changeRange([prompt(null), noise()])).toEqual({ baseline: null, head: null });
    expect(changeRange([])).toEqual({ baseline: null, head: null });
  });
});

describe("splitPath", () => {
  it("keeps the basename whole and leaves the trailing slash on the directory", () => {
    // The two halves are rendered adjacent, so the separator has to live on
    // one of them or the path reads as "src/libtools.ts".
    expect(splitPath("src/lib/tools.ts")).toEqual({ dir: "src/lib/", name: "tools.ts" });
    expect(splitPath("README.md")).toEqual({ dir: "", name: "README.md" });
  });
});
