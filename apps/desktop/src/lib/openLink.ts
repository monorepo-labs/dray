import { openUrl } from "@tauri-apps/plugin-opener";

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

/// ⌘-click (Ctrl elsewhere) means the system browser, the way it means "not
/// here" in every browser's own tab strip.
export function openLink(url: string, event?: { metaKey: boolean; ctrlKey: boolean }) {
  opener(url, { external: !!(event?.metaKey || event?.ctrlKey) });
}
