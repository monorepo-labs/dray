import { readLocalStorage } from "@/hooks/useLocalStorage";
import { IS_MAC } from "@/lib/platform";
import { invoke } from "@/lib/transport";

/// The modifier tapped alone to open Dray Island, and again to dictate.
export type IslandKey = "control" | "option" | "command";

export const ISLAND_KEYS: { value: IslandKey; label: string }[] = [
  { value: "control", label: "⌃ Control" },
  { value: "option", label: "⌥ Option" },
  { value: "command", label: "⌘ Command" },
];

export const ISLAND_KEY = "ade.islandKey";
export const ISLAND_ENABLED = "ade.islandEnabled";

const enabled = () => readLocalStorage<boolean>(ISLAND_ENABLED, true);

/// Hands the key to the island and starts or stops it to match the switch. Every
/// launch does this, which is what starts the island at all; failures are logged,
/// since an island that will not start must not take the app down with it. A pick
/// just made is passed in, since storage is written inside a state updater
/// React may not have run yet.
export async function applyIsland(pick: { on?: boolean; key?: IslandKey } = {}) {
  if (!IS_MAC) return;
  const on = pick.on ?? enabled();
  const key = on ? (pick.key ?? readLocalStorage<IslandKey>(ISLAND_KEY, "control")) : "off";
  try {
    await invoke("configure_island", { key });
  } catch (err) {
    console.warn("[island]", err);
  }
}

/// Whether Dray Island is up to take permission and question cards: asked of the
/// process, since the switch says nothing about an island the reader quit. A
/// failed ask reads as no island, so the banner is the one lost to doubt never.
export async function islandOn(): Promise<boolean> {
  if (!IS_MAC || !enabled()) return false;
  return invoke<boolean>("island_running").catch(() => false);
}
