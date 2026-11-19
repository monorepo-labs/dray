import { describe, expect, it, vi } from "vitest";

import type { CrewRow } from "@/lib/crew";
import { askStalls, cardsOf, listenForStalls, serverCard } from "@/lib/serverStalls";
import { needLine } from "@/lib/stalled";
import { invoke, listen, serverOfPath } from "@/lib/transport";

vi.mock("@/lib/transport", async (actual) => ({
  ...(await actual<typeof import("@/lib/transport")>()),
  invoke: vi.fn(),
  listen: vi.fn(),
}));
import type { BotStalls, SessionIndexItem, StallRow } from "@/types/events";

const MODIFIED = "2026-11-12T10:00:00Z";

function item(id: string, over: Partial<SessionIndexItem> = {}): SessionIndexItem {
  return { sessionId: id, title: id, cwd: "/r", projectPath: "/r", modified: MODIFIED, ...over } as SessionIndexItem;
}

function crew(id: string, over: Partial<CrewRow> = {}, i: Partial<SessionIndexItem> = {}): CrewRow {
  return { item: item(id, i), busy: false, asking: false, unread: false, background: false, serving: [], ...over };
}

function stall(id: string, over: Partial<StallRow> = {}): StallRow {
  return { key: `${id}:waiting:${MODIFIED}`, kind: "waiting", checking: false, since: 1, item: item(id), offline: false, ...over };
}

const card = (rows: StallRow[]): BotStalls => ({
  botId: "b",
  chatId: "c",
  rows,
  tasks: rows.length,
  fixes: [],
  judged: rows.map((r) => r.item.sessionId),
});

describe("serverCard", () => {
  it("draws a held task from its own row, in the server's order and with its need", () => {
    const own = crew("a");
    const [s, t] = serverCard(card([stall("a", { need: "Answer it" }), stall("b")]), [crew("b"), own], "local");
    expect(s.row).toBe(own);
    expect(s.key).toBe(`a:waiting:${MODIFIED}`);
    expect(needLine(s)).toBe("Answer it");
    expect(needLine(t)).toBeUndefined();
    expect(s.offline).toBeUndefined();
  });

  it("drops a task that moved since the server judged it", () => {
    const rows = [crew("a", {}, { modified: "2026-11-12T10:05:00Z" }), crew("b", { busy: true })];
    expect(serverCard(card([stall("a"), stall("b")]), rows, "local")).toEqual([]);
  });

  it("keeps a ready row checking and never mergeable", () => {
    const [s] = serverCard(card([stall("a", { kind: "ready", checking: true })]), [crew("a")], "local");
    expect(s.kind).toBe("ready");
    expect(s.checking).toBe(true);
  });

  it("draws a task on a machine this app cannot reach as offline, keyed off any known server", () => {
    const [s] = serverCard(card([stall("far", { machine: "boat", offline: true })]), [], "local");
    expect(s.offline).toBe("boat is offline");
    expect(serverOfPath(s.row.item.cwd)).toBe("machine:boat");
  });

  it("merges a task it cannot reach through the bot's server, by repo", () => {
    const pr = { number: 7, url: "https://github.com/acme/widgets/pull/7" } as StallRow["pr"];
    const [far] = serverCard(card([stall("far", { kind: "ready", machine: "boat", pr })]), [], "srv");
    expect(far.via).toEqual({ server: "srv", repo: "acme/widgets" });
    const [held] = serverCard(card([stall("a", { kind: "ready", pr })]), [crew("a")], "srv");
    expect(held.via).toBeUndefined();
  });

  it("draws nothing for a bot with no card", () => {
    expect(serverCard(undefined, [crew("a")], "local")).toEqual([]);
  });
});

describe("askStalls", () => {
  it("keeps a bot's newer card when the reply was overtaken, and takes the rest from the reply", async () => {
    const handlers: Record<string, (e: { server: string; payload: unknown }) => void> = {};
    vi.mocked(listen).mockImplementation(async (name, handler) => {
      handlers[name] = handler as never;
      return () => {};
    });
    let answer: (v: BotStalls[]) => void = () => {};
    vi.mocked(invoke).mockReturnValue(new Promise((resolve) => (answer = resolve as never)));
    listenForStalls();
    const asked = askStalls("srv");
    const newer = { ...card([stall("a2")]), botId: "A" };
    handlers.bot_stalls_changed({ server: "srv", payload: newer });
    answer([{ ...card([stall("a1")]), botId: "A" }, { ...card([stall("b1")]), botId: "B" }]);
    await asked;
    const held = cardsOf("srv") ?? [];
    expect(held.find((c) => c.botId === "A")).toBe(newer);
    expect(held.find((c) => c.botId === "B")?.rows[0].key).toBe(`b1:waiting:${MODIFIED}`);
  });
});
