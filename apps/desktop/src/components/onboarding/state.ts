import { useSyncExternalStore } from "react";

import { SIGNED_IN } from "@/components/AccountGate";
import { channel } from "@/lib/channel";
import { gatesSignIn, ONBOARDED } from "@/lib/signInGate";

import cleanUrl from "@/assets/welcome-voice.m4a";
import pilotUrl from "@/assets/welcome-voice-pilot.m4a";
import radioUrl from "@/assets/welcome-voice-radio.m4a";

import { MUSIC_TRACKS, type MusicTrack, WELCOME_SOUNDS, type WelcomeSound } from "./welcomeSounds";

/// Onboarding (#1421): shown once, on first launch, ahead of the sign-in gate.
/// The dev switch plays it again at any time.
type State = { on: boolean; run: number };

const KEY = "dray.dev.onboarding.on";
const ON = import.meta.env.DEV;
const changed = channel<void>();

/// Only where the gate stands, so it plays before sign-in; and never for a
/// reader this app has seen signed in, who used Dray before onboarding existed.
const firstRun =
  gatesSignIn(import.meta.env) && localStorage.getItem(ONBOARDED) !== "1" && localStorage.getItem(SIGNED_IN) !== "1";

let state: State = { on: firstRun || (ON && localStorage.getItem(KEY) === "1"), run: 0 };

function set(next: State) {
  state = next;
  if (ON) localStorage.setItem(KEY, next.on ? "1" : "0");
  changed.emit();
}

/// Plays onboarding from its first screen.
export function replayOnboarding() {
  set({ on: true, run: state.run + 1 });
}

/// Onboarding is done, here for good: the sign-in gate is next, or the app for
/// a reader already signed in.
export function finishOnboarding() {
  localStorage.setItem(ONBOARDED, "1");
  if (state.on) set({ ...state, on: false });
}

let openBot = false;

/// Asks the app to open Dray Bot's chat once it can. Onboarding ends before
/// sign-in, when no app is mounted to open it, so the ask waits for one.
export function askToOpenDrayBot() {
  openBot = true;
  changed.emit();
}

/// Whether Dray Bot's chat is waiting to be opened; `takeDrayBotAsk` clears it.
export function useDrayBotAsk(): boolean {
  return useSyncExternalStore(changed.subscribe, () => openBot);
}

export function takeDrayBotAsk() {
  openBot = false;
  changed.emit();
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

const MUSIC = "dray.dev.onboarding.music";
let music: MusicTrack = MUSIC_TRACKS.find((m) => m.id === localStorage.getItem(MUSIC))?.id ?? "arcade";

/// The background music track picked by ear in the dev switch.
export function useOnboardingMusic(): MusicTrack {
  return useSyncExternalStore(changed.subscribe, () => music);
}

export function setOnboardingMusic(id: MusicTrack) {
  music = id;
  localStorage.setItem(MUSIC, id);
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
