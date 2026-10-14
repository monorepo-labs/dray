import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resetAllChords, setChord } from "@/hooks/useShortcuts";

import { IS_MAC } from "./platform";
import {
  digitSlot,
  heldMods,
  modsAfterUp,
  registryHolder,
  sameMods,
  usableMods,
} from "./digitChords";

const ev = (key: string, m: Partial<Record<"metaKey" | "ctrlKey" | "altKey" | "shiftKey", boolean>> = {}) => ({
  key,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...m,
});
const mods = (m: Partial<Record<"meta" | "ctrl" | "alt" | "shift", boolean>>) => ({
  meta: false,
  ctrl: false,
  alt: false,
  shift: false,
  ...m,
});

describe("digitSlot", () => {
  it("maps 1–9 to slots 0–8 and 0 to the tenth", () => {
    expect(digitSlot("Digit1")).toBe(0);
    expect(digitSlot("Digit9")).toBe(8);
    expect(digitSlot("Digit0")).toBe(9);
  });

  it("ignores keypad and letters", () => {
    expect(digitSlot("Numpad1")).toBeNull();
    expect(digitSlot("KeyA")).toBeNull();
  });
});

describe("heldMods", () => {
  it("counts a modifier on its own keydown even with its flag still down", () => {
    expect(sameMods(heldMods(ev("Alt")), mods({ alt: true }))).toBe(true);
    expect(sameMods(heldMods(ev("Shift", { metaKey: true })), mods({ meta: true, shift: true }))).toBe(true);
  });

  it("reads the flags on a digit", () => {
    expect(sameMods(heldMods(ev("¡", { altKey: true })), mods({ alt: true }))).toBe(true);
  });
});

describe("modsAfterUp", () => {
  it("drops the key being released, flag or not", () => {
    expect(sameMods(modsAfterUp(ev("Alt", { altKey: true, metaKey: true })), mods({ meta: true }))).toBe(true);
    expect(sameMods(modsAfterUp(ev("Meta")), mods({}))).toBe(true);
  });
});

describe("sameMods", () => {
  it("refuses a superset, so ⌘⌥digit stays the split pane's", () => {
    expect(sameMods(mods({ meta: true, alt: true }), mods({ alt: true }))).toBe(false);
  });
});

describe("registryHolder", () => {
  beforeEach(() => {
    const held = new Map<string, string>();
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (k: string) => held.get(k) ?? null,
        setItem: (k: string, v: string) => held.set(k, v),
      },
    });
  });
  afterEach(() => {
    Reflect.deleteProperty(globalThis, "localStorage");
  });

  // ⌘0 is "Actual size". The same chord's ⌃0 alias is left to a digit row.
  it("hands a digit to the shortcut bound on the exact accelerator", () => {
    expect(registryHolder(mods(IS_MAC ? { meta: true } : { ctrl: true }), 9)).toBe("zoom.reset");
    expect(registryHolder(mods(IS_MAC ? { ctrl: true } : { meta: true }), 9)).toBeNull();
    expect(registryHolder(mods({ alt: true }), 9)).toBeNull();
  });

  // ⌘⇧1 records as `!`; only its `code` still says which digit it is.
  it("finds a shifted digit by its physical key", () => {
    setChord("search", { key: "!", meta: true, shift: true, alt: false, code: "Digit1" });
    const accel = IS_MAC ? { meta: true } : { ctrl: true };
    expect(registryHolder(mods({ ...accel, shift: true }), 0)).toBe("search");
    resetAllChords();
  });
});

describe("usableMods", () => {
  it("refuses shift alone and nothing at all", () => {
    expect(usableMods(mods({ shift: true }))).toBe(false);
    expect(usableMods(mods({}))).toBe(false);
    expect(usableMods(mods({ ctrl: true, shift: true }))).toBe(true);
  });
});
