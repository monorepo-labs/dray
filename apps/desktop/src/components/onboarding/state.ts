import { useSyncExternalStore } from "react";

import { channel } from "@/lib/channel";

/// The onboarding flows on trial (#1421). Dev builds only, picked from the dev
/// switch; a release never shows one until a winner is wired to first launch.
export const VARIANTS = [
  { id: "steps", label: "Full-screen steps" },
  { id: "checklist", label: "Checklist card" },
  { id: "chat", label: "Bot-led chat" },
  { id: "tour", label: "Coach-mark tour" },
] as const;
export type Variant = (typeof VARIANTS)[number]["id"];

type State = { variant: Variant | null; done: boolean; run: number };

const KEY = "dray.dev.onboarding";
const ON = import.meta.env.DEV;
const changed = channel<void>();

let state: State = read();

function read(): State {
  if (!ON) return { variant: null, done: true, run: 0 };
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? "null");
    if (saved && VARIANTS.some((v) => v.id === saved.variant)) return { variant: saved.variant, done: !!saved.done, run: 0 };
  } catch {
    // A bad entry is the same as none.
  }
  return { variant: null, done: true, run: 0 };
}

function set(next: State) {
  state = next;
  localStorage.setItem(KEY, JSON.stringify({ variant: next.variant, done: next.done }));
  changed.emit();
}

/// Starts `variant` from its first screen; `null` turns onboarding off.
export function replayOnboarding(variant: Variant | null) {
  set({ variant, done: variant === null, run: state.run + 1 });
}

export function finishOnboarding() {
  if (!state.done) set({ ...state, done: true });
}

/// The flow on screen, or `null`. `run` changes on every replay, so a flow
/// keyed on it starts over.
export function useOnboarding(): { variant: Variant | null; run: number } {
  const now = useSyncExternalStore(changed.subscribe, () => state);
  return { variant: now.done ? null : now.variant, run: now.run };
}

export function useOnboardingPick(): Variant | null {
  return useSyncExternalStore(changed.subscribe, () => state).variant;
}

const FRESH = "dray.dev.onboarding.fresh";
let fresh = ON && localStorage.getItem(FRESH) === "1";

/// Dev only: draws every agent as not signed in, so a machine with all five
/// set up can still see the setup screens a new user gets.
export function useFreshMachine(): boolean {
  return useSyncExternalStore(changed.subscribe, () => fresh);
}

export function setFreshMachine(on: boolean) {
  fresh = on;
  localStorage.setItem(FRESH, on ? "1" : "0");
  changed.emit();
}

/// What a new user is offered to send Dray Bot first.
export const STARTERS = [
  "What can you do for me?",
  "Look at my projects and suggest a first task",
  "Help me fix a bug",
];
