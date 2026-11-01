/// Whether to draw ⌘ or Ctrl in a shortcut hint.
///
/// Rendered rather than detected per-keystroke: [useHotkey](../hooks/useHotkey.ts)
/// accepts either modifier, so this only decides which symbol a tooltip shows.
export const IS_MAC =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

/// Dictation ships on the Mac alone for now — Linux waits on cloud
/// transcription (#706) — so elsewhere its button, chord and tab are not drawn.
export const HAS_DICTATION = IS_MAC;
