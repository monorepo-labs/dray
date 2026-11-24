import { useSyncExternalStore } from "react";

import { channel } from "@/lib/channel";

import cleanUrl from "@/assets/welcome-voice.m4a";
import pilotUrl from "@/assets/welcome-voice-pilot.m4a";
import radioUrl from "@/assets/welcome-voice-radio.m4a";

import { WELCOME_SOUNDS, type WelcomeSound } from "./welcomeSounds";

/// Onboarding on trial (#1421). Dev builds only, played from the dev switch; a
/// release never shows it until it is wired to first launch.
type State = { on: boolean; run: number };

const KEY = "dray.dev.onboarding.on";
const ON = import.meta.env.DEV;
const changed = channel<void>();

let state: State = { on: ON && localStorage.getItem(KEY) === "1", run: 0 };

function set(next: State) {
  state = next;
  localStorage.setItem(KEY, next.on ? "1" : "0");
  changed.emit();
}

/// Plays onboarding from its first screen.
export function replayOnboarding() {
  set({ on: true, run: state.run + 1 });
}

export function finishOnboarding() {
  if (state.on) set({ ...state, on: false });
}

/// Whether onboarding is on screen. `run` changes on every replay, so a flow
/// keyed on it starts over.
export function useOnboarding(): State {
  return useSyncExternalStore(changed.subscribe, () => state);
}

const FRESH = "dray.dev.onboarding.fresh";
let fresh = ON && localStorage.getItem(FRESH) === "1";

/// Dev only: draws every agent and `gh` as not signed in, so a machine with
/// everything set up can still see the setup screen a new user gets.
export function useFreshMachine(): boolean {
  return useSyncExternalStore(changed.subscribe, () => fresh);
}

export function setFreshMachine(on: boolean) {
  fresh = on;
  localStorage.setItem(FRESH, on ? "1" : "0");
  changed.emit();
}

const SOUND = "dray.dev.onboarding.sound";
let sound: WelcomeSound = WELCOME_SOUNDS.find((s) => s.id === localStorage.getItem(SOUND))?.id ?? "air";

/// The welcome sound take picked by ear in the dev switch.
export function useWelcomeSound(): WelcomeSound {
  return useSyncExternalStore(changed.subscribe, () => sound);
}

export function setWelcomeSound(id: WelcomeSound) {
  sound = id;
  localStorage.setItem(SOUND, id);
  changed.emit();
}

/// The spoken welcome's takes: as recorded, over a cabin PA, over a radio.
export const WELCOME_VOICES = [
  { id: "clean", label: "Clean", url: cleanUrl },
  { id: "pilot", label: "Pilot", url: pilotUrl },
  { id: "radio", label: "Radio", url: radioUrl },
] as const;
export type WelcomeVoice = (typeof WELCOME_VOICES)[number]["id"];

const VOICE = "dray.dev.onboarding.voice";
let voice: WelcomeVoice = WELCOME_VOICES.find((v) => v.id === localStorage.getItem(VOICE))?.id ?? "pilot";

export function useWelcomeVoice(): WelcomeVoice {
  return useSyncExternalStore(changed.subscribe, () => voice);
}

export function setWelcomeVoice(id: WelcomeVoice) {
  voice = id;
  localStorage.setItem(VOICE, id);
  changed.emit();
}
