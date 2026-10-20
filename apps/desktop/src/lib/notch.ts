import { readLocalStorage } from "@/hooks/useLocalStorage";
import { IS_MAC } from "@/lib/platform";
import { invoke } from "@/lib/transport";

/// The modifier tapped alone to open Dray Notch. No key at all is the notch off.
export type NotchKey = "control" | "option" | "command" | "off";

export const NOTCH_KEYS: { value: NotchKey; label: string }[] = [
  { value: "control", label: "⌃ Control" },
  { value: "option", label: "⌥ Option" },
  { value: "command", label: "⌘ Command" },
  { value: "off", label: "None, notch off" },
];

export const NOTCH_KEY = "ade.notchKey";

/// Hands the pick to the notch and starts or stops it to match. Every launch
/// does this, which is what starts the notch at all; failures are logged,
/// since a notch that will not start must not take the app down with it.
export async function applyNotch(key: NotchKey = readLocalStorage<NotchKey>(NOTCH_KEY, "control")) {
  if (!IS_MAC) return;
  try {
    await invoke("configure_notch", { key });
  } catch (err) {
    console.warn("[notch]", err);
  }
}
