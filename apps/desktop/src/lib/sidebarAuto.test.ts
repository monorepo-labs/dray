import { describe, expect, it } from "vitest";

import { panelMove } from "./sidebarAuto";

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

  it("hides on arriving at Diff or Files too", () => {
    expect(pane({ to: "changes" })).toBe("hide");
    expect(pane({ to: "files" })).toBe("hide");
    expect(pane({ from: "files", to: "chat", claimed: true })).toBe("restore");
  });

  it("leaves a pane opened beside the page alone", () => {
    expect(pane({ from: "browser" })).toBeNull();
  });

  // Diff → Files is neither leaving nor arriving: no restore and re-hide in
  // between, and a pane the reader opened beside Diff stays open.
  it("does nothing on a move between two views off Chat", () => {
    expect(pane({ from: "changes", to: "files", open: false, claimed: true })).toBeNull();
    expect(pane({ from: "changes", to: "files" })).toBeNull();
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
