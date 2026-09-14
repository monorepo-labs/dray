import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";

import type { Harness, SlashCommand } from "@/types/events";

/// Kept across mounts, keyed by harness *and* directory. The backend caches
/// these too, so this only saves the round trip — but the composer remounts on
/// every session switch, and a picker that refetched each time would open empty
/// on the first keystroke after every switch.
///
/// The harness is half the key because it is half the answer: each publishes its
/// own commands, and pi has never heard of Claude Code's.
const cache = new Map<string, SlashCommand[]>();

/// A landed answer and what it is an answer *to*. The key travels with it
/// because an answer to a question nobody is asking any more is not an answer:
/// the harness toggle moves the key mid-render, and state alone would hand the
/// previous harness's commands to the picker for the frame before the effect
/// catches up.
type Answer = { key: string; commands: SlashCommand[] };

/// The slash commands `harness` offers in `cwd`.
///
/// `loading` is what tells an empty list apart from one that hasn't arrived. A
/// harness publishing none at all is a thing the picker says out loud, which
/// would be a lie drawn over Claude Code's ~1.5s cold probe — and a lie again
/// over a probe that *failed*, so a failure stays pending forever rather than
/// answering empty. The picker then simply never opens, which is what it did
/// before there was anything to say, and a command typed by hand still works.
export function useSlashCommands(
  cwd: string | null,
  harness: Harness,
): { commands: SlashCommand[]; loading: boolean } {
  const key = cwd ? `${harness}\u0000${cwd}` : null;
  const [answer, setAnswer] = useState<Answer | null>(null);

  // Read during render rather than in an effect, the bargain the issue caches
  // make for the same reason: an effect paints one frame of the previous
  // project's commands before it replaces them.
  const hit = key ? cache.get(key) : undefined;
  const current = hit ? { key: key!, commands: hit } : answer?.key === key ? answer : null;

  useEffect(() => {
    if (!key || cache.has(key)) return;

    // The probe spawns a CLI child and takes ~1.5s, so a fast project switch can
    // easily outrun it — without the guard the previous project's commands land
    // on top of this one's.
    let cancelled = false;

    invoke<SlashCommand[]>("list_slash_commands", { cwd, harness })
      .then((list) => {
        cache.set(key, list);
        if (!cancelled) setAnswer({ key, commands: list });
      })
      .catch((e) => {
        // Deliberately answers nothing. An unreachable CLI is not a CLI with no
        // commands, and the one is not worth saying in the other's words — so
        // this key stays pending and the picker stays shut. Nothing retries it
        // until the reader moves to another project or harness, which is where
        // the cache would have stood in the way anyway.
        console.error("[slash commands]", e);
      });

    return () => {
      cancelled = true;
    };
  }, [cwd, harness, key]);

  return { commands: current?.commands ?? [], loading: key !== null && current === null };
}
