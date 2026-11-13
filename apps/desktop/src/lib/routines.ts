import { relativeTime, resetTime } from "@/lib/format";
import type { Routine } from "@/types/events";

/// When a routine runs next, as its row says it: "Paused", "Next in 34m",
/// "Next 9:00 AM tomorrow", or "Due now" for one the server is about to fire.
export function nextRunLabel(routine: Routine, now: number): string {
  if (routine.paused) return "Paused";
  const at = routine.nextRun ? Date.parse(routine.nextRun) : NaN;
  if (Number.isNaN(at)) return "Not scheduled";
  const min = Math.round((at - now) / 60_000);
  if (min <= 0) return "Due now";
  if (min < 60) return `Next in ${min}m`;
  return `Next ${resetTime(routine.nextRun!)}`;
}

/// How the last run ended, as its row says it, and how long ago apart, so a
/// long reply truncates without taking the age with it. Nothing before the
/// first run, and no age while one runs.
export function lastRunLabel(routine: Routine): { text: string; age?: string } | undefined {
  const last = routine.lastResult;
  if (!last) return undefined;
  const words: Record<string, string> = {
    running: "Running now",
    silent: "Nothing to report",
    no_change: "No change",
    replied: last.text ?? "Told you",
    failed: `Failed${last.text ? `: ${last.text}` : ""}`,
    check_failed: `Check failed${last.text ? `: ${last.text}` : ""}`,
    skipped: `Skipped${last.text ? `: ${last.text}` : ""}`,
  };
  const text = words[last.outcome] ?? last.outcome;
  return last.outcome === "running" ? { text } : { text, age: relativeTime(last.at) };
}

/// Whether the last run went wrong, for its line's colour.
export const lastRunFailed = (routine: Routine): boolean =>
  ["failed", "check_failed"].includes(routine.lastResult?.outcome ?? "");

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/// "Every 2h", "Weekdays at 09:00", as the server's `describe` says it.
export function scheduleLabel({ schedule }: Routine): string {
  const m = schedule.everyMinutes;
  if (m) return `Every ${m % 1440 === 0 ? `${m / 1440}d` : m % 60 === 0 ? `${m / 60}h` : `${m}m`}`;
  const days = [...new Set(schedule.days)].sort((a, b) => a - b);
  const key = days.join(",");
  const when =
    key === "" || key === "0,1,2,3,4,5,6"
      ? "Daily"
      : key === "0,1,2,3,4"
        ? "Weekdays"
        : key === "5,6"
          ? "Weekends"
          : days.map((d) => DAYS[d]).join(", ");
  return `${when} at ${schedule.at ?? "?"}`;
}
