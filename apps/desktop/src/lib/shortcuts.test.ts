import { describe, expect, it } from "vitest";

import { IS_MAC } from "./platform";
import { chordFromKey, formatChords, isReserved, sameChord, SHORTCUTS } from "./shortcuts";

const META = IS_MAC ? "⌘" : "Ctrl";

const press = (over: Partial<Parameters<typeof chordFromKey>[0]>) =>
  chordFromKey({
    key: "",
    code: "",
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...over,
  });

describe("SHORTCUTS", () => {
  it("gives no two ids one default chord", () => {
    for (const a of SHORTCUTS)
      for (const b of SHORTCUTS)
        if (a.id !== b.id && sameChord(a.chord, b.chord))
          throw new Error(`${a.id} and ${b.id} share a chord`);
  });
});

describe("isReserved", () => {
  it("keeps quit, close-window and the editing set, and nothing wider", () => {
    expect(isReserved({ key: "q", meta: true, shift: false, alt: false })).toBe(true);
    expect(isReserved({ key: "W", meta: true, shift: false, alt: false })).toBe(true);
    expect(isReserved({ key: "c", meta: true, shift: false, alt: false })).toBe(true);
    expect(isReserved({ key: "z", meta: true, shift: true, alt: false })).toBe(true);
    expect(isReserved({ key: "w", meta: true, shift: false, alt: true })).toBe(false);
    expect(isReserved({ key: "c", meta: true, shift: true, alt: false })).toBe(false);
  });
});

describe("chordFromKey", () => {
  it("refuses a bare printable, shifted or not", () => {
    expect(press({ key: "a", code: "KeyA" })).toBeNull();
    expect(press({ key: "A", code: "KeyA", shiftKey: true })).toBeNull();
  });

  it("takes a non-character key under Shift, never bare", () => {
    expect(press({ key: "Tab", code: "Tab", shiftKey: true })).toEqual({
      key: "Tab", meta: false, shift: true, alt: false,
    });
    expect(press({ key: "Tab", code: "Tab" })).toBeNull();
    expect(press({ key: "ArrowDown", code: "ArrowDown" })).toBeNull();
  });

  it("reads the letter off the physical key under Option", () => {
    expect(press({ key: "ø", code: "KeyO", altKey: true, metaKey: true })).toEqual({
      key: "o", meta: true, shift: false, alt: true, code: "KeyO",
    });
  });

  it("keeps the physical key beside shifted punctuation", () => {
    expect(press({ key: "{", code: "BracketLeft", shiftKey: true, metaKey: true })).toEqual({
      key: "{", meta: true, shift: true, alt: false, code: "BracketLeft",
    });
  });

  it("ignores a modifier pressed alone and Escape", () => {
    expect(press({ key: "Meta", code: "MetaLeft", metaKey: true })).toBeNull();
    expect(press({ key: "Escape", code: "Escape" })).toBeNull();
  });
});

describe("formatChords", () => {
  it("folds keys under shared modifiers into one cap", () => {
    expect(
      formatChords([
        { key: "ArrowUp", meta: true, shift: true, alt: false },
        { key: "ArrowDown", meta: true, shift: true, alt: false },
      ]),
    ).toEqual([[META, "Shift", "↑↓"]]);
  });

  it("draws a bracket chord by its physical key", () => {
    expect(formatChords([{ key: "{", meta: true, shift: true, alt: false, code: "BracketLeft" }]))
      .toEqual([[META, "Shift", "["]]);
  });
});
