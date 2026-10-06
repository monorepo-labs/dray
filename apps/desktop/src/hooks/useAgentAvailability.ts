import { useCallback, useSyncExternalStore } from "react";
import { invoke, LOCAL, type ServerId } from "@/lib/transport";

import { channel } from "@/lib/channel";
import type { AgentAvailability, Harness } from "@/types/events";

/// Which agents have a CLI behind them, per server.
///
/// A module store rather than per-hook state, for `useTheme`'s reason: the
/// picker and the composer's notice both read it, and two copies would let one
/// mark an agent unavailable while the other still offered to send to it.
///
/// Read once per server per process. The answer cannot change while a server
/// runs — Rust caches the resolution in a `OnceLock`, absence included — so
/// refetching would spend a login shell to be told the same thing.
const answers = new Map<ServerId, AgentAvailability[]>();
const inFlight = new Set<ServerId>();
const changed = channel<void>();

function read(server: ServerId) {
  if (answers.has(server) || inFlight.has(server)) return;
  inFlight.add(server);
  invoke<AgentAvailability[]>("agent_availability", {}, server)
    .then((next) => {
      answers.set(server, next);
      changed.emit();
    })
    // Silent, and deliberately: this decides whether to *warn*, so a failed
    // read must leave every agent offerable rather than mark them all
    // missing. The send-time check still refuses, with the same sentence. A
    // remote server that was unreachable is asked again on the next mount.
    .catch(() => {})
    .finally(() => inFlight.delete(server));
}

/// The agents on `server`, or `null` until the first read lands.
///
/// `null` is a resting state and not an error — the composer paints before the
/// read returns, so testing the list alone would flash a warning on an agent
/// that turns out to be installed.
export function useAgentAvailability(server: ServerId = LOCAL): AgentAvailability[] | null {
  const subscribe = useCallback(
    (listener: () => void) => {
      read(server);
      return changed.subscribe(listener);
    },
    [server],
  );
  const snapshot = () => answers.get(server) ?? null;
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/// What to say about one agent, or `null` where there is nothing to say —
/// either it is installed, or nobody has answered yet.
export function useMissingAgent(harness: Harness, server: ServerId = LOCAL): AgentAvailability | null {
  const all = useAgentAvailability(server);
  const found = all?.find((a) => a.harness === harness);
  return found && !found.available ? found : null;
}
