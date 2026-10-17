import { useCallback, useSyncExternalStore } from "react";

import { forgetAgentAvailability } from "@/hooks/useAgentAvailability";
import { channel } from "@/lib/channel";
import { invoke, LOCAL, type ServerId } from "@/lib/transport";
import type { AcpAgent, CustomAgent, Harness } from "@/types/events";

/// The ACP agents each server knows of — the registry plus the reader's own —
/// as one module store, since the picker, the icon and Settings all read it and
/// per-hook copies would disagree about which are on. Per server, because each
/// keeps its own enabled set and its own installs.
const changed = channel<void>();
const NONE: AcpAgent[] = [];
const lists = new Map<ServerId, AcpAgent[]>();
const loading = new Map<ServerId, Promise<void>>();

/// Reads `server`'s list again. `recheck` throws away the cached binary
/// lookups, for an agent installed while the app is open.
export function loadAcpAgents(recheck = false, server: ServerId = LOCAL): Promise<void> {
  const running = loading.get(server);
  if (running && !recheck) return running;
  const read = invoke<AcpAgent[]>("list_acp_agents", { recheck }, server)
    .then((next) => {
      lists.set(server, next);
      forgetAgentAvailability();
      changed.emit();
    })
    // A failed read leaves the native agents standing, which is all the
    // picker needs; Settings says nothing worse than an empty list.
    .catch(() => {})
    .finally(() => {
      if (loading.get(server) === read) loading.delete(server);
    });
  loading.set(server, read);
  return read;
}

export function useAcpAgents(server: ServerId = LOCAL): AcpAgent[] {
  const subscribe = useCallback(
    (listener: () => void) => {
      if (!lists.has(server)) void loadAcpAgents(false, server);
      return changed.subscribe(listener);
    },
    [server],
  );
  const snapshot = () => lists.get(server) ?? NONE;
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

export function isAcp(harness: Harness): boolean {
  return harness.startsWith("acp:");
}

/// The agent behind a harness on `server`. A custom agent can reuse an id on
/// another server, so another server's list answers only while this one's is
/// still out — the registry being the same everywhere.
export function findAcpAgent(harness: Harness, server?: ServerId): AcpAgent | undefined {
  const own = server === undefined ? undefined : lists.get(server);
  if (own) return own.find((a) => a.harness === harness);
  for (const list of lists.values()) {
    const found = list.find((a) => a.harness === harness);
    if (found) return found;
  }
  return undefined;
}

/// The agent's own name, or its id while no list has landed.
export function acpLabel(harness: Harness, server?: ServerId): string {
  return findAcpAgent(harness, server)?.name ?? harness.slice("acp:".length);
}

export async function setAcpAgentEnabled(harness: Harness, enabled: boolean, server: ServerId = LOCAL) {
  await invoke("set_acp_agent_enabled", { id: harness.slice("acp:".length), enabled }, server);
  await loadAcpAgents(true, server);
}

export async function saveCustomAcpAgent(agent: CustomAgent, server: ServerId = LOCAL) {
  await invoke("save_custom_acp_agent", { agent }, server);
  await loadAcpAgents(true, server);
}

export async function removeCustomAcpAgent(id: string, server: ServerId = LOCAL) {
  await invoke("remove_custom_acp_agent", { id }, server);
  await loadAcpAgents(true, server);
}
