import { channel } from "@/lib/channel";
import { countUseDay, nudgeDue, useDays } from "@/lib/signInGate";

/// Set once the reader skips sign-in, so later launches open on the app. Kept
/// until they sign in, which clears it, so signing out asks again.
export const SKIPPED = "dray.signInSkipped";
const USE_DAYS = "dray.useDays";
/// Set once any task's PR reads merged, however it was merged.
const PR_MERGED = "dray.taskPrMerged";
/// Set once a skipped reader's use made sign-in due: from then on the gate
/// offers no Skip, bar a sign-in the network won't let finish. Kept after a
/// sign-in, so signing out later doesn't bring Skip back.
const REQUIRED = "dray.signInRequired";

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

/// Whether sign-in is required: already, or due now, which records it.
export function signInRequired(): boolean {
  if (localStorage.getItem(REQUIRED) === "1") return true;
  const due = nudgeDue({
    skipped: localStorage.getItem(SKIPPED) === "1",
    days: useDays(localStorage.getItem(USE_DAYS)),
    merged: prMergedNoted(),
  });
  if (due) localStorage.setItem(REQUIRED, "1");
  return due;
}

function localDay(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
