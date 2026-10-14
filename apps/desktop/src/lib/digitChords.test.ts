import { describe, expect, it } from "vitest";

import { digitSlot, heldMods, modsAfterUp, sameMods, usableMods } from "./digitChords";

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

describe("usableMods", () => {
  it("refuses shift alone and nothing at all", () => {
    expect(usableMods(mods({ shift: true }))).toBe(false);
    expect(usableMods(mods({}))).toBe(false);
    expect(usableMods(mods({ ctrl: true, shift: true }))).toBe(true);
  });
});
