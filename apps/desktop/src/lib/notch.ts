import { readLocalStorage, writeLocalStorage } from "@/hooks/useLocalStorage";
import { IS_MAC } from "@/lib/platform";
import { invoke } from "@/lib/transport";

/// The modifier tapped alone to open Dray Notch, and again to dictate.
export type NotchKey = "control" | "option" | "command";

export const NOTCH_KEYS: { value: NotchKey; label: string }[] = [
  { value: "control", label: "⌃ Control" },
  { value: "option", label: "⌥ Option" },
  { value: "command", label: "⌘ Command" },
];

export const NOTCH_KEY = "ade.notchKey";
export const NOTCH_ENABLED = "ade.notchEnabled";

/// The key once spelled the switch too, `off` being no notch. Read once into
/// the switch of its own, so a reader who had it off finds it still off.
function migrateOff() {
  if (readLocalStorage<string>(NOTCH_KEY, "control") !== "off") return;
  writeLocalStorage(NOTCH_KEY, "control");
  writeLocalStorage(NOTCH_ENABLED, false);
}

const enabled = () => readLocalStorage<boolean>(NOTCH_ENABLED, true);

/// Hands the key to the notch and starts or stops it to match the switch. Every
/// launch does this, which is what starts the notch at all; failures are logged,
/// since a notch that will not start must not take the app down with it. A pick
/// just made is passed in, since storage is written inside a state updater
/// React may not have run yet.
export async function applyNotch(pick: { on?: boolean; key?: NotchKey } = {}) {
  if (!IS_MAC) return;
  migrateOff();
  const on = pick.on ?? enabled();
  const key = on ? (pick.key ?? readLocalStorage<NotchKey>(NOTCH_KEY, "control")) : "off";
  try {
    await invoke("configure_notch", { key });
  } catch (err) {
    console.warn("[notch]", err);
  }
}

/// Whether Dray Notch is up to take permission and question cards: asked of the
/// process, since the switch says nothing about a notch the reader quit. A
/// failed ask reads as no notch, so the banner is the one lost to doubt never.
export async function notchOn(): Promise<boolean> {
  if (!IS_MAC || !enabled()) return false;
  return invoke<boolean>("notch_running").catch(() => false);
}
