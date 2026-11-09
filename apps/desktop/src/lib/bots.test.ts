import { describe, expect, it } from "vitest";

import { botAt, botSession, inBotTree } from "@/lib/bots";
import type { Bot, SessionIndexItem } from "@/types/events";

const bot: Bot = { id: "b", name: "Ops", path: "/h/bots/b", created: "" };

const item = (sessionId: string, extra: Partial<SessionIndexItem> = {}) =>
  ({
    sessionId,
    cwd: "/h/bots/b",
    archived: false,
    created: "2026-11-01T00:00:00Z",
    ...extra,
  }) as SessionIndexItem;

describe("botAt", () => {
  it("matches the bot's folder with or without a trailing slash", () => {
    expect(botAt([bot], "/h/bots/b/")).toBe(bot);
    expect(botAt([bot], "/h/bots/bb")).toBeUndefined();
  });
});

describe("inBotTree", () => {
  it("holds the bot's chat and everything under it, nothing else", () => {
    const items = [
      item("chat"),
      item("child", { cwd: "/repo/wt", parentSessionId: "chat" }),
      item("grand", { cwd: "/repo/wt2", parentSessionId: "child" }),
      item("other", { cwd: "/repo" }),
    ];
    expect(inBotTree([bot], items, "grand")).toBe(true);
    expect(inBotTree([bot], items, "other")).toBe(false);
  });
});

describe("botSession", () => {
  it("is the newest unsettled session in the bot's folder", () => {
    const items = [
      item("old", { created: "2026-11-01T00:00:00Z" }),
      item("new", { created: "2026-11-02T00:00:00Z" }),
      item("settled", { created: "2026-11-03T00:00:00Z", archived: true }),
      item("elsewhere", { cwd: "/repo", created: "2026-11-04T00:00:00Z" }),
    ];
    expect(botSession(items, bot)?.sessionId).toBe("new");
  });

  it("is nothing for a bot whose chat was started fresh", () => {
    expect(botSession([item("gone", { archived: true })], bot)).toBeUndefined();
  });
});
