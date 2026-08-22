import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";

import type { SlashCommand } from "@/types/events";

/// Kept across mounts, keyed by directory. The backend caches these too, so this
/// only saves the round trip — but the composer remounts on every session
/// switch, and a picker that refetched each time would open empty on the first
/// keystroke after every switch.
const cache = new Map<string, SlashCommand[]>();

/// The slash commands available in `cwd`, empty until they land.
///
/// A failed probe resolves to no commands rather than surfacing an error: the
/// picker is an accelerator for text the user can always type by hand, so it
/// staying shut is a smaller failure than an error banner over the composer.
export function useSlashCommands(cwd: string | null): SlashCommand[] {
  const [commands, setCommands] = useState<SlashCommand[]>(
    () => (cwd ? cache.get(cwd) : undefined) ?? [],
  );

  useEffect(() => {
    if (!cwd) {
      setCommands([]);
      return;
    }

    const hit = cache.get(cwd);
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

    invoke<SlashCommand[]>("list_slash_commands", { cwd })
      .then((list) => {
        cache.set(cwd, list);
        if (!cancelled) setCommands(list);
      })
      .catch((e) => {
        console.error("[slash commands]", e);
        if (!cancelled) setCommands([]);
      });

    return () => {
      cancelled = true;
    };
  }, [cwd]);

  return commands;
}
