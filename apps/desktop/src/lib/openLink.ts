import { openUrl } from "@tauri-apps/plugin-opener";
import { useSyncExternalStore } from "react";

import { channel } from "@/lib/channel";

type Opener = (url: string, opts: { external: boolean }) => void;

/// Where a link in the transcript goes. `App` installs one that opens the
/// selected session's browser; until then, and with no session to open one
/// for, the system browser. A module slot rather than a prop, since the anchor
/// is rendered by Streamdown several components below anything that knows
/// which session is selected.
let opener: Opener = (url) => void openUrl(url).catch(console.error);

export function setLinkOpener(fn: Opener | null) {
  opener = fn ?? ((url) => void openUrl(url).catch(console.error));
}

/// The link waiting on the reader's answer in `LinkDialog`, or `null`.
let pending: string | null = null;
const changed = channel<void>();

function set(url: string | null) {
  pending = url;
  changed.emit();
}

export function usePendingLink(): string | null {
  return useSyncExternalStore(changed.subscribe, () => pending);
}

/// A click on a link asks first — in Dray or outside — since the two mean
/// different things and a click cannot say which. ⌘-click (Ctrl elsewhere)
/// skips the question and leaves the app, the way it means "not here" in
/// every browser's own tab strip.
export function openLink(url: string, event?: { metaKey: boolean; ctrlKey: boolean }) {
  if (event?.metaKey || event?.ctrlKey) {
    opener(url, { external: true });
    return;
  }
  set(url);
}

/// The dialog's answer.
export function resolveLink(external: boolean) {
  const url = pending;
  set(null);
  if (url) opener(url, { external });
}

export function dismissLink() {
  set(null);
}
