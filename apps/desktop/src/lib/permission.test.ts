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

  /// pi honours none of them: its gate is an extension the reader installs and
  /// configures on disk, which no stance passed at spawn can reach.
  it("leaves pi nothing to pick between", () => {
    for (const mode of ["plan", "manual", "auto", "bypassPermissions"] as const) {
      expect(honoursMode("pi", mode)).toBe(false);
    }
  });
});

describe("stanceFor", () => {
  it("keeps a stance the harness honours", () => {
    expect(stanceFor("claude_code", "plan")).toBe("plan");
    expect(stanceFor("codex", "manual")).toBe("manual");
  });

  /// pi honours nothing, so every stance records as the ungated one it will
  /// actually run at — `plan` included, now that the picker no longer offers it.
  it("records pi as ungated whatever it inherits", () => {
    for (const mode of ["plan", "manual", "auto", "bypassPermissions"] as const) {
      expect(stanceFor("pi", mode)).toBe("bypassPermissions");
    }
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
