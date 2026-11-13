import { describe, expect, it } from "vitest";

import { cardChat, greptileClears } from "@/lib/autoMergeCard";
import type { Bot, GreptileReview, SessionIndexItem } from "@/types/events";

const review = (over: Partial<GreptileReview>): GreptileReview => ({
  present: true,
  score: 5,
  stale: false,
  unresolved: 0,
  ...over,
});

describe("greptileClears", () => {
  it("passes a repo without Greptile on GitHub's verdict alone", () => {
    expect(greptileClears(review({ present: false, score: null }), 5)).toBe(true);
  });

  it("waits for a score, and for a review of the head", () => {
    expect(greptileClears(review({ score: null }), 5)).toBe(false);
    expect(greptileClears(review({ stale: true }), 5)).toBe(false);
  });

  it("takes the minimum, or one below with every thread resolved", () => {
    expect(greptileClears(review({ score: 5, unresolved: 2 }), 5)).toBe(true);
    expect(greptileClears(review({ score: 4, unresolved: 0 }), 5)).toBe(true);
    expect(greptileClears(review({ score: 4, unresolved: 1 }), 5)).toBe(false);
    expect(greptileClears(review({ score: 3, unresolved: 0 }), 5)).toBe(false);
    expect(greptileClears(review({ score: 3, unresolved: 0 }), 4)).toBe(true);
  });
});

describe("cardChat", () => {
  const bot: Bot = { id: "b", name: "Ops", path: "/h/bots/b", created: "" };
  const item = (sessionId: string, extra: Partial<SessionIndexItem> = {}) =>
    ({
      sessionId,
      cwd: "/repo",
      archived: false,
      parentSessionId: null,
      created: "2026-11-01T00:00:00Z",
      ...extra,
    }) as SessionIndexItem;
  const chat = (items: SessionIndexItem[], task: SessionIndexItem) =>
    cardChat(task, new Map(items.map((i) => [i.sessionId, i])), items, [bot]);

  it("posts to the session that started the task", () => {
    const parent = item("p");
    const task = item("t", { parentSessionId: "p" });
    expect(chat([parent, task], task)).toBe("p");
  });

  it("posts nowhere for a session no one started, or a settled one", () => {
    const parent = item("p", { archived: true });
    const task = item("t", { parentSessionId: "p" });
    expect(chat([parent, task], task)).toBeNull();
    expect(chat([parent], item("lone"))).toBeNull();
    expect(chat([item("p"), task], { ...task, archived: true })).toBeNull();
  });

  it("posts a bot's task to the bot's current chat after Start fresh", () => {
    const old = item("c1", { cwd: bot.path, archived: true });
    const fresh = item("c2", { cwd: bot.path, created: "2026-11-02T00:00:00Z" });
    const task = item("t", { parentSessionId: "c1" });
    expect(chat([old, fresh, task], task)).toBe("c2");
  });
});
