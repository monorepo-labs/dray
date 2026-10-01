import { describe, expect, it } from "vitest";

import { canSwitchTracker, connectedTrackers, effectiveTracker } from "@/lib/issueTracker";

const both = { linear: true, github: true };

describe("effectiveTracker", () => {
  it("honours the pick where there is something behind it", () => {
    expect(effectiveTracker("github", both)).toBe("github");
    expect(effectiveTracker("linear", both)).toBe("linear");
  });

  /// The whole reason this is a function rather than the stored value. A reader
  /// who disconnects the tracker they last picked should land on the one they
  /// still have — where honouring the pick would open an empty page with a chip
  /// row that has nothing to flip to.
  it("falls to whichever tracker is actually connected", () => {
    expect(effectiveTracker("linear", { linear: false, github: true })).toBe("github");
    expect(effectiveTracker("github", { linear: true, github: false })).toBe("linear");
  });

  /// With neither connected the pick stands, because the page then draws its
  /// empty state and the pick is what decides which half of it is offered.
  it("keeps the pick where neither is connected", () => {
    expect(effectiveTracker("github", { linear: false, github: false })).toBe("github");
  });
});

describe("canSwitchTracker", () => {
  /// One tracker is not a choice: a control that can only say what it already
  /// says is chrome.
  it("is true only where both are connected", () => {
    expect(canSwitchTracker(both)).toBe(true);
    expect(canSwitchTracker({ linear: true, github: false })).toBe(false);
    expect(canSwitchTracker({ linear: false, github: false })).toBe(false);
  });
});

describe("connectedTrackers", () => {
  /// A read that has not landed yet reads as neither, not as Linear — the
  /// alternative is the page claiming a connection for one frame and taking it
  /// away again.
  it("reads a missing answer as nothing connected", () => {
    expect(connectedTrackers(null)).toEqual({ linear: false, github: false });
  });

  it("reads each account independently", () => {
    const account = {
      tracker: "github" as const,
      userId: "yogesharc",
      userName: "Yogesh",
      orgName: "github.com",
    };

    expect(connectedTrackers({ linear: [], linearSpacePins: {}, github: account })).toEqual({
      linear: false,
      github: true,
    });
  });

  it("reads an empty list of Linear workspaces as not connected", () => {
    const linear = { tracker: "linear" as const, userId: "u", userName: "U", orgName: "Acme" };

    expect(connectedTrackers({ linear: [], linearSpacePins: {}, github: null }).linear).toBe(false);
    expect(connectedTrackers({ linear: [linear], linearSpacePins: {}, github: null }).linear).toBe(
      true,
    );
  });
});
