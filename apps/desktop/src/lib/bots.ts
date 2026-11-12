import { useSyncExternalStore } from "react";

import { invoke } from "@/lib/transport";
import type { Bot, BotPreview, SessionIndexItem } from "@/types/events";

/// The bots on this Mac's server, held once for the app. Settings writes and
/// the sidebar reads, so both go through here rather than each fetching.
let bots: Bot[] = [];
const listeners = new Set<() => void>();

/// Reads the list again, after a write or on launch.
export async function refreshBots(): Promise<void> {
  try {
    bots = await invoke<Bot[]>("list_bots");
  } catch {
    // An older server answers `unknown command`: it has no bots to list.
    bots = [];
  }
  listeners.forEach((l) => l());
}

export function useBots(): Bot[] {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => bots,
  );
}

const trimmed = (path: string) => path.replace(/\/+$/, "");

/// The bot whose chat runs in `cwd`. A bot's session is known by where it
/// runs — its own folder — and by nothing on the index.
export function botAt(list: readonly Bot[], cwd: string): Bot | undefined {
  const at = trimmed(cwd);
  return list.find((b) => trimmed(b.path) === at);
}

/// Whether `cwd` is a bot's folder, for code outside React.
export function isBotPath(cwd: string | null | undefined): boolean {
  return !!cwd && !!botAt(bots, cwd);
}

/// Whether `sessionId` is a bot's chat or anything it started, at any depth.
/// Bounded, so an index pointing a session at its own ancestor costs a wrong
/// answer rather than a hung render.
export function inBotTree(
  list: readonly Bot[],
  items: readonly SessionIndexItem[],
  sessionId: string,
): boolean {
  if (list.length === 0) return false;
  const byId = new Map(items.map((i) => [i.sessionId, i]));
  let at = byId.get(sessionId);
  for (let hops = 0; at && hops < 8; hops++) {
    if (botAt(list, at.cwd)) return true;
    at = at.parentSessionId ? byId.get(at.parentSessionId) : undefined;
  }
  return false;
}

/// A bot, its ongoing chat, and the chat's inbox row, for the sidebar.
export type BotEntry = { bot: Bot; session: SessionIndexItem | undefined; preview?: BotPreview };

export function botEntries(
  list: readonly Bot[],
  items: readonly SessionIndexItem[],
  previews: Readonly<Record<string, BotPreview>> = {},
): BotEntry[] {
  return list.map((bot) => {
    const session = botSession(items, bot);
    return { bot, session, preview: session && previews[session.sessionId] };
  });
}

/// One line of a reply for an inbox row: markdown marks and line breaks out.
export function previewLine(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[*_`#>]+/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/// The bot's chat: its newest session not settled. One ongoing conversation,
/// so "Start fresh" is settling it and the next send making another.
export function botSession(
  items: readonly SessionIndexItem[],
  bot: Bot,
): SessionIndexItem | undefined {
  const at = trimmed(bot.path);
  return items
    .filter((i) => !i.archived && trimmed(i.cwd) === at)
    .sort((a, b) => Date.parse(b.created) - Date.parse(a.created))[0];
}
