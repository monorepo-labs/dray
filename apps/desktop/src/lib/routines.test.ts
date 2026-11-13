import { describe, expect, it } from "vitest";

import { lastRunFailed, lastRunLabel, nextRunLabel, scheduleLabel } from "@/lib/routines";
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

describe("lastRunLabel", () => {
  it("says nothing before the first run", () => {
    expect(lastRunLabel(routine())).toBeUndefined();
  });

  it("names a silent run and a reply", () => {
    const at = new Date(Date.now() - 5 * 60_000).toISOString();
    expect(lastRunLabel(routine({ lastResult: { outcome: "silent", at } }))).toEqual({ text: "Nothing to report", age: "5m" });
    expect(lastRunLabel(routine({ lastResult: { outcome: "replied", text: "CI is green", at } }))).toEqual(
      { text: "CI is green", age: "5m" },
    );
  });

  it("carries why a check failed, and marks it", () => {
    const r = routine({ lastResult: { outcome: "check_failed", text: "exit 1: no such PR", at: new Date().toISOString() } });
    expect(lastRunLabel(r)).toEqual({ text: "Check failed: exit 1: no such PR", age: "now" });
    expect(lastRunFailed(r)).toBe(true);
  });

  it("draws an outcome a newer server names as it is", () => {
    expect(lastRunLabel(routine({ lastResult: { outcome: "later", at: new Date().toISOString() } }))).toEqual({ text: "later", age: "now" });
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
