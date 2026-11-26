/// Whether the sign-in gate stands in front of the app (#1330). Release
/// builds always gate. Dev builds skip it, since every dev app a task starts
/// otherwise stops at sign-in first. A saved account is still used, so only a
/// dev home without one runs as a signed-out app does. `VITE_DRAY_SIGN_IN=1`
/// brings the gate back for work on the gate itself.
/// Set once a reader has been through onboarding to the sign-in page, or signed
/// in at all, so onboarding plays once: a quit before signing in reopens on the
/// gate, and a reader who later signs out is never shown it again.
export const ONBOARDED = "dray.onboarded";

export function gatesSignIn(env: { DEV: boolean; VITE_DRAY_SIGN_IN?: string }): boolean {
  return !env.DEV || env.VITE_DRAY_SIGN_IN === "1";
}

/// Days of use before a reader who skipped sign-in is asked once more.
export const NUDGE_DAYS = 3;

/// Days of use so far, kept as `{ n, last }`: a day counts once, however many
/// launches and focuses it holds. Answers the next value to store, or `null`
/// where `today` was already counted.
export function countUseDay(stored: string | null, today: string): string | null {
  const { n, last } = readDays(stored);
  if (last === today) return null;
  return JSON.stringify({ n: n + 1, last: today });
}

/// How many days `countUseDay` has stored.
export function useDays(stored: string | null): number {
  return readDays(stored).n;
}

function readDays(stored: string | null): { n: number; last: string } {
  try {
    const read = JSON.parse(stored ?? "null") as { n?: unknown; last?: unknown } | null;
    return {
      n: typeof read?.n === "number" ? read.n : 0,
      last: typeof read?.last === "string" ? read.last : "",
    };
  } catch {
    // A mangled value starts the count again rather than stopping it.
    return { n: 0, last: "" };
  }
}

/// Whether a reader who skipped sign-in is shown the gate again (#1590):
/// once, after a few days of use and a task's PR merged, so they have seen
/// Dray do real work first.
export function nudgeDue(s: { skipped: boolean; days: number; merged: boolean; nudged: boolean }): boolean {
  return s.skipped && !s.nudged && s.merged && s.days >= NUDGE_DAYS;
}
