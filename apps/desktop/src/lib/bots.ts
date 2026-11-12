import { useSyncExternalStore } from "react";

import { invoke, listen, LOCAL } from "@/lib/transport";
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

/// Keeps the list current while `dray bot` changes it from outside the app,
/// and reads it again on This Mac's every connect, since a change made while
/// the socket was down sent its `bots_changed` to nobody.
export function listenForBots(): () => void {
  const changed = listen("bots_changed", () => void refreshBots());
  const connected = listen("live_state", ({ server }) => {
    if (server === LOCAL) void refreshBots();
  });
  return () => {
    void changed.then((off) => off());
    void connected.then((off) => off());
  };
}

/// The bot `key` names, the way `dray bot send` reads it: its id, else its
/// name in any case, where only one bot has it.
export function botNamed(list: readonly Bot[], key: string): Bot | undefined {
  const byId = list.find((b) => b.id === key);
  if (byId) return byId;
  const name = key.trim().toLowerCase();
  const matches = list.filter((b) => b.name.trim().toLowerCase() === name);
  return matches.length === 1 ? matches[0] : undefined;
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
  return botOf(list, items, sessionId) !== undefined;
}

/// The bot whose chat `sessionId` is part of, or descends from.
export function botOf(
  list: readonly Bot[],
  items: readonly SessionIndexItem[],
  sessionId: string,
): Bot | undefined {
  if (list.length === 0) return undefined;
  const byId = new Map(items.map((i) => [i.sessionId, i]));
  let at = byId.get(sessionId);
  for (let hops = 0; at && hops < 8; hops++) {
    const bot = botAt(list, at.cwd);
    if (bot) return bot;
    at = at.parentSessionId ? byId.get(at.parentSessionId) : undefined;
  }
  return undefined;
}

/// The session whose browser a bot chat's `sessionId` uses, as the server's
/// `bots::browser_owner` resolves it: the chat's oldest session, since an
/// agent switch adds a newer one and the pages must outlive it (#878). A
/// bot's tasks have browsers of their own, so anything else is `undefined`.
export function botBrowser(
  list: readonly Bot[],
  items: readonly SessionIndexItem[],
  sessionId: string,
): string | undefined {
  const cwd = items.find((i) => i.sessionId === sessionId)?.cwd;
  const bot = cwd === undefined ? undefined : botAt(list, cwd);
  return bot && botChat(items, bot)[0]?.sessionId;
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
    // Headings and quotes by their line-start marks alone: `#908` mid-line is a PR.
    .replace(/^\s*(?:#{1,6}\s+|>\s?)+/gm, "")
    // Underscores stay: `parse_args` is a name, and agents bold with `*`.
    .replace(/[*`]+/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/// The bot's chat: its newest session not settled. One ongoing conversation.
export function botSession(
  items: readonly SessionIndexItem[],
  bot: Bot,
): SessionIndexItem | undefined {
  return botChat(items, bot).at(-1);
}

/// Every session of the bot's one conversation, oldest first. Switching agent
/// starts a new session, since each CLI resumes only its own, so the chat the
/// reader sees spans all of them.
export function botChat(items: readonly SessionIndexItem[], bot: Bot): SessionIndexItem[] {
  const at = trimmed(bot.path);
  return items
    .filter((i) => !i.archived && trimmed(i.cwd) === at)
    .sort((a, b) => Date.parse(a.created) - Date.parse(b.created));
}
