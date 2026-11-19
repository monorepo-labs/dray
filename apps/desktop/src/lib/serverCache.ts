import { prRepoSlug, sessionBranch } from "@/lib/pr";
import { invoke, LOCAL, serverOfPath, type ServerId } from "@/lib/transport";
import type { Bot, PrMark, Project, ServerInfo, SessionIndexItem, SessionStatus } from "@/types/events";

/// A remote's last known lists, kept on disk by the app so its rows outlive a
/// restart while it cannot be reached (#871). `sessions` is the live side,
/// `archived` the settled one.
export type ServerCache = {
  sessions?: SessionIndexItem[];
  archived?: SessionIndexItem[];
  projects?: Project[];
  bots?: Bot[];
  /// Its `gh` login as last heard, `null` signed out: who a merge made here
  /// for one of its tasks must match while it is down (`mergeAccess.ts`).
  ghLogin?: string | null;
};

/// Whether `server`'s rows belong in the sidebar: This Mac always, a remote
/// while it is listed and turned on, whether or not it answers. Off or removed
/// is the reader saying they don't want it.
export function serverShown(server: ServerId, list: ServerInfo[]): boolean {
  return server === LOCAL || list.some((s) => s.id === server && s.on);
}

/// `prev` without the rows of servers no longer shown, plus the kept rows of
/// each server in `absent` that draws none: after a restart, or one turned
/// back on while still down. A server already drawing rows keeps them, since
/// those are newer than anything kept.
export function withKept<T>(
  prev: T[],
  list: ServerInfo[],
  absent: ServerId[],
  kept: (server: ServerId) => T[] | undefined,
  pathOf: (item: T) => string,
): T[] {
  let next = prev.every((i) => serverShown(serverOfPath(pathOf(i)), list))
    ? prev
    : prev.filter((i) => serverShown(serverOfPath(pathOf(i)), list));
  for (const server of absent) {
    const rows = kept(server);
    if (!rows?.length || next.some((i) => serverOfPath(pathOf(i)) === server)) continue;
    next = [...next, ...rows];
  }
  return next;
}

/// The servers whose kept rows stand in for an answer: on, and not connected.
export const unreachable = (list: ServerInfo[]): ServerId[] =>
  list.flatMap((s) => (s.on && s.status !== "connected" ? [s.id] : []));

/// A row as the index holds it. A session created this run enters the list as
/// its whole snapshot, events and all, and a cache of every server's rows has
/// no use for a transcript.
export function indexRow(item: SessionIndexItem): SessionIndexItem {
  if (!("events" in item)) return item;
  const { events: _, ...row } = item as SessionIndexItem & { events: unknown };
  return row;
}

type KeptRow = SessionIndexItem & { prOpen?: true; prRepo?: string };

/// The GitHub repo a kept row's PR was last seen in, as `gh --repo` takes it.
/// What reads and merges that PR through This Mac while its machine is down.
export const keptRepo = (item: SessionIndexItem): string | undefined => (item as KeptRow).prRepo;

/// `row` as kept, marked `prOpen` where its PR was last seen open, which is
/// what lets a removal warn about it once the machine can no longer be asked
/// (`machines::unfinished`), and carrying `status`, the live one where the
/// app heard a newer one than the index row's. A repo not read yet this run
/// (`prOf` answering `undefined`) leaves a mark kept from before as it was:
/// `before` is that row as last kept, since a row fresh from its server
/// carries neither field. `prRepo` names the PR's repo, and a PR merged or
/// gone leaves it standing.
export function keptRow(
  row: KeptRow,
  prOf: (repoPath: string, branch: string | null) => PrMark | null | undefined,
  status?: SessionStatus,
  before?: SessionIndexItem,
): KeptRow {
  const pr = prOf(row.projectPath, sessionBranch(row));
  const was = before as KeptRow | undefined;
  let next: KeptRow = status && status !== row.status ? { ...row, status } : row;
  if (pr === undefined && was?.prOpen && !next.prOpen) next = { ...next, prOpen: true };
  const repo = prRepoSlug(pr?.url) ?? next.prRepo ?? was?.prRepo;
  if (repo && next.prRepo !== repo) next = { ...next, prRepo: repo };
  if (pr?.state === "OPEN") return next.prOpen ? next : { ...next, prOpen: true };
  if (pr !== undefined && next.prOpen) {
    const { prOpen: _, ...rest } = next;
    next = rest;
  }
  return next;
}

const written = new Map<ServerId, string>();
const writes = new Map<ServerId, Promise<unknown>>();

/// Files `cache` as `server`'s, in call order and only when it changed. Each
/// write replaces the whole file, so two landing out of order would keep the
/// older one.
export function saveServerCache(server: ServerId, cache: ServerCache): void {
  const body = JSON.stringify(cache);
  if (written.get(server) === body) return;
  written.set(server, body);
  const next = (writes.get(server) ?? Promise.resolve())
    .then(() => invoke("save_server_cache", { server, cache }, LOCAL))
    .catch(() => written.delete(server));
  writes.set(server, next);
}

/// Every listed remote's kept lists. A build or browser with no such command
/// answers none.
export const loadServerCaches = (): Promise<Record<ServerId, ServerCache>> =>
  invoke<Record<ServerId, ServerCache>>("server_caches", {}, LOCAL).catch(() => ({}));

/// What Remove's question adds where tasks there still looked unfinished.
/// Removing is how a stopped machine's tasks leave this device, so the line
/// says what goes and what keeps running.
export function unfinishedWarning(titles: string[] | undefined): string | null {
  if (!titles?.length) return null;
  const count = titles.length === 1 ? "1 task" : `${titles.length} tasks`;
  const names = titles.map((t) => `“${t}”`).join(", ");
  return `${count} here last looked unfinished — running, waiting on you, or with an unmerged PR: ${names}. Removing clears them from this device; anything running keeps running there.`;
}
