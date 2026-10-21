import { describe, expect, it } from "vitest";

import { captureFrom, decodeCapture, DEFAULT_CAPTURE, encodeCapture } from "@/lib/islandCapture";

const press = (code: string, mods: Partial<Record<"metaKey" | "ctrlKey" | "altKey" | "shiftKey", boolean>>) => ({
  code,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
});

describe("island capture key", () => {
  it("spells the default the way the island registered it", () => {
    // kVK_ANSI_2, cmdKey | shiftKey.
    expect(encodeCapture(DEFAULT_CAPTURE)).toBe("19 768");
  });

  it("round-trips through the stored string", () => {
    const k = { code: "KeyS", mods: { meta: false, ctrl: true, alt: true, shift: false } };
    expect(decodeCapture(encodeCapture(k))).toEqual(k);
    expect(decodeCapture("none")).toBeNull();
    expect(decodeCapture(undefined)).toEqual(DEFAULT_CAPTURE);
    expect(decodeCapture("garbage")).toEqual(DEFAULT_CAPTURE);
  });

  it("refuses a chord with no ⌘, ⌃ or ⌥, and macOS's own", () => {
    expect(captureFrom(press("KeyA", { shiftKey: true }))).toHaveProperty("refused");
    expect(captureFrom(press("Digit4", { metaKey: true, shiftKey: true }))).toHaveProperty("refused");
    expect(captureFrom(press("Enter", { metaKey: true }))).toHaveProperty("refused");
    expect(captureFrom(press("Digit2", { metaKey: true, shiftKey: true }))).toEqual({ key: DEFAULT_CAPTURE });
  });
});
