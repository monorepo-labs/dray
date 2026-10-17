import { useSyncExternalStore } from "react";

import { forgetAgentAvailability } from "@/hooks/useAgentAvailability";
import { channel } from "@/lib/channel";
import { invoke } from "@/lib/transport";
import type { AcpAgent, CustomAgent, Harness } from "@/types/events";

/// The ACP agents this machine knows of — the registry plus the reader's own —
/// as one module store, since the picker, the icon and Settings all read it and
/// per-hook copies would disagree about which are on.
///
/// Local only: the list and the enabled set live in the shared config dir, and
/// a remote server answers its own.
const changed = channel<void>();
let agents: AcpAgent[] = [];
let loaded = false;
let loading: Promise<void> | null = null;

/// Reads the list again. `recheck` throws away the cached binary lookups, for
/// an agent installed while the app is open.
export function loadAcpAgents(recheck = false): Promise<void> {
  if (loading && !recheck) return loading;
  loading = invoke<AcpAgent[]>("list_acp_agents", { recheck })
    .then((next) => {
      agents = next;
      loaded = true;
      forgetAgentAvailability();
      changed.emit();
    })
    // A failed read leaves the native agents standing, which is all the
    // picker needs; Settings says nothing worse than an empty list.
    .catch(() => {})
    .finally(() => {
      loading = null;
    });
  return loading;
}

function subscribe(listener: () => void) {
  if (!loaded) void loadAcpAgents();
  return changed.subscribe(listener);
}

export function useAcpAgents(): AcpAgent[] {
  return useSyncExternalStore(subscribe, () => agents, () => agents);
}

export function isAcp(harness: Harness): boolean {
  return harness.startsWith("acp:");
}

/// The agent's own name, or its id while the list is still out.
export function acpLabel(harness: Harness): string {
  return agents.find((a) => a.harness === harness)?.name ?? harness.slice("acp:".length);
}

export async function setAcpAgentEnabled(harness: Harness, enabled: boolean) {
  await invoke("set_acp_agent_enabled", { id: harness.slice("acp:".length), enabled });
  await loadAcpAgents(true);
}

export async function saveCustomAcpAgent(agent: CustomAgent) {
  await invoke("save_custom_acp_agent", { agent });
  await loadAcpAgents(true);
}

export async function removeCustomAcpAgent(id: string) {
  await invoke("remove_custom_acp_agent", { id });
  await loadAcpAgents(true);
}
