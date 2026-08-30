import { describe, expect, it } from "vitest";

import { FIRST_MOUNT, MOUNT_STEP, grow, mountedTurns } from "./turnWindow";

describe("mountedTurns", () => {
  it("keeps the newest turns in order", () => {
    expect(mountedTurns([1, 2, 3, 4, 5], 2)).toEqual([4, 5]);
  });

  it("draws every turn when there are fewer than the window", () => {
    expect(mountedTurns([1, 2], 8)).toEqual([1, 2]);
    expect(mountedTurns([], 8)).toEqual([]);
  });

  it("includes the oldest turn once the window covers the whole list", () => {
    const turns = Array.from({ length: 61 }, (_, i) => i);
    expect(mountedTurns(turns, 61)[0]).toBe(0);
  });
});

describe("grow", () => {
  it("steps by MOUNT_STEP and stops at the total", () => {
    expect(grow(FIRST_MOUNT, 61)).toBe(FIRST_MOUNT + MOUNT_STEP);
    expect(grow(56, 61)).toBe(61);
    expect(grow(61, 61)).toBe(61);
  });

  it("reaches the oldest turn of a long session in a bounded number of steps", () => {
    let mounted = FIRST_MOUNT;
    let steps = 0;
    while (mounted < 61) {
      mounted = grow(mounted, 61);
      steps++;
    }
    expect(steps).toBeLessThanOrEqual(10);
  });
});
