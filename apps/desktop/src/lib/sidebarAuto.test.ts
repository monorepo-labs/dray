import { describe, expect, it } from "vitest";

import { panelMove, sidebarMove } from "./sidebarAuto";

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

const pane = (over: Partial<Parameters<typeof panelMove>[0]>) =>
  panelMove({
    from: "chat",
    to: "browser",
    keyMoved: false,
    enabled: true,
    open: true,
    claimed: false,
    ...over,
  });

describe("panelMove", () => {
  it("hides on arriving at the browser and gives it back off it", () => {
    expect(pane({})).toBe("hide");
    expect(pane({ from: "browser", to: "chat", claimed: true })).toBe("restore");
  });

  it("leaves a pane opened beside the page alone", () => {
    expect(pane({ from: "browser" })).toBeNull();
  });

  // Selecting a session already on the Browser with its pane open is the
  // reader returning to it, not arriving.
  it("does not hide on a session switch", () => {
    expect(pane({ keyMoved: true })).toBeNull();
  });

  // The claimed session never left its page, so another session's view moving
  // must not open a pane that belongs beside a Browser view.
  it("restores only its own claim", () => {
    expect(pane({ from: "browser", to: "chat", claimed: false })).toBeNull();
    expect(pane({ from: "chat", to: "browser", claimed: true, open: false })).toBeNull();
  });

  it("gives back a claim when its session is reached on another view", () => {
    expect(pane({ from: "browser", to: "chat", keyMoved: true, claimed: true })).toBe("restore");
  });

  it("does not hide when the setting is off", () => {
    expect(pane({ enabled: false })).toBeNull();
  });
});
