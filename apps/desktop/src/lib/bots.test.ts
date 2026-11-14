import { describe, expect, it } from "vitest";

import { botAt, botBrowser, botChat, botNamed, botSession, inBotTree, keepsChildren, previewLine } from "@/lib/bots";
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

describe("botNamed", () => {
  const twin = (id: string, name: string): Bot => ({ ...bot, id, name });
  const list = [bot, twin("r", "Research"), twin("t1", "Twin"), twin("t2", "twin")];

  it("finds a bot by id or by its name in any case, as `dray bot send` does", () => {
    expect(botNamed(list, "ops")).toBe(bot);
    expect(botNamed(list, "r")?.name).toBe("Research");
    expect(botNamed(list, "nobody")).toBeUndefined();
  });

  it("names no bot where two share the name", () => {
    expect(botNamed(list, "Twin")).toBeUndefined();
  });
});

describe("botAt", () => {
  it("matches the bot's folder with or without a trailing slash", () => {
    expect(botAt([bot], "/h/bots/b/")).toBe(bot);
    expect(botAt([bot], "/h/bots/bb")).toBeUndefined();
  });
});

describe("previewLine", () => {
  it("flattens a reply to one plain line", () => {
    expect(previewLine("**Done.** See [the PR](https://x/1).\n\n```sh\nls\n```\nNext?")).toBe(
      "Done. See the PR. Next?",
    );
  });

  it("drops heading marks and keeps a PR number", () => {
    expect(previewLine("## Status\n> Opened #908.")).toBe("Status Opened #908.");
    expect(previewLine("#917 conflicts with main.")).toBe("#917 conflicts with main.");
    expect(previewLine("Both changed `parse_args`.")).toBe("Both changed parse_args.");
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

  it("crosses a settled parent through the adoption", () => {
    const items = [
      item("chat"),
      item("sub", { cwd: "/repo/wt2", parentSessionId: "settled", adopted: { by: "chat", from: "t" } }),
    ];
    expect(inBotTree([bot], items, "sub")).toBe(true);
  });
});

describe("keepsChildren", () => {
  const items = [
    item("chat"),
    item("task", { cwd: "/repo/wt", parentSessionId: "chat" }),
    item("other", { cwd: "/repo" }),
  ];

  it("is true of a bot's task alone: its chat and other sessions settle their children", () => {
    expect(keepsChildren([bot], items, "task")).toBe(true);
    expect(keepsChildren([bot], items, "chat")).toBe(false);
    expect(keepsChildren([bot], items, "other")).toBe(false);
  });
});

describe("botBrowser", () => {
  it("is the chat's oldest session across an agent switch, and never a task's", () => {
    const items = [
      item("chat", { created: "2026-11-01T00:00:00Z" }),
      // A switch to another agent: a newer session in the same folder.
      item("switched", { created: "2026-11-02T00:00:00Z" }),
      item("task", { cwd: "/repo/wt", parentSessionId: "switched" }),
      item("other", { cwd: "/repo" }),
    ];
    expect(botBrowser([bot], items, "task")).toBeUndefined();
    expect(botBrowser([bot], items, "switched")).toBe("chat");
    expect(botBrowser([bot], items, "other")).toBeUndefined();
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

describe("botChat", () => {
  it("is every unsettled session in the bot's folder, oldest first", () => {
    const items = [
      item("codex", { created: "2026-11-02T00:00:00Z" }),
      item("claude", { created: "2026-11-01T00:00:00Z" }),
      item("settled", { created: "2026-10-01T00:00:00Z", archived: true }),
      item("elsewhere", { cwd: "/repo" }),
    ];
    expect(botChat(items, bot).map((i) => i.sessionId)).toEqual(["claude", "codex"]);
  });
});
