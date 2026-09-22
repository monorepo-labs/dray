import { describe, expect, it } from "vitest";

import { sidebarMove } from "./sidebarAuto";

const move = (over: Partial<Parameters<typeof sidebarMove>[0]>) =>
  sidebarMove({
    from: "chat",
    to: "browser",
    enabled: true,
    collapsed: false,
    claimed: false,
    ...over,
  });

describe("sidebarMove", () => {
  it("hides on arriving at the browser", () => {
    expect(move({})).toBe("hide");
  });

  it("gives it back on leaving for any other view", () => {
    for (const to of ["chat", "changes", "files"] as const) {
      expect(move({ from: "browser", to, claimed: true })).toBe("restore");
    }
  });

  // The bug this file exists for: the effect re-runs on `collapsed`, which it
  // only reads, and a rule naming where the reader came *from* alone restored
  // the sidebar on the frame it was hidden.
  it("does nothing when the view has not moved", () => {
    expect(move({ from: "browser", to: "browser", claimed: true, collapsed: true })).toBeNull();
    expect(move({ from: "chat", to: "chat" })).toBeNull();
  });

  it("leaves a sidebar the reader closed themselves alone", () => {
    expect(move({ collapsed: true })).toBeNull();
    expect(move({ from: "browser", to: "chat", claimed: false })).toBeNull();
  });

  it("does nothing at all when the setting is off", () => {
    expect(move({ enabled: false })).toBeNull();
  });
});
