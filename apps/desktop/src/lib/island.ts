import { readLocalStorage } from "@/hooks/useLocalStorage";
import { IS_LINUX, IS_MAC } from "@/lib/platform";
import { invoke, LOCAL, serverOfSession } from "@/lib/transport";

/// The modifier tapped alone to open Dray Island, and again to dictate.
export type IslandKey = "control" | "option" | "command";

/// The Mac's names travel to both islands; Linux reads Option as Alt and
/// Command as Super, and its keyboards print those.
export const ISLAND_KEYS: { value: IslandKey; label: string }[] = IS_LINUX
  ? [
      { value: "control", label: "Ctrl" },
      { value: "option", label: "Alt" },
      { value: "command", label: "Super" },
    ]
  : [
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
  if (!IS_MAC && !IS_LINUX) return;
  const on = pick.on ?? enabled();
  const key = on ? (pick.key ?? readLocalStorage<IslandKey>(ISLAND_KEY, "control")) : "off";
  try {
    await invoke("configure_island", { key });
  } catch (err) {
    console.warn("[island]", err);
  }
}

/// Whether Dray Island is up to take what would be a banner for `sessionId` —
/// `asks`, the permission and question cards, or `done`, a finished session:
/// asked of the process, since the switch says nothing about an island the
/// reader quit. A failed ask reads as no island, so the banner is the one lost
/// to doubt never.
export async function islandOn(what: "asks" | "done", sessionId: string): Promise<boolean> {
  void what;
  // Linux's island reads this computer's sessions alone, so another
  // machine's keeps its banner rather than going to an island that cannot
  // show it.
  const draws = IS_MAC || (IS_LINUX && serverOfSession(sessionId) === LOCAL);
  if (!draws || !enabled()) return false;
  return invoke<boolean>("island_running").catch(() => false);
}
