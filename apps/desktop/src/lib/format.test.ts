import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { calendarDay } from "@/lib/format";

/// Fixed so "today" is a known afternoon rather than whenever the suite runs —
/// every case here is about which side of a midnight a timestamp falls on, and
/// a real clock would make half of them flip depending on the hour.
const NOW = new Date(2026, 7, 27, 14, 0, 0); // 27 Aug 2026, local

describe("calendarDay", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => vi.useRealTimers());

  it("names the two days that have names", () => {
    expect(calendarDay(new Date(2026, 7, 27, 9, 0).toISOString())).toBe("Today");
    expect(calendarDay(new Date(2026, 7, 26, 23, 30).toISOString())).toBe("Yesterday");
  });

  /// Calendar days, not a 24-hour window. Something touched at 11pm last night
  /// is yesterday's work by 1am, and an elapsed-hours reading would call it
  /// today for another two hours.
  it("counts midnights, not hours", () => {
    vi.setSystemTime(new Date(2026, 7, 27, 1, 0));

    expect(calendarDay(new Date(2026, 7, 26, 23, 0).toISOString())).toBe("Yesterday");
    // Two hours earlier and one hour apart, but the same day.
    expect(calendarDay(new Date(2026, 7, 27, 0, 30).toISOString())).toBe("Today");
  });

  it("falls back to a date past yesterday", () => {
    expect(calendarDay(new Date(2026, 7, 23, 12, 0).toISOString())).toBe("Aug 23");
  });

  /// The year is noise on every row within this year and the only thing telling
  /// two rows apart across one.
  it("adds the year only once it stops being obvious", () => {
    expect(calendarDay(new Date(2025, 7, 23, 12, 0).toISOString())).toBe("Aug 23, 2025");
  });

  /// A row still has to draw. An unparseable stamp costs its own cell, never the
  /// list around it.
  it("is empty for something that is not a date", () => {
    expect(calendarDay("not a date")).toBe("");
  });

  /// A stamp from the future — clock skew between this machine and the tracker's
  /// — reads as today rather than as a negative day count.
  it("reads a future stamp as today", () => {
    expect(calendarDay(new Date(2026, 7, 28, 9, 0).toISOString())).toBe("Today");
  });
});
