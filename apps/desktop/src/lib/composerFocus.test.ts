import { describe, expect, it } from "vitest";

import { handsOver } from "./composerFocus";

const key = (k: string, mods: Partial<Record<"metaKey" | "ctrlKey" | "altKey" | "shiftKey", boolean>> = {}) => ({
  key: k,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
});

describe("handsOver", () => {
  it("takes printable keys, shifted or not", () => {
    expect(handsOver(key("a"))).toBe(true);
    expect(handsOver(key("A", { shiftKey: true }))).toBe(true);
    expect(handsOver(key("7"))).toBe(true);
  });

  it("leaves space, named keys and modified keys", () => {
    expect(handsOver(key(" "))).toBe(false);
    expect(handsOver(key("Enter"))).toBe(false);
    expect(handsOver(key("ArrowDown"))).toBe(false);
    expect(handsOver(key("k", { metaKey: true }), true)).toBe(false);
    expect(handsOver(key("o", { altKey: true }))).toBe(false);
  });

  it("takes the platform's paste chord alone", () => {
    expect(handsOver(key("v", { metaKey: true }), true)).toBe(true);
    expect(handsOver(key("v", { ctrlKey: true }), false)).toBe(true);
    expect(handsOver(key("v", { ctrlKey: true }), true)).toBe(false);
    expect(handsOver(key("v", { metaKey: true }), false)).toBe(false);
  });

  it("leaves paste-and-match-style and Option paste", () => {
    expect(handsOver(key("v", { metaKey: true, shiftKey: true }), true)).toBe(false);
    expect(handsOver(key("v", { metaKey: true, altKey: true }), true)).toBe(false);
  });
});
