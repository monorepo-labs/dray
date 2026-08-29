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

/// The scan is a handful of `read_dir`s and the icons are cached in Rust, so
/// the cost here is one round trip. Held at module level anyway, because the
/// panel this button lives in remounts on every session switch and a fresh
/// invoke per switch buys nothing — the set of installed apps does not move
/// while the reader clicks between sessions.
let cached: ExternalApp[] | null = null;
let inFlight: Promise<ExternalApp[]> | null = null;

async function load(): Promise<ExternalApp[]> {
  if (cached) return cached;
  // Several buttons mounting in one frame must not each spawn a scan.
  inFlight ??= invoke<ExternalApp[]>("list_open_apps")
    .catch((err) => {
      console.error("failed to list the apps that can open a directory", err);
      return [] as ExternalApp[];
    })
    .then((apps) => {
      cached = apps;
      inFlight = null;
      return apps;
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
  const [apps, setApps] = useState<ExternalApp[]>(cached ?? []);
  const [picked, setPicked] = useLocalStorage<string | null>(PICK_KEY, null);

  useEffect(() => {
    if (cached) return;
    let live = true;
    void load().then((next) => live && setApps(next));
    return () => {
      live = false;
    };
  }, []);

  const pick = apps.find((app) => app.path === picked) ?? apps[0] ?? null;

  /// Choosing from the menu sets the default and opens nothing.
  ///
  /// Kept apart from [open] deliberately. A menu whose entries both reseat the
  /// default *and* launch has no way to say "next time, this one" without
  /// launching something the reader did not ask for — and picking the wrong row
  /// then costs a window rather than a second click.
  const select = useCallback(
    (app: ExternalApp) => setPicked(app.path),
    [setPicked],
  );

  const open = useCallback(
    async (app: ExternalApp, path: string) => {
      try {
        await invoke("open_in_app", { appPath: app.path, path });
      } catch (err) {
        console.error(`failed to open ${path} in ${app.name}`, err);
      }
    },
    [],
  );

  return { apps, pick, select, open };
}
