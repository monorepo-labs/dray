import { useCallback, useSyncExternalStore } from "react";
import { invoke, listen, LOCAL, type ServerId } from "@/lib/transport";

import { channel } from "@/lib/channel";
import { onFocusChange } from "@/lib/focus";
import type { AgentAvailability, Harness } from "@/types/events";

/// Which agents have a CLI behind them, per server.
///
/// A module store rather than per-hook state, for `useTheme`'s reason: the
/// picker and the composer's notice both read it, and two copies would let one
/// mark an agent unavailable while the other still offered to send to it.
///
/// Read once per server, then again where the answer may have moved (#745): a
/// reconnect, since the server may have restarted onto new CLIs, and — while
/// an agent reads missing — the window coming back or the agent menu opening,
/// since that is when a reader who just installed one looks for it.
const answers = new Map<ServerId, AgentAvailability[]>();
const inFlight = new Set<ServerId>();
const recheckedAt = new Map<ServerId, number>();
const changed = channel<void>();

/// Each recheck of a miss costs the server a login shell per missing agent,
/// so focus flicking between windows asks at most this often.
const RECHECK_GAP = 15_000;

let started = false;
function start() {
  if (started) return;
  started = true;
  onFocusChange((focused) => {
    if (focused) for (const server of answers.keys()) recheckMissingAgents(server);
  });
  void listen("live_state", ({ server }) => {
    if (answers.has(server)) rereadAgentAvailability(server);
  });
}

function settle(server: ServerId, ask: Promise<AgentAvailability[]>) {
  inFlight.add(server);
  ask
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

function read(server: ServerId) {
  if (answers.has(server) || inFlight.has(server)) return;
  settle(server, invoke<AgentAvailability[]>("agent_availability", {}, server));
}

/// Asks again, keeping the old answer on screen until the new one lands.
export function rereadAgentAvailability(server: ServerId = LOCAL) {
  settle(server, invoke<AgentAvailability[]>("agent_availability", {}, server));
}

/// Has `server` look again for every agent it reads as missing, then asks
/// again. `recheck_agent` rather than waiting out the server's own hold on a
/// miss, which a server older than #745 never lets go of.
export function recheckMissingAgents(server: ServerId = LOCAL) {
  const missing = answers.get(server)?.filter((a) => !a.available) ?? [];
  if (!missing.length || inFlight.has(server)) return;
  if (Date.now() - (recheckedAt.get(server) ?? 0) < RECHECK_GAP) return;
  recheckedAt.set(server, Date.now());
  settle(
    server,
    Promise.all(missing.map((a) => invoke("recheck_agent", { harness: a.harness }, server).catch(() => false))).then(() =>
      invoke<AgentAvailability[]>("agent_availability", {}, server),
    ),
  );
}

/// The agents on `server`, or `null` until the first read lands.
///
/// `null` is a resting state and not an error — the composer paints before the
/// read returns, so testing the list alone would flash a warning on an agent
/// that turns out to be installed.
export function useAgentAvailability(server: ServerId = LOCAL): AgentAvailability[] | null {
  const subscribe = useCallback(
    (listener: () => void) => {
      start();
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
