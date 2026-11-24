import { useSyncExternalStore } from "react";

import { SIGNED_IN } from "@/components/AccountGate";
import { channel } from "@/lib/channel";
import { gatesSignIn, ONBOARDED } from "@/lib/signInGate";

const changed = channel<void>();

/// Onboarding (#1421) is shown once, on first launch, ahead of the sign-in
/// gate. Only where the gate stands, so it plays before sign-in; and never for
/// a reader this app has seen signed in, who used Dray before onboarding
/// existed.
let on =
  gatesSignIn(import.meta.env) && localStorage.getItem(ONBOARDED) !== "1" && localStorage.getItem(SIGNED_IN) !== "1";

/// Whether onboarding is on screen.
export function useOnboarding(): boolean {
  return useSyncExternalStore(changed.subscribe, () => on);
}

/// Onboarding is done, here for good: the sign-in gate is next, or the app for
/// a reader already signed in.
export function finishOnboarding() {
  localStorage.setItem(ONBOARDED, "1");
  on = false;
  changed.emit();
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
