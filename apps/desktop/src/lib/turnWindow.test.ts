import { describe, expect, it } from "vitest";

import { FIRST_MOUNT, MOUNT_STEP, firstMount, grow, mountedTurns } from "./turnWindow";

describe("firstMount", () => {
  it("starts FIRST_MOUNT turns from the end", () => {
    expect(firstMount(61)).toBe(61 - FIRST_MOUNT);
  });

  it("starts at the beginning of a short session", () => {
    expect(firstMount(3)).toBe(0);
    expect(firstMount(0)).toBe(0);
  });
});

describe("mountedTurns", () => {
  it("keeps everything from the start index in order", () => {
    expect(mountedTurns([1, 2, 3, 4, 5], 3)).toEqual([4, 5]);
    expect(mountedTurns([1, 2, 3], 0)).toEqual([1, 2, 3]);
  });

  it("keeps a turn appended after the window was chosen", () => {
    const start = firstMount(61);
    const turns = Array.from({ length: 62 }, (_, i) => i);
    const shown = mountedTurns(turns, start);
    expect(shown[0]).toBe(start);
    expect(shown.at(-1)).toBe(61);
    expect(shown).toHaveLength(FIRST_MOUNT + 1);
  });
});

describe("grow", () => {
  it("steps down by MOUNT_STEP and stops at zero", () => {
    expect(grow(53)).toBe(53 - MOUNT_STEP);
    expect(grow(5)).toBe(0);
    expect(grow(0)).toBe(0);
  });

  it("reaches the oldest turn of a long session in a bounded number of steps", () => {
    let start = firstMount(61);
    let steps = 0;
    while (start > 0) {
      start = grow(start);
      steps++;
    }
    expect(steps).toBeLessThanOrEqual(10);
  });
});
