import { describe, expect, it } from "vitest";
import { onUnhandledEscape, runUnhandledEscape } from "./escape";

const key = (over: Partial<KeyboardEvent> = {}) =>
  ({
    key: "Escape",
    defaultPrevented: false,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...over,
  }) as KeyboardEvent;

describe("runUnhandledEscape", () => {
  it("runs the fallback for a bare Escape nobody handled", () => {
    let calls = 0;
    const off = onUnhandledEscape(() => {
      calls++;
      return true;
    });
    expect(runUnhandledEscape(key())).toBe(true);
    expect(calls).toBe(1);
    off();
  });

  it("leaves an Escape something else already answered", () => {
    let calls = 0;
    const off = onUnhandledEscape(() => {
      calls++;
      return true;
    });
    expect(runUnhandledEscape(key({ defaultPrevented: true }))).toBe(false);
    expect(runUnhandledEscape(key({ shiftKey: true }))).toBe(false);
    expect(runUnhandledEscape(key({ key: "Enter" }))).toBe(false);
    expect(calls).toBe(0);
    off();
  });

  it("keeps a newer fallback when an older one's cleanup runs late", () => {
    const offOld = onUnhandledEscape(() => false);
    const offNew = onUnhandledEscape(() => true);
    offOld();
    expect(runUnhandledEscape(key())).toBe(true);
    offNew();
    expect(runUnhandledEscape(key())).toBe(false);
  });
});
