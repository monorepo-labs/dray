import { useSyncExternalStore } from "react";

import { readLocalStorage, writeLocalStorage } from "@/hooks/useLocalStorage";
import { writeDraft, readDraft } from "@/hooks/useDraft";
import { channel } from "@/lib/channel";
import { remoteServers } from "@/lib/servers";
import { invoke, LOCAL, type ServerId } from "@/lib/transport";
import type { ServerInfo } from "@/types/events";

/// A sandbox with nothing to send to: stopped, or on its way back.
export const boatAsleep = (server: ServerInfo | undefined): boolean =>
  !!server?.boat && server.boat.phase !== "running";

export const boatAsleepById = (id: ServerId): boolean =>
  boatAsleep(remoteServers().find((s) => s.id === id));

/// Resumes it, and answers once its server is up. Shared by every caller, so
/// Resume pressed during a send runs one `boat resume`.
export const resumeBoat = (id: ServerId): Promise<void> => invoke("resume_boat", { id }, LOCAL);

/// `boat extend`: `minutes` from now, and every later resume's length. It
/// sets the time left, never adds to it.
export const extendBoat = (id: ServerId, minutes: number): Promise<void> =>
  invoke("extend_boat", { id, minutes }, LOCAL);

/// Off while readers find them noisy; `true` brings the sidebar's card back.
/// Its twin of the same name in `servers.rs` gates the island's warning.
export const BOAT_STOP_WARNINGS = false;

/// How long before auto-stop the warning comes, `servers.rs`'s `WARN`.
export const WARN_MINUTES = 10;

/// Extend's stepper: 30-minute steps, up to boat's 30-day cap.
export const EXTEND_STEP = 30;
export const MAX_EXTEND_MINUTES = 30 * 24 * 60;

/// "2h", "2h 30m", "30m".
export function durationLabel(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return [h && `${h}h`, m && `${m}m`].filter(Boolean).join(" ") || "0m";
}

/// What auto-extend gives a sandbox about to stop mid-turn.
export const AUTO_EXTEND_MINUTES = 30;

type Prefs = {
  /// Where Extend's stepper starts: the last length extended by.
  minutes: number;
  /// Extend a busy sandbox on its own as it is about to stop. Off until asked.
  auto: boolean;
  /// The one-time card offering `auto` has been answered or shown.
  offered: boolean;
};

const PREFS = "ade.boat";
const DEFAULTS: Prefs = { minutes: 120, auto: false, offered: false };
let prefs: Prefs = { ...DEFAULTS, ...readLocalStorage<Partial<Prefs>>(PREFS, {}) };
const prefsChanged = channel<void>();

export function setBoatPrefs(next: Partial<Prefs>) {
  prefs = { ...prefs, ...next };
  writeLocalStorage(PREFS, prefs);
  prefsChanged.emit();
}

/// One store for Settings, the card and the auto-extend check, so a switch
/// turned off in one is off in all.
export function useBoatPrefs(): Prefs {
  return useSyncExternalStore(prefsChanged.subscribe, () => prefs);
}

const HELD = "ade.boatHeld";
type Held = { id: string; key: string | null; message: string };

/// Keeps a prompt on disk while its sandbox wakes, which takes minutes: the send
/// is in memory until then, and a quit would lose it. Answers what lets it go.
export function holdThroughResume(key: string | null, message: string): () => void {
  const id = crypto.randomUUID();
  writeLocalStorage<Held[]>(HELD, [...readLocalStorage<Held[]>(HELD, []), { id, key, message }]);
  return () => writeLocalStorage<Held[]>(HELD, readLocalStorage<Held[]>(HELD, []).filter((h) => h.id !== id));
}

/// Puts back what a quit interrupted, as text in its composer. Never sent on its
/// own: nothing says how long ago that was, or whether it reached the server.
export function restoreHeld() {
  const held = readLocalStorage<Held[]>(HELD, []);
  if (!held.length) return;
  for (const { key, message } of held) {
    const there = readDraft(key);
    writeDraft(key, there ? `${there}\n\n${message}` : message);
  }
  writeLocalStorage<Held[]>(HELD, []);
}

/// "03:12" left before `stopsAt`, counted from `now`.
export function countdown(stopsAt: string, now: number): string {
  const seconds = Math.max(0, Math.floor((new Date(stopsAt).getTime() - now) / 1000));
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(Math.floor(seconds / 60))}:${pad(seconds % 60)}`;
}
