import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  chordFor,
  clearChord,
  holderOf,
  resetAllChords,
  resetChord,
  setChord,
  yieldMovedDefaults,
} from "@/hooks/useShortcuts";
import { defaultChord, sameChord } from "@/lib/shortcuts";

/// Node environment like every other test here, so the store is stood up by
/// hand — the same shim `useLocalStorage.test.ts` uses.
const held = new Map<string, string>();

beforeEach(() => {
  held.clear();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => held.get(k) ?? null,
      setItem: (k: string, v: string) => held.set(k, v),
    },
  });
  resetAllChords();
});

afterEach(() => {
  Reflect.deleteProperty(globalThis, "localStorage");
});

describe("clearChord", () => {
  it("leaves the action with no chord", () => {
    expect(chordFor("search")).not.toBeNull();
    clearChord("search");
    expect(chordFor("search")).toBeNull();
  });

  // The whole reason an unbinding is stored as an explicit null rather than by
  // deleting the entry: a deleted entry means "whatever this build ships".
  it("survives a reload rather than falling back to the default", async () => {
    clearChord("search");
    vi.resetModules();
    const fresh = await import("@/hooks/useShortcuts");
    expect(fresh.chordFor("search")).toBeNull();
    expect(fresh.chordFor("session.new")).toEqual(defaultChord("session.new"));
  });

  // An unbound row holds nothing, so the chord it used to hold is free — and
  // `holderOf` reading a null as a chord would throw rather than refuse.
  it("frees the chord it held for another action", () => {
    expect(holderOf(defaultChord("search"))).toBe("search");
    clearChord("search");
    expect(holderOf(defaultChord("search"))).toBeNull();
  });

  it("is undone by a reset", () => {
    clearChord("search");
    expect(resetChord("search")).toBeNull();
    expect(chordFor("search")).toEqual(defaultChord("search"));
  });

  it("is undone by recording the default again", () => {
    clearChord("search");
    setChord("search", defaultChord("search"));
    expect(sameChord(chordFor("search")!, defaultChord("search"))).toBe(true);
  });
});

describe("yieldMovedDefaults", () => {
  const chord = (key: string, alt = false) => ({ key, meta: true, shift: false, alt });

  it("leaves a store with nothing in the way untouched", () => {
    const store = { search: chord("j") };
    expect(yieldMovedDefaults(store)).toBe(store);
  });

  const brk = (alt: boolean, shift: boolean) => ({
    key: shift ? "{" : "[",
    meta: true,
    shift,
    alt,
    code: "BracketLeft",
  });

  // ⌘⌥[ was free before the panel's tabs moved onto it. Their old ⌘⇧[ is the
  // titlebar's now, so the row yields to nothing rather than collide.
  it("unbinds a moved row whose old chord is taken now", () => {
    const out = yieldMovedDefaults({ search: brk(true, false) });
    expect(out.search).toEqual(brk(true, false));
    expect(out["panel.tab.prev"]).toBeNull();
  });

  it("puts a moved row back on its old chord where that is free", () => {
    const out = yieldMovedDefaults({ search: brk(true, false), "tab.prev": chord("j") });
    expect(out["panel.tab.prev"]).toEqual(brk(false, true));
  });

  // ⌘⌥L was free before the mode toggle, so a reader may hold it.
  it("unbinds a new row whose default the reader already holds", () => {
    const out = yieldMovedDefaults({ search: chord("l", true) });
    expect(out.search).toEqual(chord("l", true));
    expect(out["mode.toggle"]).toBeNull();
    expect("theme.next" in out).toBe(false);
  });

  it("writes the fix back on the first read", async () => {
    held.set("ade.shortcuts", JSON.stringify({ search: chord("l", true) }));
    vi.resetModules();
    const fresh = await import("@/hooks/useShortcuts");
    expect(fresh.chordFor("mode.toggle")).toBeNull();
    expect(fresh.chordFor("search")).toEqual(chord("l", true));
    expect(JSON.parse(held.get("ade.shortcuts")!)["mode.toggle"]).toBeNull();
  });
});
