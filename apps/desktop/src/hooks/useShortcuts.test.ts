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

  // ⌘⌥5 was free before the views and panes swapped, so a reader may hold it.
  it("puts a pane back on its old chord where the reader holds the new one", () => {
    const out = yieldMovedDefaults({ search: chord("5", true) });
    expect(out.search).toEqual(chord("5", true));
    expect(out["pane.5"]).toEqual(chord("5"));
  });

  it("puts a view back on its old chord where the reader holds the new one", () => {
    const out = yieldMovedDefaults({ "pane.1": chord("j"), search: chord("1") });
    expect(out["view.chat"]).toMatchObject(chord("1", true));
  });

  it("unbinds rather than collide where the old chord is taken too", () => {
    const out = yieldMovedDefaults({ search: chord("5", true), attach: chord("5") });
    expect(out["pane.5"]).toBeNull();
  });

  it("writes the fix back on the first read", async () => {
    held.set("ade.shortcuts", JSON.stringify({ search: chord("5", true) }));
    vi.resetModules();
    const fresh = await import("@/hooks/useShortcuts");
    expect(fresh.chordFor("pane.5")).toEqual(chord("5"));
    expect(fresh.chordFor("search")).toEqual(chord("5", true));
    expect(JSON.parse(held.get("ade.shortcuts")!)["pane.5"]).toEqual(chord("5"));
  });
});
