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
/// Read once per server per process, except where the reader turns an ACP
/// agent on or off. Otherwise the answer cannot change while a server runs —
/// Rust caches the resolution, absence included — so refetching would spend a
/// login shell to be told the same thing.
const answers = new Map<ServerId, AgentAvailability[]>();
/// The generation each running read started under, so a read begun before a
/// [`forgetAgentAvailability`] can neither land nor block the one after it.
const inFlight = new Map<ServerId, number>();
/// Mounted readers per server, which a forget reads again for.
const watched = new Map<ServerId, number>();
let generation = 0;
const changed = channel<void>();

function read(server: ServerId, force = false) {
  if ((!force && answers.has(server)) || inFlight.get(server) === generation) return;
  const gen = generation;
  inFlight.set(server, gen);
  invoke<AgentAvailability[]>("agent_availability", {}, server)
    .then((next) => {
      if (gen !== generation) return;
      answers.set(server, next);
      changed.emit();
    })
    // Silent, and deliberately: this decides whether to *warn*, so a failed
    // read must leave every agent offerable rather than mark them all
    // missing. The send-time check still refuses, with the same sentence. A
    // remote server that was unreachable is asked again on the next mount.
    .catch(() => {})
    .finally(() => {
      if (inFlight.get(server) === gen) inFlight.delete(server);
    });
}

/// Reads every answer again, for the one thing that moves it mid-process: the
/// reader turning an ACP agent on or off, which adds or takes away a row. A
/// watched server keeps its old answer on screen until the new one lands.
export function forgetAgentAvailability() {
  generation += 1;
  for (const server of answers.keys()) if (!watched.has(server)) answers.delete(server);
  for (const server of watched.keys()) read(server, true);
}

/// The agents on `server`, or `null` until the first read lands.
///
/// `null` is a resting state and not an error — the composer paints before the
/// read returns, so testing the list alone would flash a warning on an agent
/// that turns out to be installed.
export function useAgentAvailability(server: ServerId = LOCAL): AgentAvailability[] | null {
  const subscribe = useCallback(
    (listener: () => void) => {
      watched.set(server, (watched.get(server) ?? 0) + 1);
      read(server);
      const stop = changed.subscribe(listener);
      return () => {
        stop();
        const left = (watched.get(server) ?? 1) - 1;
        if (left > 0) watched.set(server, left);
        else watched.delete(server);
      };
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
