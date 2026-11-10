/// Whether to draw ⌘ or Ctrl in a shortcut hint.
///
/// Rendered rather than detected per-keystroke: [useHotkey](../hooks/useHotkey.ts)
/// accepts either modifier, so this only decides which symbol a tooltip shows.
export const IS_MAC =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

export const IS_LINUX =
  typeof navigator !== "undefined" && /Linux/.test(navigator.platform);

/// Dictation runs on the machine the reader sits at, so a Mac and a Linux
/// desktop have it and nothing else does: elsewhere its button, chord and tab
/// are not drawn.
export const HAS_DICTATION = IS_MAC || IS_LINUX;
