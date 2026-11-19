import { describe, expect, it } from "vitest";

import { cardDue, EXPECT_MS, readyForCard, SETTLE_MS, turnEnded, watchPr } from "@/lib/autoMergeCard";
import type { PrMark } from "@/types/events";

const mark = (over: Partial<PrMark>): PrMark => ({
  number: 7,
  url: "u",
  headRefName: "b",
  isDraft: false,
  state: "OPEN",
  checksState: "CLEAR",
  mergeable: "MERGEABLE",
  mergeStateStatus: "CLEAN",
  reviewDecision: null,
  headOid: "a1",
  checkCount: 2,
  ...over,
});

describe("readyForCard", () => {
  it("takes GitHub's own CLEAN verdict", () => {
    expect(readyForCard(mark({}))).toBe(true);
    expect(readyForCard(mark({ reviewDecision: "APPROVED" }))).toBe(true);
  });

  it("waits on anything else GitHub says, and on checks still running", () => {
    for (const mergeStateStatus of ["BLOCKED", "BEHIND", "UNSTABLE", "DIRTY", "UNKNOWN", "HAS_HOOKS"]) {
      expect(readyForCard(mark({ mergeStateStatus }))).toBe(false);
    }
    expect(readyForCard(mark({ checksState: "RUNNING" }))).toBe(false);
    expect(readyForCard(mark({ isDraft: true }))).toBe(false);
    expect(readyForCard(mark({ state: "MERGED" }))).toBe(false);
  });
});

describe("cardDue", () => {
  it("holds a CLEAN read taken the moment a push lands", () => {
    // GitHub reads CLEAN before any check has registered.
    const first = mark({ checkCount: 0 });
    const watch = watchPr(undefined, first, 1_000);
    expect(cardDue(first, watch, 1_000)).toBe(false);
  });

  it("posts once ready holds on a read a settle window later", () => {
    const watch = watchPr(undefined, mark({}), 0);
    expect(cardDue(mark({}), watchPr(watch, mark({}), SETTLE_MS - 1), SETTLE_MS - 1)).toBe(false);
    expect(cardDue(mark({}), watchPr(watch, mark({}), SETTLE_MS), SETTLE_MS)).toBe(true);
  });

  it("waits out checks that register late in the window", () => {
    let watch = watchPr(undefined, mark({ checkCount: 0 }), 0);
    const running = mark({ checkCount: 2, checksState: "RUNNING", mergeStateStatus: "UNSTABLE" });
    watch = watchPr(watch, running, 30_000);
    expect(cardDue(running, watch, 30_000)).toBe(false);
    const passed = mark({ checkCount: 2 });
    watch = watchPr(watch, passed, 90_000);
    expect(cardDue(passed, watch, 90_000)).toBe(true);
  });

  it("restarts the wait on a push, expecting the checks the last tip had", () => {
    let watch = watchPr(undefined, mark({ checkCount: 3, checksState: "FAILING" }), 0);
    const pushed = mark({ headOid: "b2", checkCount: 1 });
    watch = watchPr(watch, pushed, 100_000);
    expect(watch).toMatchObject({ head: "b2", since: 100_000, expected: 3 });
    // Ready by GitHub's word, but two of the last tip's checks have not started.
    expect(cardDue(pushed, watchPr(watch, pushed, 200_000), 200_000)).toBe(false);
    const full = mark({ headOid: "b2", checkCount: 3 });
    expect(cardDue(full, watchPr(watch, full, 200_000), 200_000)).toBe(true);
    // A check that never comes is given up on.
    expect(cardDue(pushed, watch, 100_000 + EXPECT_MS)).toBe(true);
  });

  it("settles a repo with no CI, and a server too old to name the tip", () => {
    const bare = mark({ checkCount: 0 });
    expect(cardDue(bare, watchPr(undefined, bare, 0), SETTLE_MS)).toBe(true);
    const old = mark({ headOid: undefined, checkCount: undefined });
    const watch = watchPr(undefined, old, 0);
    expect(cardDue(old, watchPr(watch, old, SETTLE_MS), SETTLE_MS)).toBe(true);
  });

  it("never posts what GitHub does not call ready", () => {
    const blocked = mark({ mergeStateStatus: "BLOCKED" });
    expect(cardDue(blocked, watchPr(undefined, blocked, 0), EXPECT_MS)).toBe(false);
  });
});

describe("turnEnded", () => {
  const ended = "2026-11-19T10:00:00.000Z";
  const at = Date.parse(ended);

  it("holds the card while the task is mid-turn", () => {
    expect(turnEnded("in_progress", ended, at + 60_000)).toBe(false);
  });

  it("waits for a read asked after the turn ended", () => {
    // Asked before the turn's last push could show.
    expect(turnEnded("completed", ended, at - 1)).toBe(false);
    expect(turnEnded("completed", ended, at)).toBe(true);
    expect(turnEnded("idle", ended, at + 30_000)).toBe(true);
  });

  it("takes an unreadable time as ended", () => {
    expect(turnEnded("idle", "", 0)).toBe(true);
  });
});
