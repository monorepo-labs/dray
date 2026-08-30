import { describe, expect, it } from "vitest";

import { honoursMode, stanceFor } from "./permission";

describe("honoursMode", () => {
  it("offers every stance where a harness takes every stance", () => {
    for (const mode of ["plan", "manual", "auto", "bypassPermissions"] as const) {
      expect(honoursMode("claude_code", mode)).toBe(true);
    }
  });

  /// Codex names no plan mode, so offering one would promise a stance it does
  /// not have.
  it("hides plan on codex and nothing else", () => {
    expect(honoursMode("codex", "plan")).toBe(false);
    expect(honoursMode("codex", "manual")).toBe(true);
    expect(honoursMode("codex", "auto")).toBe(true);
  });

  /// pi's two survive for opposite reasons: `plan` is a spawn flag pi enforces,
  /// and `bypassPermissions` is what pi does with no permission extension
  /// loaded. The other two have nothing behind them at all.
  it("leaves pi the two that mean something", () => {
    expect(honoursMode("pi", "plan")).toBe(true);
    expect(honoursMode("pi", "bypassPermissions")).toBe(true);
    expect(honoursMode("pi", "manual")).toBe(false);
    expect(honoursMode("pi", "auto")).toBe(false);
  });
});

describe("stanceFor", () => {
  it("keeps a stance the harness honours", () => {
    expect(stanceFor("pi", "plan")).toBe("plan");
    expect(stanceFor("codex", "manual")).toBe("manual");
  });

  /// A session can arrive on a stance its harness never offered — a spawned one
  /// takes its parent's — so this is not the picker's filter restated. What is
  /// recorded has to be what will actually happen.
  it("records what will happen for an inherited stance nothing honours", () => {
    expect(stanceFor("pi", "auto")).toBe("bypassPermissions");
    expect(stanceFor("pi", "manual")).toBe("bypassPermissions");
    expect(stanceFor("codex", "plan")).toBe("bypassPermissions");
  });

  /// The alarming direction to be wrong in. A session recorded `plan` and
  /// spawned without `--tools` reads as read-only while it writes.
  it("never invents a restriction the spawn will not carry", () => {
    for (const mode of ["auto", "manual", "dontAsk"] as const) {
      expect(stanceFor("pi", mode)).not.toBe("plan");
    }
  });
});
