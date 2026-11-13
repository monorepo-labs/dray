import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: async () => null, convertFileSrc: (p: string) => p }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));

const { wholeHistory } = await import("./cloudTranscripts");
import type { AgentEvent, SessionPage, SessionSnapshot } from "@/types/events";

const ev = (id: string) => ({ id }) as AgentEvent;
const snap = (ids: string[], olderBefore: number | null) =>
  ({ sessionId: "s", events: ids.map(ev), olderBefore }) as SessionSnapshot;
const ids = (s: SessionSnapshot) => s.events.map((e) => e.id);

describe("wholeHistory", () => {
  it("keeps a loaded copy that already reaches the first turn", async () => {
    const loaded = snap(["a", "b"], null);
    expect(await wholeHistory(loaded, null, async () => Promise.reject("no call"))).toBe(loaded);
  });

  it("pages the machine back to the first turn on a session's first save", async () => {
    const pages: Record<number, SessionPage> = {
      8: { events: [ev("c"), ev("d")], olderBefore: 4 },
      4: { events: [ev("a"), ev("b")], olderBefore: null },
    };
    const whole = await wholeHistory(snap(["e", "f"], 8), null, async (before) => pages[before]);
    expect(ids(whole)).toEqual(["a", "b", "c", "d", "e", "f"]);
    expect(whole.olderBefore).toBeNull();
  });

  it("takes the older turns from the whole copy on disk, asking the machine nothing", async () => {
    const kept = snap(["a", "b", "c", "d"], null);
    const whole = await wholeHistory(snap(["c", "d", "e"], 8), kept, async () => Promise.reject("no call"));
    expect(ids(whole)).toEqual(["a", "b", "c", "d", "e"]);
    expect(whole.olderBefore).toBeNull();
  });

  it("pages again where the copy on disk is itself only a tail", async () => {
    const kept = snap(["c", "d"], 4);
    const whole = await wholeHistory(snap(["c", "d", "e"], 4), kept, async () => ({
      events: [ev("a"), ev("b")],
      olderBefore: null,
    }));
    expect(ids(whole)).toEqual(["a", "b", "c", "d", "e"]);
  });
});
