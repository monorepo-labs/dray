import { describe, expect, it } from "vitest";

import type { CrewRow } from "@/lib/crew";
import { STALL_MS, compactAge, freshStalls, stalledTasks } from "@/lib/stalled";
import type { PrMark, SessionIndexItem } from "@/types/events";

const T0 = Date.parse("2026-11-12T10:00:00Z");

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
    ...over,
  };
}

describe("stalledTasks", () => {
  it("waits the whole stall before calling an idle task stalled", () => {
    const rows = [row("a")];
    expect(stalledTasks(rows, () => undefined, new Map(), T0 + STALL_MS - 1)).toEqual([]);
    const [s] = stalledTasks(rows, () => undefined, new Map(), T0 + STALL_MS);
    expect(s.kind).toBe("waiting");
  });

  it("skips a task that is working, asking or set aside", () => {
    const rows = [
      row("a", { busy: true }),
      row("b", { asking: true }),
      row("c", {}, { aside: true }),
      row("d", { background: true }),
    ];
    expect(stalledTasks(rows, () => undefined, new Map(), T0 + 2 * STALL_MS)).toEqual([]);
  });

  it("counts a PR already ready from the task's last activity", () => {
    const [s] = stalledTasks([row("a")], () => pr(), new Map(), T0 + STALL_MS);
    expect(s.kind).toBe("ready");
    expect(s.since).toBe(T0);
  });

  it("counts a PR seen turning ready from when it turned", () => {
    const seen = new Map<string, number>();
    const rows = [row("a")];
    // Blocked but idle long enough: waiting on the reader, not ready.
    expect(stalledTasks(rows, () => pr({ mergeStateStatus: "BLOCKED" }), seen, T0 + STALL_MS)[0].kind).toBe("waiting");
    const turned = T0 + STALL_MS + 1000;
    expect(stalledTasks(rows, () => pr(), seen, turned)).toEqual([]);
    const [s] = stalledTasks(rows, () => pr(), seen, turned + STALL_MS);
    expect(s.kind).toBe("ready");
    expect(s.since).toBe(turned);
  });

  it("draws nothing for a ready PR while GitHub recomputes it", () => {
    const seen = new Map<string, number>();
    expect(stalledTasks([row("a")], () => pr(), seen, T0 + STALL_MS)[0].kind).toBe("ready");
    expect(stalledTasks([row("a")], () => pr({ mergeable: "UNKNOWN" }), seen, T0 + STALL_MS)).toEqual([]);
    expect(stalledTasks([row("a")], () => pr(), seen, T0 + STALL_MS)[0].since).toBe(T0);
  });

  it("leaves a task whose checks are still running alone", () => {
    const running = () => pr({ checksState: "RUNNING", mergeStateStatus: "BLOCKED" });
    expect(stalledTasks([row("a")], running, new Map(), T0 + 2 * STALL_MS)).toEqual([]);
  });

  it("hands each stall to the banner once", () => {
    const seen = new Set<string>();
    const stalls = stalledTasks([row("a"), row("b")], () => undefined, new Map(), T0 + STALL_MS);
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
    const [a] = stalledTasks([row("a")], () => undefined, new Map(), T0 + STALL_MS);
    const later = new Date(T0 + 1000).toISOString();
    const [b] = stalledTasks([row("a", {}, { modified: later })], () => undefined, new Map(), T0 + 2 * STALL_MS);
    expect(a.key).not.toBe(b.key);
  });
});
