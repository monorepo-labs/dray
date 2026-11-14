import { useSyncExternalStore } from "react";

import { remoteServers, subscribeServers } from "@/lib/servers";
import { invoke, listen, LOCAL, serverOfPath, serverOfSession, type ServerId } from "@/lib/transport";
import type { Bot, BotPreview, SessionIndexItem } from "@/types/events";

/// Every server's bots, held once for the app: This Mac's first, then each
/// remote's in the server list's order. A remote's paths come back qualified,
/// so a bot's server is `serverOfPath(bot.path)`.
let bots: Bot[] = [];
const byServer = new Map<ServerId, Bot[]>();
const answered = new Set<ServerId>();
const listeners = new Set<() => void>();
let watching = false;

/// The flat list again, from each shown server's last answer. A remote that is
/// on but unreachable keeps its bots, drawn offline; one turned off or removed
/// takes them with it, as it does its projects.
function rebuild() {
  const next = [
    ...(byServer.get(LOCAL) ?? []),
    ...remoteServers().flatMap((s) => (s.on ? (byServer.get(s.id) ?? []) : [])),
  ];
  if (next.length === bots.length && next.every((b, i) => b === bots[i])) return;
  bots = next;
  listeners.forEach((l) => l());
}

/// Reads `server`'s list again, after a write or on its connect.
export async function refreshBots(server: ServerId = LOCAL): Promise<void> {
  try {
    byServer.set(server, await invoke<Bot[]>("list_bots", {}, server));
    answered.add(server);
  } catch (e) {
    // An older server answers `unknown command`: it has no bots to list. A
    // remote that cannot be reached keeps what it last said.
    if (server === LOCAL || String(e).includes("unknown command")) byServer.set(server, []);
  }
  rebuild();
}

/// A remote's bots as last kept on disk, standing in until it answers.
export function keepBots(server: ServerId, list: Bot[]): void {
  if (answered.has(server)) return;
  byServer.set(server, list);
  rebuild();
}

/// What `server` last said, this run or kept from an earlier one, for the
/// cache that outlives a restart.
export const botsOf = (server: ServerId): Bot[] | undefined => byServer.get(server);

export function useBots(): Bot[] {
  return useSyncExternalStore(
    (l) => {
      if (!watching) {
        watching = true;
        subscribeServers(rebuild);
      }
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => bots,
  );
}

/// The server a bot runs on.
export const serverOfBot = (bot: Bot): ServerId => serverOfPath(bot.path);

/// Each chat's inbox row, asked of the server that chat runs on.
export async function readPreviews(sessionIds: string[]): Promise<Record<string, BotPreview>> {
  const by = new Map<ServerId, string[]>();
  for (const id of sessionIds) {
    const server = serverOfSession(id);
    by.set(server, [...(by.get(server) ?? []), id]);
  }
  const answers = await Promise.all(
    [...by].map(([server, ids]) =>
      invoke<Record<string, BotPreview>>("bot_previews", { sessionIds: ids }, server).catch(() => ({})),
    ),
  );
  return Object.assign({}, ...answers);
}

/// Keeps each server's list current while `dray bot` changes it from outside
/// the app. A connect needs nothing here: `readServer` reads every server's
/// bots on its `live_state`, which covers a change made while it was down.
export function listenForBots(): () => void {
  const changed = listen("bots_changed", ({ server }) => void refreshBots(server));
  return () => void changed.then((off) => off());
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

/// Whether `id` names a bot, for code outside React. What tells a bot tag from
/// a file mention followed by some id in parentheses.
export function isBotId(id: string): boolean {
  return bots.some((b) => b.id === id);
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
    // A settled or deleted parent is not held: the adoption bridges it.
    const parent: SessionIndexItem | undefined = at.parentSessionId ? byId.get(at.parentSessionId) : undefined;
    at = parent ?? (at.adoptedBy ? byId.get(at.adoptedBy) : undefined);
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

/// The messages a bot's chat opens on before it has a session: Dray Bot's
/// welcome, then the question for the reader's name while no bot knows it. A
/// server from before the greeting sends the welcome alone.
export function greetingOf(bot: Bot): string[] {
  return bot.greeting ?? (bot.welcome ? [bot.welcome] : []);
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
