import { useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";

import { channel } from "@/lib/channel";
import type { AgentCheck, AgentUpdate, Harness } from "@/types/events";

const FIRST_CHECK_MS = 30 * 1000;
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
const changed = channel<void>();

function set(patch: Partial<State>) {
  state = { ...state, ...patch };
  changed.emit();
}

/// Bumped as an update starts and as it ends. A check spanning either read a
/// binary the update was replacing, and landing after it would bring back the
/// update the reader just installed.
let generation = 0;

async function check() {
  const asked = generation;
  try {
    const checks = await invoke<AgentCheck[]>("check_agent_updates");
    // Also dropped while an update runs: the binary is mid-replacement, so
    // any answer about it is about to be wrong.
    if (asked !== generation || state.running) return;
    // An agent missing from the answer could not be asked, so its last known
    // state stands rather than reading as current.
    const answered = new Set(checks.map((c) => c.harness));
    const updates = state.updates
      .filter((u) => !answered.has(u.harness))
      .concat(checks.flatMap((c) => (c.update ? [c.update] : [])));
    set({ updates });
  } catch {
    // Silent: a failed check keeps the last answer rather than drawing one.
  }
}

let started = false;

/// Checks shortly after launch and every six hours after, for the life of the
/// process. Not at launch itself: every agent's `--version` and a registry
/// fetch each would compete with the reads the first screen is waiting on.
export function startAgentUpdateChecks() {
  if (started) return;
  started = true;
  setTimeout(() => void check(), FIRST_CHECK_MS);
  setInterval(() => void check(), CHECK_EVERY_MS);
}

export async function updateAgent(harness: Harness) {
  generation++;
  set({ running: harness, failed: null });
  try {
    const still = await invoke<AgentUpdate | null>("update_agent", { harness }).finally(
      () => generation++,
    );
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
  } finally {
    // A scheduled check landing mid-update was dropped whole, so every other
    // agent's answer is owed one now.
    void check();
  }
}

export function updateAgentInTerminal(harness: Harness) {
  invoke("update_agent_in_terminal", { harness }).catch((err) =>
    set({ failed: { harness, message: String(err) } }),
  );
}

export function useAgentUpdates(): State {
  return useSyncExternalStore(changed.subscribe, () => state);
}
