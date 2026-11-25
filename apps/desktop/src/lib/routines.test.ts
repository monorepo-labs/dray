import { describe, expect, it } from "vitest";

import { nextRunLabel, scheduleLabel } from "@/lib/routines";
import type { Routine } from "@/types/events";

const NOW = Date.parse("2026-11-13T12:00:00Z");

const routine = (over: Partial<Routine> = {}): Routine => ({
  id: "r1",
  botId: "b1",
  name: "PR watch",
  prompt: "Check PR 970",
  schedule: { everyMinutes: 120, days: [] },
  paused: false,
  created: "2026-11-13T10:00:00Z",
  nextRun: "2026-11-13T12:34:00Z",
  lastResult: null,
  ...over,
});

describe("nextRunLabel", () => {
  it("counts minutes inside the hour", () => {
    expect(nextRunLabel(routine(), NOW)).toBe("Next in 34m");
  });

  it("says paused over any time", () => {
    expect(nextRunLabel(routine({ paused: true, nextRun: null }), NOW)).toBe("Paused");
  });

  it("calls a run already past its time due", () => {
    expect(nextRunLabel(routine({ nextRun: "2026-11-13T11:59:00Z" }), NOW)).toBe("Due now");
  });

  it("gives a clock time past the hour", () => {
    expect(nextRunLabel(routine({ nextRun: "2026-11-13T15:00:00Z" }), NOW)).toMatch(/^Next /);
  });
});

describe("scheduleLabel", () => {
  it("says the schedule the way the server does", () => {
    expect(scheduleLabel(routine())).toBe("Every 2h");
    expect(scheduleLabel(routine({ schedule: { everyMinutes: 90, days: [] } }))).toBe("Every 90m");
    expect(scheduleLabel(routine({ schedule: { at: "09:00", days: [] } }))).toBe("Daily at 09:00");
    expect(scheduleLabel(routine({ schedule: { at: "09:00", days: [4, 0, 1, 2, 3] } }))).toBe("Weekdays at 09:00");
    expect(scheduleLabel(routine({ schedule: { at: "09:00", days: [2, 0] } }))).toBe("Mon, Wed at 09:00");
  });
});
