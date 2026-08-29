import { invoke } from "@tauri-apps/api/core";
import { revealItemInDir } from "@tauri-apps/plugin-opener";

import { readLocalStorage } from "@/hooks/useLocalStorage";
import type { ExternalApp } from "@/types/events";

/// Which app the reader last opened a session's *working directory* with, by
/// bundle path.
///
/// One value for the whole app, not one per session: which editor you use is a
/// fact about you, the same standing preference `ade.diffStyle` and
/// `ade.updateChannel` are. Keyed per session it would have to be *learned*
/// again on every new session, which is where it is least likely to be right.
export const OPEN_DIR_KEY = "ade.openWith";

/// Which app a *filename* in the transcript opens in, by bundle path.
///
/// Deliberately not [OPEN_DIR_KEY]. That one is the panel button's own last
/// choice and holds terminals and Finder too — so a reader who last opened
/// their checkout in Ghostty would find that clicking a filename opened a
/// terminal, which is no answer to "show me this file".
export const OPEN_FILE_KEY = "ade.openFileWith";

/// The last answer, so a control drawn after the first read paints at once
/// instead of flashing in a frame later. Not a cache in the sense of being
/// trusted: every `load` asks again. The read is a handful of `read_dir`s with
/// the icons cached on the Rust side, so there is nothing here worth a
/// freshness window — and a window that nothing re-checks is what a first
/// version shipped, on a button that is mounted for the life of the app.
let last: ExternalApp[] = [];
let inFlight: Promise<ExternalApp[]> | null = null;

/// The last list read, for a control that would otherwise paint empty for a
/// frame while `load` re-asks.
export function cachedApps(): ExternalApp[] {
  return last;
}

/// The apps on this machine that can be handed a path.
export async function load(): Promise<ExternalApp[]> {
  // Several controls mounting in one frame must not each spawn a scan.
  inFlight ??= invoke<ExternalApp[]>("list_open_apps")
    .then((apps) => (last = apps))
    .catch((err) => {
      // `list_open_apps` is infallible on its own side, so this only fires
      // when IPC itself is broken. Keep the last answer rather than blank it.
      console.error("failed to list the apps that can open a path", err);
      return last;
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

/// The apps worth offering for a single file: editors, and Finder.
///
/// Terminals are dropped rather than listed and ignored — handing one file to
/// Ghostty is not a thing the reader asked for, and an entry that cannot do
/// what its row promises is worse than one that isn't there.
export function fileOpenerChoices(apps: ExternalApp[]): ExternalApp[] {
  return apps.filter((app) => app.kind === "editor" || app.kind === "files");
}

/// Which of those a filename opens in, given what the reader stored.
///
/// Falls back to Finder rather than to the first editor, unlike the panel
/// button next door. That button has to open *something*, so any app beats
/// none; this one has a correct quiet answer. A stored editor that is no
/// longer installed therefore costs the preference and leaves the link doing
/// what it did before the setting existed, instead of silently reseating on
/// whichever editor happens to lead the table.
///
/// `null` only where nothing was detected at all, which off macOS is every
/// time.
export function pickFileOpener(
  apps: ExternalApp[],
  stored: string | null,
): ExternalApp | null {
  const choices = fileOpenerChoices(apps);
  return (
    choices.find((app) => app.path === stored) ??
    choices.find((app) => app.kind === "files") ??
    null
  );
}

/// Opens `path` the way the reader asked for in Settings.
///
/// Finder is the default and it *reveals* rather than opens: `open -a Finder`
/// on a source file hands Finder a document it has no use for, where selecting
/// it in a window is what the reader means by picking Finder here.
///
/// Every other failure lands there too. A bundle that moved, an editor that
/// refuses the file, no app detected at all — all of them fall through to the
/// reveal, so the worst this click can do is what it did before the setting
/// existed. A transcript row has nowhere to put an error sentence, so the
/// failure has to be a working link rather than a message.
export async function openFile(path: string): Promise<void> {
  const stored = readLocalStorage<string | null>(OPEN_FILE_KEY, null);
  const app = pickFileOpener(await load(), stored);

  if (app && app.kind !== "files") {
    try {
      await invoke("open_in_app", { appPath: app.path, path });
      return;
    } catch (err) {
      console.error(`failed to open ${path} in ${app.name}`, err);
    }
  }

  await revealItemInDir(path).catch(() => {});
}
