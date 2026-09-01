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

/// The slash commands `harness` offers in `cwd`, empty until they land.
///
/// A failed probe resolves to no commands rather than surfacing an error: the
/// picker is an accelerator for text the user can always type by hand, so it
/// staying shut is a smaller failure than an error banner over the composer.
export function useSlashCommands(
  cwd: string | null,
  harness: Harness,
): SlashCommand[] {
  const key = cwd ? `${harness}\u0000${cwd}` : null;
  const [commands, setCommands] = useState<SlashCommand[]>(
    () => (key ? cache.get(key) : undefined) ?? [],
  );

  useEffect(() => {
    if (!cwd || !key) {
      setCommands([]);
      return;
    }

    const hit = cache.get(key);
    if (hit) {
      setCommands(hit);
      return;
    }

    // The probe spawns a CLI child and takes ~1.5s, so a fast project switch can
    // easily outrun it — without the guard the previous project's commands land
    // on top of this one's.
    let cancelled = false;
    // Cleared rather than left stale: offering another project's project-scoped
    // commands is worse than offering none.
    setCommands([]);

    invoke<SlashCommand[]>("list_slash_commands", { cwd, harness })
      .then((list) => {
        cache.set(key, list);
        if (!cancelled) setCommands(list);
      })
      .catch((e) => {
        console.error("[slash commands]", e);
        if (!cancelled) setCommands([]);
      });

    return () => {
      cancelled = true;
    };
  }, [cwd, harness, key]);

  return commands;
}
