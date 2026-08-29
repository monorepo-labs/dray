import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

import { useLocalStorage } from "@/hooks/useLocalStorage";
import { cachedApps, load, OPEN_DIR_KEY } from "@/lib/openWith";
import type { ExternalApp } from "@/types/events";

/// The apps that can open a directory, and which one the button opens with.
///
/// The pick is the reader's own last choice, stored by bundle path rather than
/// by name: two builds of one editor differ by path alone, and a name that
/// stops matching would silently reseat the default on the wrong app. A stored
/// path that is no longer installed falls back to the first app in the list —
/// an uninstalled editor should cost the default, never the button.
export function useOpenApps() {
  const [apps, setApps] = useState<ExternalApp[]>(cachedApps);
  const [picked, setPicked] = useLocalStorage<string | null>(OPEN_DIR_KEY, null);

  /// Asks again. Called on mount and whenever the menu opens — the panel this
  /// lives in hides rather than unmounts, so mount alone would run once for
  /// the life of the app and an editor installed afterwards would never
  /// appear. The menu opening is the one moment the list has to be current.
  const refresh = useCallback(() => {
    void load().then(setApps);
  }, []);

  useEffect(refresh, [refresh]);

  const pick = apps.find((app) => app.path === picked) ?? apps[0] ?? null;

  /// Choosing from the menu sets the default and opens nothing.
  ///
  /// Kept apart from [open] deliberately. A menu whose entries both reseat the
  /// default *and* launch has no way to say "next time, this one" without
  /// launching something the reader did not ask for — and picking the wrong row
  /// then costs a window rather than a second click.
  const select = useCallback((app: ExternalApp) => setPicked(app.path), [setPicked]);

  /// Opens `path` in `app`. Returns `open`'s own sentence on failure and `null`
  /// on success — the sentence is the only thing that names the cure, a bundle
  /// that moved or a directory that is gone, and swallowing it left a button
  /// that appeared to do nothing at all.
  const open = useCallback(async (app: ExternalApp, path: string): Promise<string | null> => {
    try {
      await invoke("open_in_app", { appPath: app.path, path });
      return null;
    } catch (err) {
      console.error(`failed to open ${path} in ${app.name}`, err);
      return typeof err === "string" ? err : `Could not open ${app.name}.`;
    }
  }, []);

  return { apps, pick, select, open, refresh };
}
