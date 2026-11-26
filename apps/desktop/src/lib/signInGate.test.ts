import { describe, expect, it } from "vitest";

import { countUseDay, gatesSignIn, nudgeDue, useDays } from "./signInGate";

describe("gatesSignIn", () => {
  it("gates a release build", () => {
    expect(gatesSignIn({ DEV: false })).toBe(true);
  });

  it("gates a release build whatever the opt-in says", () => {
    expect(gatesSignIn({ DEV: false, VITE_DRAY_SIGN_IN: "0" })).toBe(true);
  });

  it("skips the gate in a dev build", () => {
    expect(gatesSignIn({ DEV: true })).toBe(false);
  });

  it("gates a dev build that opts in", () => {
    expect(gatesSignIn({ DEV: true, VITE_DRAY_SIGN_IN: "1" })).toBe(true);
  });
});

describe("countUseDay", () => {
  it("counts a first day", () => {
    expect(useDays(countUseDay(null, "2026-11-26"))).toBe(1);
  });

  it("counts a day once however often it is noted", () => {
    const first = countUseDay(null, "2026-11-26");
    expect(countUseDay(first, "2026-11-26")).toBeNull();
  });

  it("counts days of use, not days passed", () => {
    let stored = countUseDay(null, "2026-11-01");
    stored = countUseDay(stored, "2026-11-20");
    expect(useDays(stored)).toBe(2);
  });

  it("starts again from a mangled value", () => {
    expect(useDays(countUseDay("{oops", "2026-11-26"))).toBe(1);
    expect(useDays("{oops")).toBe(0);
  });
});

describe("nudgeDue", () => {
  const due = { skipped: true, days: 3, merged: true, nudged: false };

  it("asks a reader who skipped, after three days and a merged PR", () => {
    expect(nudgeDue(due)).toBe(true);
  });

  it("waits for both the days and the merge", () => {
    expect(nudgeDue({ ...due, days: 2 })).toBe(false);
    expect(nudgeDue({ ...due, merged: false })).toBe(false);
  });

  it("asks once", () => {
    expect(nudgeDue({ ...due, nudged: true })).toBe(false);
  });

  it("never asks a reader who did not skip", () => {
    expect(nudgeDue({ ...due, skipped: false })).toBe(false);
  });
});
