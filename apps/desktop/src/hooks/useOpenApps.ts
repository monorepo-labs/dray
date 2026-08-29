import { useCallback, useEffect, useRef, useState } from "react";
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

/// How long a detection result is counted fresh.
///
/// A window rather than a permanent cache, and that is a correctness fix rather
/// than a tuning knob: `list_open_apps` re-scans on every call precisely so an
/// editor installed while Dray runs appears without a restart, and a frontend
/// cache that never expires takes that guarantee straight back — a newly
/// installed app would stay missing, and an app that moved would keep a stale
/// bundle path on offer, for the life of the process.
///
/// 60s is the same window `useIssues` counts a read fresh for, and it is picked
/// against the same two costs: opening the menu has to be free when it was just
/// opened, while installing an editor and coming back to the button has to work.
///
/// The window alone does nothing — see `refresh` below for what re-checks it.
const FRESH_MS = 60_000;

/// How long before a failed first read is tried again. One retry, never a poll
/// — see the effect below.
const RETRY_MS = 4000;

let cached: ExternalApp[] | null = null;
let readAt = 0;
let inFlight: Promise<ExternalApp[]> | null = null;
/// Whether the last read failed, which is what separates "the scan found
/// nothing" from "the scan never answered". Only the second is worth retrying.
let failed = false;

function fresh() {
  return cached !== null && Date.now() - readAt < FRESH_MS;
}

async function load(): Promise<ExternalApp[]> {
  if (fresh()) return cached!;
  // Several buttons mounting in one frame must not each spawn a scan.
  inFlight ??= invoke<ExternalApp[]>("list_open_apps")
    .then((apps) => {
      cached = apps;
      readAt = Date.now();
      failed = false;
      return apps;
    })
    .catch((err) => {
      console.error("failed to list the apps that can open a directory", err);
      failed = true;
      // A failed read changes nothing — no list written, no stamp — so a blip
      // leaves the last good answer on screen and the next read tries again
      // rather than certifying an empty one as fresh for a minute. The same
      // bargain `usePrMarks` makes with its own failed reads.
      return cached ?? [];
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
export function useOpenApps(key?: string) {
  const [apps, setApps] = useState<ExternalApp[]>(cached ?? []);
  const [picked, setPicked] = useLocalStorage<string | null>(PICK_KEY, null);
  const live = useRef(true);
  const retry = useRef<ReturnType<typeof setTimeout> | null>(null);

  /// Reads if the cached answer has gone stale, and does nothing if it hasn't.
  ///
  /// Callable rather than only an effect, because the panel this button lives
  /// in is **mounted forever** — closing the pane and switching tabs hide it
  /// rather than unmounting it. So a mount effect runs exactly once for the
  /// life of the app, and a freshness window nothing re-checks expires without
  /// anything noticing: the whole point of the window, a newly installed editor
  /// showing up, was unreachable.
  const refresh = useCallback(() => {
    void load().then((next) => live.current && setApps(next));
  }, []);

  // `key` is the caller's own "something changed" beat — the session's cwd, in
  // practice — and it exists so a read can happen somewhere the *button* isn't.
  //
  // That matters for exactly one case, and it is a deadlock without it: a first
  // read that fails leaves no apps, and with no apps there is no button, so
  // there is no menu to open and the menu was otherwise the only later trigger.
  // The control would be gone until restart over one failed IPC call. Keyed
  // here it heals on the next session switch instead, and costs nothing in the
  // ordinary case because `load` no-ops inside the freshness window.
  useEffect(() => {
    live.current = true;
    void load().then((next) => {
      if (!live.current) return;
      setApps(next);

      // One retry, and only for the read whose failure cannot correct itself.
      // A failed first read leaves no apps, and with no apps there is no button
      // and so no menu — so on a reader who stays in the session they are in,
      // nothing would ever ask again. Exactly one, and never a poll: a control
      // that cannot be drawn must not turn into a standing spawn either.
      //
      // Gated on `failed` rather than on the list being empty, because a scan
      // that genuinely finds nothing is an answer and retrying it is waste.
      if (failed && !retry.current) {
        retry.current = setTimeout(() => {
          retry.current = null;
          refresh();
        }, RETRY_MS);
      }
    });
    return () => {
      live.current = false;
    };
  }, [refresh, key]);

  // Outlives a key change deliberately — a retry armed under one session should
  // still land after the reader switches to another.
  useEffect(() => () => void (retry.current && clearTimeout(retry.current)), []);

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

  /// Opens `path` in `app`, answering the failure rather than swallowing it.
  ///
  /// Returns `open`'s own sentence on failure and `null` on success. The error
  /// has to come back here because it is the only thing that names the cure —
  /// a bundle that moved, a directory that is gone — where the alternative is a
  /// button that appears to do nothing at all.
  const open = useCallback(
    async (app: ExternalApp, path: string): Promise<string | null> => {
      try {
        await invoke("open_in_app", { appPath: app.path, path });
        return null;
      } catch (err) {
        console.error(`failed to open ${path} in ${app.name}`, err);
        return typeof err === "string" ? err : `Could not open ${app.name}.`;
      }
    },
    [],
  );

  return { apps, pick, select, open, refresh };
}
