import { useSyncExternalStore } from "react";

import { readLocalStorage, writeLocalStorage } from "@/hooks/useLocalStorage";
import { channel } from "@/lib/channel";

/// `off` names the break cards the reader turned off, so a card added later
/// shows up without them having to find it.
export type BreakSettings = { on: boolean; minutes: number; off: string[] };

export const BREAK_INTERVALS = [30, 45, 60, 90] as const;
/// Window focused with no key or pointer for this long reads as the reader gone.
export const IDLE_MS = 5 * 60_000;
/// Away this long is a break already taken, so the count starts again.
export const AWAY_RESET_MS = 10 * 60_000;
export const TICK_MS = 30_000;

const KEY = "ade.breakReminder";
const DEFAULTS: BreakSettings = { on: true, minutes: 60, off: ["Pull-ups", "Push-ups"] };

function coerce(raw: unknown): BreakSettings {
  const v = (raw ?? {}) as Partial<BreakSettings>;
  return {
    on: typeof v.on === "boolean" ? v.on : DEFAULTS.on,
    minutes: BREAK_INTERVALS.includes(v.minutes as never) ? (v.minutes as number) : DEFAULTS.minutes,
    off: Array.isArray(v.off) ? v.off.filter((n) => typeof n === "string") : DEFAULTS.off,
  };
}

// A module store, not `useLocalStorage`: Settings writes while `App` runs the
// clock, and two hook copies would each hold their own value.
let settings = coerce(readLocalStorage<unknown>(KEY, DEFAULTS));
let due = false;
const changed = channel<void>();

export function setBreakSettings(next: BreakSettings) {
  settings = next;
  writeLocalStorage(KEY, next);
  changed.emit();
}

export const useBreakSettings = () => useSyncExternalStore(changed.subscribe, () => settings);

export const useBreakDue = () => useSyncExternalStore(changed.subscribe, () => due);

export const isBreakDue = () => due;

export function setBreakDue(next: boolean) {
  if (next === due) return;
  due = next;
  changed.emit();
}

/// Active use counted so far and how long the reader has been away, in ms.
export type BreakClock = { used: number; away: number };

/// Moves the clock on by `dt` ms. A gap longer than two ticks is the machine
/// having slept — timers do not run through sleep — so it counts as away
/// rather than landing an hour of use on the first tick after waking.
export function advance(clock: BreakClock, dt: number, active: boolean): BreakClock {
  if (active && dt <= 2 * TICK_MS) return { used: clock.used + dt, away: 0 };
  const away = clock.away + dt;
  return { used: away >= AWAY_RESET_MS ? 0 : clock.used, away };
}
