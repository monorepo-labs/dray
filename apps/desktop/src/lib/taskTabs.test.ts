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
    const chatOf = (bot: string) => (bot === "bot" ? "chat" : undefined);
    expect(stripOf(tabs, "chat", "bot", null, chatOf)).toEqual({ bot: "bot", owner: "chat", lit: null });
    expect(stripOf(tabs, "a", null, "bot", chatOf)).toEqual({ bot: "bot", owner: "chat", lit: "a" });
    // ⌘-click clears `via`: the task stands alone.
    expect(stripOf(tabs, "a", null, null, chatOf)).toBeNull();
    // A session the row does not hold.
    expect(stripOf(tabs, "b", null, "bot", chatOf)).toBeNull();
    expect(stripOf(tabs, null, null, "bot", chatOf)).toBeNull();
    // A bot with no chat left has no row to draw.
    expect(stripOf(tabs, "a", null, "bot", () => undefined)).toBeNull();
  });

  it("keeps a bot's tabs across an agent switch", () => {
    const tabs: TaskTabs = { bot: [a] };
    // The chat moved to a new session; the tabs are the bot's, not the session's.
    expect(stripOf(tabs, "a", null, "bot", () => "switched")).toEqual({ bot: "bot", owner: "switched", lit: "a" });
  });
});
