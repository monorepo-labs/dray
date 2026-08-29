import { useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";

import type { AgentAvailability, Harness } from "@/types/events";

/// Which agents have a CLI behind them on this machine.
///
/// A module store rather than per-hook state, for `useTheme`'s reason: the
/// picker and the composer's notice both read it, and two copies would let one
/// mark an agent unavailable while the other still offered to send to it.
///
/// Read once per process. The answer cannot change while the app runs — Rust
/// caches the resolution in a `OnceLock`, absence included — so refetching
/// would spend a login shell to be told the same thing.
let answers: AgentAvailability[] | null = null;
let inFlight: Promise<void> | null = null;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (!answers && !inFlight) {
    inFlight = invoke<AgentAvailability[]>("agent_availability")
      .then((next) => {
        answers = next;
        emit();
      })
      // Silent, and deliberately: this decides whether to *warn*, so a failed
      // read must leave every agent offerable rather than mark them all
      // missing. The send-time check still refuses, with the same sentence.
      .catch(() => {})
      .finally(() => {
        inFlight = null;
      });
  }
  return () => {
    listeners.delete(listener);
  };
}

function snapshot() {
  return answers;
}

/// The agents, or `null` until the first read lands.
///
/// `null` is a resting state and not an error — the composer paints before the
/// read returns, so testing the list alone would flash a warning on an agent
/// that turns out to be installed.
export function useAgentAvailability(): AgentAvailability[] | null {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/// What to say about one agent, or `null` where there is nothing to say —
/// either it is installed, or nobody has answered yet.
export function useMissingAgent(harness: Harness): AgentAvailability | null {
  const all = useAgentAvailability();
  const found = all?.find((a) => a.harness === harness);
  return found && !found.available ? found : null;
}
