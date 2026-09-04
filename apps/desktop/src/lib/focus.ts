import { getCurrentWindow } from "@tauri-apps/api/window";

import { channel } from "@/lib/channel";

/// Whether the app window is frontmost. Read imperatively rather than as React
/// state: the one caller that matters is inside a Tauri event listener
/// registered once, where a state value would be the mount-time one forever.
///
/// The source is Tauri's own window event, not the DOM's `blur`. A webview
/// blurs whenever focus leaves the document — opening a native menu, clicking
/// into devtools — none of which means the user has left the app, and each
/// would fire a desktop notification at someone looking straight at the window.
/// The DOM pair is the fallback for `pnpm dev`, where there is no Tauri window.
let focused = document.hasFocus();

const changed = channel<boolean>();

function set(next: boolean) {
  if (next === focused) return;
  focused = next;
  changed.emit(next);
}

try {
  void getCurrentWindow()
    .onFocusChanged(({ payload }) => set(payload))
    .catch(useDomEvents);
} catch {
  // `getCurrentWindow` reads a global the plain browser doesn't have, so this
  // throws rather than rejecting under `pnpm dev`.
  useDomEvents();
}

function useDomEvents() {
  window.addEventListener("focus", () => set(true));
  window.addEventListener("blur", () => set(false));
}

/// True while the app window is frontmost.
export function isWindowFocused(): boolean {
  return focused;
}

/// Subscribe to focus changes; returns the unsubscribe.
export const onFocusChange = changed.subscribe;
