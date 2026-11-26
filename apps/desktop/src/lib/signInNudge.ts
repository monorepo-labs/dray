import { channel } from "@/lib/channel";
import { countUseDay, nudgeDue, useDays } from "@/lib/signInGate";

/// Set once the reader skips sign-in, so later launches open on the app. Kept
/// until they sign in, which clears it, so signing out asks again.
export const SKIPPED = "dray.signInSkipped";
const USE_DAYS = "dray.useDays";
/// Set once any task's PR reads merged, however it was merged.
const PR_MERGED = "dray.taskPrMerged";
/// Set once the gate came back for a skipped reader, so it comes back once.
const NUDGED = "dray.signInNudged";

/// Asks the gate to come up over the app: Settings' Sign in, or the nudge.
export const signInAsked = channel<void>();

export function askSignIn() {
  signInAsked.emit();
}

/// Counts today as a day of use. Called on launch and on focus, the two
/// moments `active_day` is counted on.
export function noteUseDay() {
  const next = countUseDay(localStorage.getItem(USE_DAYS), localDay());
  if (next) localStorage.setItem(USE_DAYS, next);
}

/// Notes that a task's PR merged, from the sidebar's marks: they see a merge
/// from the app, a bot's `gh` or GitHub alike.
export function notePrMerged() {
  localStorage.setItem(PR_MERGED, "1");
}

export function prMergedNoted(): boolean {
  return localStorage.getItem(PR_MERGED) === "1";
}

/// Whether the gate is due to come back for a reader who skipped it.
export function signInNudgeDue(): boolean {
  return nudgeDue({
    skipped: localStorage.getItem(SKIPPED) === "1",
    days: useDays(localStorage.getItem(USE_DAYS)),
    merged: prMergedNoted(),
    nudged: localStorage.getItem(NUDGED) === "1",
  });
}

export function markNudged() {
  localStorage.setItem(NUDGED, "1");
}

function localDay(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
