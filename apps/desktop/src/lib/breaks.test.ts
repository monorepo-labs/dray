import { describe, expect, it } from "vitest";

import { AWAY_RESET_MS, TICK_MS, advance } from "./breaks";

const run = (ticks: boolean[]) =>
  ticks.reduce((c, active) => advance(c, TICK_MS, active), { used: 0, away: 0 });

describe("advance", () => {
  it("counts active time only", () => {
    expect(run([true, false, true]).used).toBe(2 * TICK_MS);
  });

  it("keeps the count across a short absence", () => {
    const short = Array(AWAY_RESET_MS / TICK_MS - 1).fill(false);
    expect(run([true, ...short, true]).used).toBe(2 * TICK_MS);
  });

  it("starts again after a long absence", () => {
    const long = Array(AWAY_RESET_MS / TICK_MS).fill(false);
    expect(run([true, ...long, true]).used).toBe(TICK_MS);
  });

  it("reads a sleep-sized gap as away, even with the reader back", () => {
    const woke = advance({ used: 50 * 60_000, away: 0 }, 3 * 60 * 60_000, true);
    expect(woke).toEqual({ used: 0, away: 3 * 60 * 60_000 });
  });
});
