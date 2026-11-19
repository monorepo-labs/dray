import { describe, expect, it } from "vitest";

import { allMedia, loadOlderMedia, mediaKey, type HeldLog } from "@/lib/olderMedia";
import type { AgentEvent, SessionPage } from "@/types/events";

const shot = (n: number): AgentEvent =>
  ({
    id: `e-${n}`,
    sessionId: "s",
    harness: "claude_code",
    seq: n,
    ts: "2026-11-17T00:00:00Z",
    turnId: null,
    subagent: null,
    raw: null,
    payload: {
      type: "user_message",
      text: "",
      images: [{ path: `/p/${n}.png`, url: null, mimeType: "image/png" }],
      issues: [],
      baseline: null,
      queued: false,
      from: null,
      cwd: null,
    },
  }) as AgentEvent;

describe("loadOlderMedia", () => {
  it("pages past empty pages, then on into the next log, until it finds enough", async () => {
    // Log "b" is older than "a": a bot chat's earlier session.
    const pages: Record<string, Record<number, SessionPage>> = {
      a: {
        30: { events: [], olderBefore: 20 },
        20: { events: [shot(2), shot(3)], olderBefore: null },
      },
      b: { 10: { events: [shot(0), shot(1)], olderBefore: null } },
    };
    const logs: HeldLog[] = [
      { sessionId: "a", events: [shot(4)], olderBefore: 30 },
      { sessionId: "b", events: [], olderBefore: 10 },
    ];
    const read = (id: string, before: number) => Promise.resolve(pages[id][before]);

    const once = await loadOlderMedia(logs, {}, read, 2);
    expect(allMedia(logs, once).map(mediaKey)).toEqual(["/p/4.png", "/p/3.png", "/p/2.png"]);
    expect(once.b).toBeUndefined();

    const twice = await loadOlderMedia(logs, once, read, 2);
    expect(allMedia(logs, twice).map(mediaKey)).toEqual(["/p/4.png", "/p/3.png", "/p/2.png", "/p/1.png", "/p/0.png"]);
    expect(twice.a.before).toBeNull();
    expect(twice.b.before).toBeNull();
  });

  it("keeps pictures from pages the chat read back and later let go", async () => {
    // The chat paged back to byte 20 on its own, holding turns 2 and 3.
    const scrolled: HeldLog = { sessionId: "a", events: [shot(2), shot(3), shot(4)], olderBefore: 20 };
    const pages: Record<number, SessionPage> = { 20: { events: [shot(0), shot(1)], olderBefore: null } };
    const older = await loadOlderMedia([scrolled], {}, (_, before) => Promise.resolve(pages[before]), 2);
    // Back at the bottom, the chat holds its tail alone again.
    const tail: HeldLog = { sessionId: "a", events: [shot(4)], olderBefore: 30 };
    expect(allMedia([tail], older).map(mediaKey)).toEqual(["/p/4.png", "/p/3.png", "/p/2.png", "/p/1.png", "/p/0.png"]);
  });
});
