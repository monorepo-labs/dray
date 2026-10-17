import { useEffect, useState, useSyncExternalStore } from "react";

import { readLocalStorage, writeLocalStorage } from "@/hooks/useLocalStorage";
import { channel } from "@/lib/channel";
import { invoke, listen, type ServerId } from "@/lib/transport";
import type { AgentModes, Harness } from "@/types/events";

const NONE: AgentModes = { modes: [], current: null };

/// An ACP agent's own modes, as its last session on `server` reported them,
/// with `current` the selected session's own where there is one. Read again on
/// `models_changed`, which a session opening or moving its mode publishes.
export function useAgentModes(harness: Harness, sessionId: string | null, server: ServerId): AgentModes {
  const key = `${server}|${harness}|${sessionId}`;
  const [answer, setAnswer] = useState<{ key: string; modes: AgentModes } | null>(null);
  useEffect(() => {
    let live = true;
    const read = () =>
      invoke<AgentModes>("agent_modes", { harness, sessionId }, server)
        .then((modes) => live && setAnswer({ key, modes }))
        .catch(() => {});
    void read();
    const unlisten = listen("models_changed", () => void read());
    return () => {
      live = false;
      void unlisten.then((stop) => stop());
    };
  }, [key, harness, sessionId, server]);
  // Keyed, or the previous agent's modes draw for a frame after a switch.
  return answer?.key === key ? answer.modes : NONE;
}

/// The mode a new task on each ACP agent opens in, kept like the stance pref.
const KEY = "ade.agentModeByHarness";
const changed = channel<void>();
let picks = readLocalStorage<Record<string, string>>(KEY, {});

export function pickAgentMode(harness: Harness, mode: string) {
  picks = { ...picks, [harness]: mode };
  writeLocalStorage(KEY, picks);
  changed.emit();
}

/// What the send hands the backend before a new session's first spawn.
export function pendingAgentMode(harness: Harness): string | null {
  return picks[harness] ?? null;
}

export function usePendingAgentMode(harness: Harness): string | null {
  return useSyncExternalStore(changed.subscribe, () => pendingAgentMode(harness), () => null);
}
