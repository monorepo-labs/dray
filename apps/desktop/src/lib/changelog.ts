import { version as APP_VERSION } from "../../src-tauri/tauri.conf.json";

import { readLocalStorage, writeLocalStorage } from "@/hooks/useLocalStorage";
import { invoke, LOCAL } from "@/lib/transport";
import type { UpdateChannel } from "@/types/events";

/// What drayhq.com/changelog.json answers, parsed from CHANGELOG.md by the
/// site. Stated again here because the two apps share no code; the site's
/// [changelog.ts](../../../web/src/lib/changelog.ts) is the one to change first.
export type ChangelogMedia = { kind: "image" | "video"; url: string; alt: string };
export type ChangelogApp = "desktop" | "ios" | "android";
export type ChangelogHighlight = {
  apps: ChangelogApp[];
  action: { label: string; target: string } | null;
  /// The reader must act on it: listed first and drawn apart. A condition
  /// name makes it so only where [`settle`] finds the condition holds.
  required?: boolean | ChangelogCondition;
  /// The plain title, and picture, shown where a conditional `required` does
  /// not hold.
  otherwise?: string;
  otherwiseMedia?: ChangelogMedia;
};
/// What the app can find out about its reader. A name this build does not
/// know reads as not holding.
export type ChangelogCondition = "remote-access" | (string & {});
/// What `settle` reads a condition off, asked of the local server.
export type ReaderFacts = { remoteAccess: boolean };
export const NO_FACTS: ReaderFacts = { remoteAccess: false };
/// `highlight` is absent in a feed built before highlights existed.
export type ChangelogItem = {
  title: string | null;
  body: string;
  media: ChangelogMedia[];
  highlight?: ChangelogHighlight | null;
};
/// One card of What's New, with the release it shipped in.
export type Highlight = { version: string; item: ChangelogItem };
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
const URL =
  (import.meta.env.DEV && import.meta.env.VITE_DRAY_CHANGELOG_URL) ||
  "https://www.drayhq.com/changelog.json";

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

/// The release's items flagged as highlights for this app, in file order.
export function desktopHighlights(release: Release): Highlight[] {
  return release.sections.flatMap((s) =>
    s.items
      .filter((item) => item.highlight?.apps.includes("desktop"))
      .map((item) => ({ version: release.version, item })),
  );
}

/// What to announce, and the version to record as seen.
///
/// Highlights win: every desktop one from a release past `seen` gets a page,
/// newest release first, so one shipped in a release the reader updated
/// straight past still gets its page. With none, the newest `notify` release
/// past `seen` gets the small card.
///
/// Only a release the reader is already running counts: a post published ahead
/// of its build would otherwise advertise something they cannot use yet.
/// `seen` null is an install from before this feature, which hears of the
/// newest flagged release alone; a fresh one was given its own version at load.
export function announcement(
  releases: Release[],
  running: string,
  seen: string | null,
  facts: ReaderFacts = NO_FACTS,
): { release: Release | null; highlights: Highlight[]; seen: string | null } {
  const runnable = releases
    .filter((r) => compareVersions(r.version, running) <= 0)
    .sort((a, b) => compareVersions(b.version, a.version));
  const newest = runnable[0]?.version;
  if (!newest) return { release: null, highlights: [], seen };
  const fresh = runnable.filter((r) => compareVersions(r.version, seen ?? "0.0.0") > 0);
  const release = fresh.find((r) => r.notify) ?? null;
  const all = (seen ? fresh : fresh.slice(0, 1)).flatMap(desktopHighlights).map((h) => settle(h, facts));
  // Stable: required ones lead, each group keeping its newest-first order.
  const highlights = [...all.filter((h) => h.item.highlight?.required), ...all.filter((h) => !h.item.highlight?.required)];
  return {
    release: highlights.length ? null : release,
    highlights,
    seen: seen && compareVersions(seen, newest) >= 0 ? seen : newest,
  };
}

/// A highlight whose `required` names a condition, decided for this reader:
/// the action card where the condition holds, else a plain card under its
/// `otherwise` title with no action, since there is nothing for them to do.
/// One with no condition passes through.
export function settle(h: Highlight, facts: ReaderFacts): Highlight {
  const hl = h.item.highlight;
  if (!hl || typeof hl.required !== "string") return h;
  const holds = hl.required === "remote-access" && facts.remoteAccess;
  if (holds) return { ...h, item: { ...h.item, highlight: { ...hl, required: true } } };
  return {
    ...h,
    item: {
      ...h.item,
      title: hl.otherwise ?? h.item.title,
      media: hl.otherwiseMedia ? [hl.otherwiseMedia] : h.item.media,
      highlight: { ...hl, required: false, action: null },
    },
  };
}

/// Whether any desktop highlight in the feed waits on a condition, so the
/// local server is asked only when an answer matters.
function needsFacts(releases: Release[]): boolean {
  return releases.some((r) => desktopHighlights(r).some((h) => typeof h.item.highlight?.required === "string"));
}

/// This machine's Remote access switch, as its own server holds it at the
/// moment the page is about to open. A server that cannot be asked reads as
/// on: telling someone to reconnect who need not costs less than leaving
/// someone who must with phones that no longer reach them.
async function readFacts(): Promise<ReaderFacts> {
  try {
    const now = await invoke<{ on: boolean }>("get_remote_access", {}, LOCAL);
    return { remoteAccess: now.on };
  } catch {
    return { remoteAccess: true };
  }
}

export type Announcement =
  | { kind: "card"; release: Release; seen: string }
  | { kind: "highlights"; highlights: Highlight[]; seen: string };

/// Asks the feed once and answers what is worth announcing, with the version
/// to record once the reader has dealt with it. With nothing to show, that is
/// recorded here. Every failure is silence: a changelog that cannot be reached
/// is not news.
export async function checkChangelog(): Promise<Announcement | null> {
  const channel = readLocalStorage<UpdateChannel>("ade.updateChannel", "stable");
  const all = forChannel(await fetchChangelog(), channel);
  const seen = readLocalStorage<string | null>(SEEN_KEY, null);
  const facts = needsFacts(all) ? await readFacts() : NO_FACTS;
  const next = announcement(all, APP_VERSION, seen, facts);
  if (next.seen && next.highlights.length)
    return { kind: "highlights", highlights: next.highlights, seen: next.seen };
  if (next.seen && next.release) return { kind: "card", release: next.release, seen: next.seen };
  if (next.seen !== seen) writeLocalStorage(SEEN_KEY, next.seen);
  return null;
}

/// Recorded on dismissal rather than on showing, so a reader who quits without
/// touching the card or dialog gets it again next launch.
export function markChangelogSeen(version: string) {
  writeLocalStorage(SEEN_KEY, version);
}
