import { describe, expect, it } from "vitest";

import {
  addPickTab,
  closePickTab,
  closePicksOn,
  closeTaskTab,
  newestSession,
  openTaskTab,
  pickFilesKey,
  repickTab,
  stripOf,
  type PickTabs,
  type TaskTabs,
} from "./taskTabs";

const a = { sessionId: "a", title: "A" };
const b = { sessionId: "b", title: "B" };

describe("task tabs", () => {
  it("opens once and in order", () => {
    let tabs: TaskTabs = {};
    tabs = openTaskTab(tabs, "bot", a);
    tabs = openTaskTab(tabs, "bot", b);
    const same = openTaskTab(tabs, "bot", a);
    expect(same).toBe(tabs);
    expect(tabs.bot.map((t) => t.sessionId)).toEqual(["a", "b"]);
  });

  it("closes from every row and drops an emptied one", () => {
    const tabs: TaskTabs = { bot: [a, b], other: [a] };
    expect(closeTaskTab(tabs, "a")).toEqual({ bot: [b] });
    expect(closeTaskTab(tabs, "zzz")).toBe(tabs);
  });

  it("draws the bot's row over its lit task, and only when stepped into from it", () => {
    const tabs: TaskTabs = { bot: [a] };
    expect(stripOf(tabs, "bot", true, null)).toEqual({ owner: "bot", lit: null });
    expect(stripOf(tabs, "a", false, "bot")).toEqual({ owner: "bot", lit: "a" });
    // ⌘-click clears `via`: the task stands alone.
    expect(stripOf(tabs, "a", false, null)).toBeNull();
    // A session the row does not hold.
    expect(stripOf(tabs, "b", false, "bot")).toBeNull();
    expect(stripOf(tabs, null, false, "bot")).toBeNull();
  });
});

describe("pick tabs", () => {
  const d = { id: "1", kind: "changes" as const, target: "a" };
  const f = { id: "2", kind: "files" as const, target: "bot" };

  it("adds several of one kind, repicks one, closes one", () => {
    let tabs: PickTabs = {};
    tabs = addPickTab(tabs, "bot", d);
    tabs = addPickTab(tabs, "bot", { ...d, id: "3" });
    tabs = addPickTab(tabs, "bot", f);
    expect(tabs.bot.map((t) => t.id)).toEqual(["1", "3", "2"]);
    tabs = repickTab(tabs, "bot", "3", "b");
    expect(tabs.bot[1]).toEqual({ id: "3", kind: "changes", target: "b" });
    expect(tabs.bot[0].target).toBe("a");
    tabs = closePickTab(tabs, "bot", "1");
    expect(tabs.bot.map((t) => t.id)).toEqual(["3", "2"]);
    expect(closePickTab({ bot: [d] }, "bot", "1")).toEqual({});
  });

  it("closes every tab on a deleted task", () => {
    const tabs: PickTabs = { bot: [d, f], other: [{ ...d, id: "9" }] };
    expect(closePicksOn(tabs, "a")).toEqual({ bot: [f] });
    expect(closePicksOn(tabs, "zzz")).toBe(tabs);
    const both: PickTabs = { bot: [d, { ...f, target: "a" }] };
    expect(closePicksOn(both, "a", "files")).toEqual({ bot: [d] });
    expect(closePicksOn({ bot: [d] }, "a", "files")).toEqual({ bot: [d] });
  });

  it("keys a Files pick's store by tab and target", () => {
    expect(pickFilesKey(f)).toBe("pick:2:bot");
    expect(pickFilesKey({ ...f, target: "a" })).not.toBe(pickFilesKey(f));
  });

  it("finds the most recently active session", () => {
    expect(newestSession([])).toBeNull();
    expect(
      newestSession([
        { sessionId: "a", modified: "2026-11-01T10:00:00Z" },
        { sessionId: "b", modified: "2026-11-02T10:00:00Z" },
        { sessionId: "c", modified: "2026-10-30T10:00:00Z" },
      ]),
    ).toBe("b");
  });
});
