import { useEffect, useSyncExternalStore } from "react";
import { invoke } from "@/lib/transport";

import { readLocalStorage, writeLocalStorage } from "@/hooks/useLocalStorage";
import { nextAutoUpdate } from "@/lib/agentUpdates";
import { channel } from "@/lib/channel";
import type { AgentCheck, AgentUpdate, Harness } from "@/types/events";

const FIRST_CHECK_MS = 30 * 1000;
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
const DONE_MS = 4000;
const AUTO_KEY = "ade.autoUpdateAgents";

type State = {
  updates: AgentUpdate[];
  running: Harness | null;
  done: Harness | null;
  /// Per agent, since a second agent's automatic update must not wipe the first
  /// one's failure off the screen.
  failed: Partial<Record<Harness, string>>;
  /// Whether updates run on their own. Off brings back the Update button.
  auto: boolean;
};

/// A module store, `useAgentAvailability`'s reason: the check runs from launch
/// whether or not a composer is mounted, and a run outlives the composer that
/// started it.
let state: State = {
  updates: [],
  running: null,
  done: null,
  failed: {},
  auto: readLocalStorage(AUTO_KEY, true),
};
const changed = channel<void>();

function set(patch: Partial<State>) {
  state = { ...state, ...patch };
  changed.emit();
}

function withFailure(harness: Harness, message: string | null) {
  const { [harness]: _, ...others } = state.failed;
  return message === null ? others : { ...others, [harness]: message };
}

export function setAutoUpdateAgents(on: boolean) {
  writeLocalStorage(AUTO_KEY, on);
  set({ auto: on });
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
  set({ running: harness, failed: withFailure(harness, null) });
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
        failed: withFailure(harness, "the version did not change"),
      });
      return;
    }
    set({ updates, running: null, done: harness });
    setTimeout(() => state.done === harness && set({ done: null }), DONE_MS);
  } catch (err) {
    set({ running: null, failed: withFailure(harness, String(err)) });
  } finally {
    // A scheduled check landing mid-update was dropped whole, so every other
    // agent's answer is owed one now.
    void check();
  }
}

export function updateAgentInTerminal(harness: Harness) {
  invoke("update_agent_in_terminal", { harness }).catch((err) =>
    set({ failed: withFailure(harness, String(err)) }),
  );
}

export function useAgentUpdates(): State {
  return useSyncExternalStore(changed.subscribe, () => state);
}

/// Module state like the rest, so a remount cannot forget an attempt. A restart
/// does, which is the one retry a failed version gets.
const tried = new Map<Harness, string>();

/// Runs updates as checks find them, one at a time, for as long as `App` is up.
export function useAutoUpdateAgents(enabled: Harness[], turnRunning: (harness: Harness) => boolean) {
  const { updates, running, auto } = useAgentUpdates();
  const next = auto && !running ? nextAutoUpdate(updates, enabled, turnRunning, tried) : null;
  const harness = next?.harness;
  const latest = next?.latest;
  useEffect(() => {
    // Read again here: StrictMode runs this twice before `running` can answer.
    if (!harness || !latest || tried.get(harness) === latest) return;
    tried.set(harness, latest);
    void updateAgent(harness);
  }, [harness, latest]);
}
