import { describe, expect, it } from "vitest";

import type { CrewRow } from "@/lib/crew";
import { STALL_MS, compactAge, freshStalls, needLine, onCard, stalledTasks } from "@/lib/stalled";
import type { PrMark, SessionIndexItem } from "@/types/events";

const T0 = Date.parse("2026-11-12T10:00:00Z");

/// Marks read since the task last moved.
const fresh = () => true;

function row(id: string, over: Partial<CrewRow> = {}, item: Partial<SessionIndexItem> = {}): CrewRow {
  return {
    item: { sessionId: id, title: id, modified: new Date(T0).toISOString(), ...item } as SessionIndexItem,
    busy: false,
    background: false,
    asking: false,
    unread: false,
    ...over,
  };
}

function pr(over: Partial<PrMark> = {}): PrMark {
  return {
    number: 908,
    url: "",
    headRefName: "b",
    isDraft: false,
    state: "OPEN",
    checksState: "CLEAR",
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    reviewDecision: null,
    ...over,
  };
}

describe("stalledTasks", () => {
  it("waits five minutes before calling an idle task stalled", () => {
    expect(STALL_MS).toBe(5 * 60_000);
    const rows = [row("a")];
    expect(stalledTasks(rows, () => undefined, new Map(), T0 + STALL_MS - 1, fresh)).toEqual([]);
    const [s] = stalledTasks(rows, () => undefined, new Map(), T0 + STALL_MS, fresh);
    expect(s.kind).toBe("waiting");
  });

  it("skips a task that is working, asking or set aside", () => {
    const rows = [
      row("a", { busy: true }),
      row("b", { asking: true }),
      row("c", {}, { aside: true }),
      row("d", { background: true }),
    ];
    expect(stalledTasks(rows, () => undefined, new Map(), T0 + 2 * STALL_MS, fresh)).toEqual([]);
    const conflict = () => pr({ mergeable: "CONFLICTING" });
    expect(stalledTasks(rows, conflict, new Map(), T0 + 2 * STALL_MS, fresh)).toEqual([]);
  });

  it("counts a PR already ready from the task's last activity", () => {
    expect(stalledTasks([row("a")], () => pr(), new Map(), T0 + STALL_MS - 1, fresh)).toEqual([]);
    const [s] = stalledTasks([row("a")], () => pr(), new Map(), T0 + STALL_MS, fresh);
    expect(s.kind).toBe("ready");
    expect(s.since).toBe(T0);
  });

  it("counts a PR seen turning ready from when it turned", () => {
    const seen = new Map<string, number>();
    const rows = [row("a")];
    // Blocked but idle long enough: waiting on the reader, not ready.
    expect(stalledTasks(rows, () => pr({ mergeStateStatus: "BLOCKED" }), seen, T0 + STALL_MS, fresh)[0].kind).toBe("waiting");
    const turned = T0 + STALL_MS + 1000;
    expect(stalledTasks(rows, () => pr(), seen, turned, fresh)).toEqual([]);
    const [s] = stalledTasks(rows, () => pr(), seen, turned + STALL_MS, fresh);
    expect(s.kind).toBe("ready");
    expect(s.since).toBe(turned);
  });

  it("draws nothing for a ready PR while GitHub recomputes it", () => {
    const seen = new Map<string, number>();
    expect(stalledTasks([row("a")], () => pr(), seen, T0 + STALL_MS, fresh)[0].kind).toBe("ready");
    expect(stalledTasks([row("a")], () => pr({ mergeable: "UNKNOWN" }), seen, T0 + STALL_MS, fresh)).toEqual([]);
    expect(stalledTasks([row("a")], () => pr(), seen, T0 + STALL_MS, fresh)[0].since).toBe(T0);
  });

  it("leaves a task whose checks are still running alone", () => {
    const running = () => pr({ checksState: "RUNNING", mergeStateStatus: "BLOCKED" });
    expect(stalledTasks([row("a")], running, new Map(), T0 + 2 * STALL_MS, fresh)).toEqual([]);
  });

  it("hands what the task can mend to the bot, with the problem, at once", () => {
    const at = T0;
    const [conflict] = stalledTasks([row("a")], () => pr({ mergeable: "CONFLICTING" }), new Map(), at, fresh);
    expect(conflict).toMatchObject({ kind: "fix", problem: "PR #908 has merge conflicts." });
    const [failing] = stalledTasks([row("a")], () => pr({ checksState: "FAILING" }), new Map(), at, fresh);
    expect(failing.kind).toBe("fix");
    expect(failing.key).not.toBe(conflict.key);
    const [behind] = stalledTasks([row("a")], () => pr({ mergeStateStatus: "BEHIND" }), new Map(), at, fresh);
    expect(behind).toMatchObject({ kind: "fix", problem: "PR #908 is behind its base branch." });
    const [changes] = stalledTasks([row("a")], () => pr({ reviewDecision: "CHANGES_REQUESTED", mergeStateStatus: "BLOCKED" }), new Map(), at, fresh);
    expect(changes).toMatchObject({ kind: "fix", problem: "A review on PR #908 asked for changes." });
    expect(stalledTasks([row("a")], () => pr({ state: "MERGED" }), new Map(), at, fresh)).toEqual([]);
    const blocked = () => pr({ reviewDecision: "REVIEW_REQUIRED", mergeStateStatus: "BLOCKED" });
    expect(stalledTasks([row("a")], blocked, new Map(), at, fresh)).toEqual([]);
    expect(stalledTasks([row("a")], blocked, new Map(), T0 + STALL_MS, fresh)[0].kind).toBe("waiting");
  });

  it("waits out the stall on a fix judged by a mark older than the task's last move", () => {
    const failing = () => pr({ checksState: "FAILING" });
    const stale = () => false;
    expect(stalledTasks([row("a")], failing, new Map(), T0 + 60_000, stale)).toEqual([]);
    expect(stalledTasks([row("a")], failing, new Map(), T0 + STALL_MS, stale)[0].kind).toBe("fix");
  });

  it("reads a need only where the bot wrote it since the task moved", () => {
    const stall = (need?: { text: string; at: string }) =>
      stalledTasks([row("a", {}, { need })], () => undefined, new Map(), T0 + STALL_MS, fresh)[0];
    expect(onCard(stall())).toBe(true);
    expect(needLine(stall())).toBeUndefined();
    expect(needLine(stall({ text: "Pick one", at: new Date(T0 + 1000).toISOString() }))).toBe("Pick one");
    expect(needLine(stall({ text: "Pick one", at: new Date(T0 - 1000).toISOString() }))).toBeUndefined();
    expect(onCard(stalledTasks([row("a")], () => pr(), new Map(), T0 + STALL_MS, fresh)[0])).toBe(true);
    expect(onCard(stalledTasks([row("a")], () => pr({ mergeable: "CONFLICTING" }), new Map(), T0, fresh)[0])).toBe(false);
  });

  it("hands each stall to the banner once", () => {
    const seen = new Set<string>();
    const stalls = stalledTasks([row("a"), row("b")], () => undefined, new Map(), T0 + STALL_MS, fresh);
    expect(freshStalls(seen, stalls)).toHaveLength(2);
    expect(freshStalls(seen, stalls)).toHaveLength(0);
  });

  it("says its age the way an inbox row does", () => {
    const at = new Date(T0).toISOString();
    expect(compactAge(at, T0 + 45 * 60_000)).toBe("45m");
    expect(compactAge(at, T0 + 2.5 * 3_600_000)).toBe("2h");
    expect(compactAge(at, T0 + 50 * 3_600_000)).toBe("2d");
  });

  it("names a new stall once the task moves", () => {
    const [a] = stalledTasks([row("a")], () => undefined, new Map(), T0 + STALL_MS, fresh);
    const later = new Date(T0 + 1000).toISOString();
    const [b] = stalledTasks([row("a", {}, { modified: later })], () => undefined, new Map(), T0 + 2 * STALL_MS, fresh);
    expect(a.key).not.toBe(b.key);
  });

  it("keeps one key for a fix across checks, so it is nudged once", () => {
    const conflict = () => pr({ mergeable: "CONFLICTING" });
    const [a] = stalledTasks([row("a")], conflict, new Map(), T0, fresh);
    const [b] = stalledTasks([row("a")], conflict, new Map(), T0 + 60_000, fresh);
    expect(a.key).toBe(b.key);
  });
});
