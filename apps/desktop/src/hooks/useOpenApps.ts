import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

import { useLocalStorage } from "@/hooks/useLocalStorage";
import type { ExternalApp } from "@/types/events";

/// Which app the reader last chose to open a working directory with, by bundle
/// path.
///
/// One value for the whole app, not one per session: which editor you use is a
/// fact about you, the same standing preference `ade.diffStyle` and
/// `ade.updateChannel` are. Keyed per session it would have to be *learned*
/// again on every new session, which is where it is least likely to be right.
const PICK_KEY = "ade.openWith";

/// The last answer, so a button drawn after the first read paints at once
/// instead of flashing in a frame later. Not a cache in the sense of being
/// trusted: every `load` asks again. The read is a handful of `read_dir`s with
/// the icons cached on the Rust side, so there is nothing here worth a
/// freshness window — and a window that nothing re-checks is what a first
/// version shipped, on a button that is mounted for the life of the app.
let last: ExternalApp[] = [];
let inFlight: Promise<ExternalApp[]> | null = null;

async function load(): Promise<ExternalApp[]> {
  // Several buttons mounting in one frame must not each spawn a scan.
  inFlight ??= invoke<ExternalApp[]>("list_open_apps")
    .then((apps) => (last = apps))
    .catch((err) => {
      // `list_open_apps` is infallible on its own side, so this only fires
      // when IPC itself is broken. Keep the last answer rather than blank it.
      console.error("failed to list the apps that can open a directory", err);
      return last;
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

/// The apps that can open a directory, and which one the button opens with.
///
/// The pick is the reader's own last choice, stored by bundle path rather than
/// by name: two builds of one editor differ by path alone, and a name that
/// stops matching would silently reseat the default on the wrong app. A stored
/// path that is no longer installed falls back to the first app in the list —
/// an uninstalled editor should cost the default, never the button.
export function useOpenApps() {
  const [apps, setApps] = useState<ExternalApp[]>(last);
  const [picked, setPicked] = useLocalStorage<string | null>(PICK_KEY, null);

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
