import { invoke, LOCAL, serverOfPath, type ServerId } from "@/lib/transport";
import type { Project, ServerInfo, SessionIndexItem } from "@/types/events";

/// A remote's last known lists, kept on disk by the app so its rows outlive a
/// restart while it cannot be reached (#871). `sessions` is the live side,
/// `archived` the settled one.
export type ServerCache = {
  sessions?: SessionIndexItem[];
  archived?: SessionIndexItem[];
  projects?: Project[];
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
