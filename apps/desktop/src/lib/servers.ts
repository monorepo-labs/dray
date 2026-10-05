import { useSyncExternalStore } from "react";

import { channel } from "@/lib/channel";
import { invoke, listen, LOCAL, serverOfPath, type ServerId } from "@/lib/transport";
import type { ServerInfo } from "@/types/events";

/// The remote servers this app holds a connection to, as Rust last said. A
/// module store: the sidebar, the picker, the header and Settings all read it,
/// and a second copy could draw one server connected in one place and not in
/// another. Local Server is not on it — it is the process itself.
let servers: ServerInfo[] = [];
let started = false;
const changed = channel<void>();

function start() {
  if (started) return;
  started = true;
  // Listen first, so a change landing during the read is not lost under it.
  void listen<ServerInfo[]>("servers_changed", ({ payload, server }) => {
    if (server !== LOCAL) return;
    servers = payload;
    changed.emit();
  }).then(() =>
    invoke<ServerInfo[]>("list_servers", {}, LOCAL)
      .then((list) => {
        servers = list;
        changed.emit();
      })
      // A build with no remote support — a plain browser on a dray-serve —
      // answers `unknown command`, which is a list of none.
      .catch(() => {}),
  );
}

export function subscribeServers(listener: () => void): () => void {
  start();
  return changed.subscribe(listener);
}

export const remoteServers = (): ServerInfo[] => servers;

export function useServers(): ServerInfo[] {
  return useSyncExternalStore(subscribeServers, remoteServers, remoteServers);
}

/// What the reader calls a server: its name, or "Local Server".
export function serverName(id: ServerId): string {
  if (id === LOCAL) return "Local Server";
  return servers.find((s) => s.id === id)?.name ?? id;
}

/// A project's name where only text fits — a menu row, a filter — with a remote
/// one's server after it, the way the sidebar heading draws it.
export function projectLabel(project: { path: string; name: string }): string {
  const server = serverOfPath(project.path);
  return server === LOCAL ? project.name : `${project.name}-${serverName(server)}`;
}

/// Whether `id` can be asked anything right now. Local always can.
export function serverConnected(id: ServerId): boolean {
  return id === LOCAL || servers.some((s) => s.id === id && s.status === "connected");
}

/// `prev` with `server`'s share replaced by `next`, which is how a list merged
/// from several servers takes one server's fresh answer. Local stays first.
export function mergeFrom<T>(prev: T[], server: ServerId, next: T[], pathOf: (item: T) => string): T[] {
  const others = prev.filter((item) => serverOfPath(pathOf(item)) !== server);
  return server === LOCAL ? [...next, ...others] : [...others, ...next];
}

const armed = new Map<string, Set<ServerId>>();

/// `watch_docs` across servers: each server is handed its own share of
/// `paths`, and one armed before with no share now is disarmed, or it would
/// go on watching a set nothing on screen holds.
export function watchDocs(scope: string, paths: string[]): Promise<unknown> {
  const by = new Map<ServerId, string[]>();
  for (const path of paths) {
    const server = serverOfPath(path);
    by.set(server, [...(by.get(server) ?? []), path]);
  }
  for (const server of armed.get(scope) ?? []) if (!by.has(server)) by.set(server, []);
  if (!by.size) by.set(LOCAL, []);
  armed.set(scope, new Set([...by].flatMap(([server, list]) => (list.length ? [server] : []))));
  return Promise.all(
    [...by].map(([server, list]) => invoke("watch_docs", { scope, paths: list }, server).catch(() => {})),
  );
}
