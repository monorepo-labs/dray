import { useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";

import type { AgentUpdate, Harness } from "@/types/events";

const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
const DONE_MS = 4000;

type State = {
  updates: AgentUpdate[];
  running: Harness | null;
  done: Harness | null;
  failed: { harness: Harness; message: string } | null;
};

/// A module store, `useAgentAvailability`'s reason: the check runs from launch
/// whether or not a composer is mounted, and a run outlives the composer that
/// started it.
let state: State = { updates: [], running: null, done: null, failed: null };
const listeners = new Set<() => void>();

function set(patch: Partial<State>) {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
}

async function check() {
  try {
    const updates = await invoke<AgentUpdate[]>("check_agent_updates");
    set({ updates });
  } catch {
    // Silent: a failed check keeps the last answer rather than drawing one.
  }
}

let started = false;

/// Checks now and every six hours after, for the life of the process.
export function startAgentUpdateChecks() {
  if (started) return;
  started = true;
  void check();
  setInterval(() => void check(), CHECK_EVERY_MS);
}

export async function updateAgent(harness: Harness) {
  set({ running: harness, failed: null });
  try {
    const still = await invoke<AgentUpdate | null>("update_agent", { harness });
    const updates = state.updates.filter((u) => u.harness !== harness);
    if (still) {
      // The updater exited cleanly and the version did not move. Drawn as a
      // failure, since Terminal is where the reader can see why.
      set({
        updates: [...updates, still],
        running: null,
        failed: { harness, message: "the version did not change" },
      });
      return;
    }
    set({ updates, running: null, done: harness });
    setTimeout(() => state.done === harness && set({ done: null }), DONE_MS);
  } catch (err) {
    set({ running: null, failed: { harness, message: String(err) } });
  }
}

export function updateAgentInTerminal(harness: Harness) {
  invoke("update_agent_in_terminal", { harness }).catch((err) =>
    set({ failed: { harness, message: String(err) } }),
  );
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useAgentUpdates(): State {
  return useSyncExternalStore(subscribe, () => state);
}
