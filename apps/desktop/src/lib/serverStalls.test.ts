import { describe, expect, it } from "vitest";

import type { CrewRow } from "@/lib/crew";
import { serverCard } from "@/lib/serverStalls";
import { needLine } from "@/lib/stalled";
import { serverOfPath } from "@/lib/transport";
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

const card = (rows: StallRow[]): BotStalls => ({ botId: "b", chatId: "c", rows, tasks: rows.length, fixes: [] });

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

  it("draws nothing for a bot with no card", () => {
    expect(serverCard(undefined, [crew("a")], "local")).toEqual([]);
  });
});
