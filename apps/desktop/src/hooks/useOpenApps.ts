import { useCallback, useEffect, useState } from "react";

import { useLocalStorage } from "@/hooks/useLocalStorage";
import { cachedApps, DIR_OPENER, load, type Opener } from "@/lib/openWith";
import type { ExternalApp } from "@/types/events";

/// The apps that can open what this control opens, and which one it opens with.
///
/// The pick is the reader's own last choice, stored by bundle path rather than
/// by name: two builds of one editor differ by path alone, and a name that
/// stops matching would silently reseat the default on the wrong app.
///
/// What is offered, what stands in for a missing pick and what opening even
/// *means* all differ between a directory and a file, so they travel together
/// as an [Opener] rather than as three flags — and the file half must answer
/// exactly as `openFile` does, or the button would name one app while a
/// ⌘-click in the transcript reached another.
export function useOpenApps(opener: Opener = DIR_OPENER) {
  const [all, setApps] = useState<ExternalApp[]>(cachedApps);
  const [picked, setPicked] = useLocalStorage<string | null>(opener.key, null);
  const apps = opener.choices(all);

  /// Asks again. Called on mount and whenever the menu opens — the panel this
  /// lives in hides rather than unmounts, so mount alone would run once for
  /// the life of the app and an editor installed afterwards would never
  /// appear. The menu opening is the one moment the list has to be current.
  const refresh = useCallback(() => {
    void load().then(setApps);
  }, []);

  useEffect(refresh, [refresh]);

  const pick = opener.pick(all, picked);

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
  const open = useCallback(
    async (app: ExternalApp, path: string, line?: number): Promise<string | null> => {
      try {
        await opener.open(app, path, line);
        return null;
      } catch (err) {
        console.error(`failed to open ${path} in ${app.name}`, err);
        return typeof err === "string" ? err : `Could not open ${app.name}.`;
      }
    },
    [opener],
  );

  return { apps, pick, select, open, refresh };
}
