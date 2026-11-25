import { resetTime } from "@/lib/format";
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
