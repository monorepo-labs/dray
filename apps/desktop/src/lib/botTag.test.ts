import { beforeAll, describe, expect, it, vi } from "vitest";

import type { Bot } from "@/types/events";

const ID = "019a3f2c-7b41-7d3e-9f80-12ab34cd56ef";
const OTHER = "019a3f2c-7b41-7d3e-9f80-12ab34cd56aa";

// The bot list comes over the transport; this one answers with a single bot.
vi.mock("@/lib/transport", () => ({
  LOCAL: "local",
  serverOfPath: () => "local",
  serverOfSession: () => "local",
  listen: async () => () => {},
  invoke: async (cmd: string): Promise<Bot[]> =>
    cmd === "list_bots" ? [{ id: ID, name: "Research Bot", path: "/bots/r", created: "" }] : [],
}));

const { refreshBots } = await import("@/lib/bots");
const { highlightSegments } = await import("@/lib/highlight");
const { applyBot, botTag } = await import("@/lib/sessionTag");

beforeAll(() => refreshBots());

describe("bot tags", () => {
  it("writes the name and id over the @ token", () => {
    const span = { start: 4, end: 7, query: "Op" };
    expect(applyBot("ask @Op please", span, "Ops", ID)).toEqual({
      text: `ask @Ops (${ID}) please`,
      caret: 4 + `@Ops (${ID})`.length + 1,
    });
  });

  it("reads a placed tag as a bot, and a file mention before it as a file", () => {
    const segments = highlightSegments(`see @src/a.ts and @Research Bot (${ID}) now`);
    expect(segments.map((s) => s.kind)).toEqual(["text", "mention", "text", "bot", "text"]);
    expect(segments[3]).toMatchObject({ inner: "@Research Bot", botId: ID });
  });

  it("leaves a mention followed by an id that names no bot a file", () => {
    const kinds = highlightSegments(`@README.md (${OTHER})`).map((s) => s.kind);
    expect(kinds[0]).toBe("mention");
    expect(kinds).not.toContain("bot");
  });

  it("keeps a name holding its own id or a newline readable as one tag", () => {
    const tag = botTag(`Odd (${OTHER})\nname`, ID);
    expect(tag).toBe(`@Odd name (${ID})`);
    expect(highlightSegments(tag)).toMatchObject([{ kind: "bot", botId: ID }]);
  });
});
