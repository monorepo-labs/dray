import { describe, expect, it } from "vitest";

import { closeTaskTab, openTaskTab, stripOf, type TaskTabs } from "./taskTabs";

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
