/// Whether to draw ⌘ or Ctrl in a shortcut hint.
///
/// Rendered rather than detected per-keystroke: [useHotkey](../hooks/useHotkey.ts)
/// accepts either modifier, so this only decides which symbol a tooltip shows.
export const IS_MAC =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

export const IS_LINUX =
  typeof navigator !== "undefined" && /Linux/.test(navigator.platform);

export const IS_WINDOWS =
  typeof navigator !== "undefined" && /Win/.test(navigator.platform);

/// Dictation runs on the machine the reader sits at, so a Mac, a Linux and a
/// Windows desktop have it and nothing else does: elsewhere its button, chord
/// and tab are not drawn.
export const HAS_DICTATION = IS_MAC || IS_LINUX || IS_WINDOWS;

/// Whether a browser page can be split out beside the chat. Every tab is a
/// native view of its own on a Mac and on Windows; on Linux every tab lives
/// in the one X11 frame the pane keeps, so a page stays in the main view.
export const SPLITS_PAGES = IS_MAC || IS_WINDOWS;

/// What copy calls the machine the app runs on: "this Mac" on a Mac, "this
/// machine" anywhere else. One noun, so every sentence reads the same per platform.
export const MACHINE = IS_MAC ? "Mac" : "machine";

/// A click or key with ⌘ held, or Ctrl off a Mac — the app's one modifier.
export function isModClick(e: { metaKey: boolean; ctrlKey: boolean }): boolean {
  return IS_MAC ? e.metaKey : e.metaKey || e.ctrlKey;
}
