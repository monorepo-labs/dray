import { version as APP_VERSION } from "../../src-tauri/tauri.conf.json";

import { readLocalStorage, writeLocalStorage } from "@/hooks/useLocalStorage";
import type { UpdateChannel } from "@/types/events";

/// What drayhq.com/changelog.json answers, parsed from CHANGELOG.md by the
/// site. Stated again here because the two apps share no code; the site's
/// [changelog.ts](../../../web/src/lib/changelog.ts) is the one to change first.
export type ChangelogMedia = { kind: "image" | "video"; url: string; alt: string };
export type ChangelogItem = { title: string | null; body: string; media: ChangelogMedia[] };
export type ChangelogSection = { kind: "new" | "improved" | "fixed"; items: ChangelogItem[] };
export type Release = {
  version: string;
  date: string | null;
  notify: boolean;
  beta: boolean;
  sections: ChangelogSection[];
};

/// `www`, not the apex: the apex answers with a redirect, and a redirect
/// carries no CORS header for the webview to pass.
const URL = "https://www.drayhq.com/changelog.json";

/// The newest release the reader has been told about, or skipped past.
const SEEN_KEY = "ade.changelogSeen";

/// A webview that never ran Dray holds no keys at all, which is the one reading
/// that tells a fresh install from an older one meeting this feature. So a fresh
/// install records its own version as seen here, at module load, before
/// anything else writes a key — not once the feed arrives, since a launch whose
/// request fails would leave the next one looking like an old install.
try {
  if (localStorage.length === 0) writeLocalStorage(SEEN_KEY, APP_VERSION);
} catch {
  // No store at all; the card simply follows whatever reads succeed.
}

let request: Promise<Release[]> | null = null;

/// Fetched once per process; a failure is forgotten so the next caller asks
/// again rather than reading a dead promise for the rest of the run.
export function fetchChangelog(): Promise<Release[]> {
  request ??= fetch(URL)
    .then((r) => {
      if (!r.ok) throw new Error(`changelog: ${r.status}`);
      return r.json() as Promise<Release[]>;
    })
    .catch((e) => {
      request = null;
      throw e;
    });
  return request;
}

/// Semver order, prerelease below its release (`0.27.0-beta.1` < `0.27.0`).
export function compareVersions(a: string, b: string): number {
  const [ac, ap] = a.split(/-(.*)/s);
  const [bc, bp] = b.split(/-(.*)/s);
  const an = ac.split(".").map(Number);
  const bn = bc.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (an[i] ?? 0) - (bn[i] ?? 0);
    if (d) return d;
  }
  if (!ap || !bp) return (ap ? -1 : 0) + (bp ? 1 : 0);
  return ap.localeCompare(bp, undefined, { numeric: true });
}

/// Betas belong to the beta channel alone.
export function forChannel(releases: Release[], channel: UpdateChannel): Release[] {
  return releases.filter((r) => channel === "beta" || !r.beta);
}

/// The release a card should announce, and the version to record as seen.
///
/// Only a release the reader is already running counts: a post published ahead
/// of its build would otherwise advertise something they cannot use yet.
/// `seen` null is an install from before this feature, which gets the newest
/// flagged release; a fresh one was given its own version at load.
export function announcement(
  releases: Release[],
  running: string,
  seen: string | null,
): { release: Release | null; seen: string | null } {
  const runnable = releases
    .filter((r) => compareVersions(r.version, running) <= 0)
    .sort((a, b) => compareVersions(b.version, a.version));
  const newest = runnable[0]?.version;
  if (!newest) return { release: null, seen };
  const floor = seen ?? "0.0.0";
  const release =
    runnable.find((r) => r.notify && compareVersions(r.version, floor) > 0) ?? null;
  return { release, seen: seen && compareVersions(seen, newest) >= 0 ? seen : newest };
}

/// Asks the feed once and answers the release worth a card, with the version
/// to record once the reader has dealt with it. With no card to show, that is
/// recorded here. Every failure is silence: a changelog that cannot be reached
/// is not news.
export async function checkChangelog(): Promise<{ release: Release; seen: string } | null> {
  const channel = readLocalStorage<UpdateChannel>("ade.updateChannel", "stable");
  const all = forChannel(await fetchChangelog(), channel);
  const seen = readLocalStorage<string | null>(SEEN_KEY, null);
  const next = announcement(all, APP_VERSION, seen);
  if (next.release && next.seen) return { release: next.release, seen: next.seen };
  if (next.seen !== seen) writeLocalStorage(SEEN_KEY, next.seen);
  return null;
}

/// Recorded on the card's dismissal rather than on its showing, so a reader
/// who quits without touching it gets it again next launch.
export function markChangelogSeen(version: string) {
  writeLocalStorage(SEEN_KEY, version);
}
