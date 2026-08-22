/// Whether to draw ⌘ or Ctrl in a shortcut hint.
///
/// Rendered rather than detected per-keystroke: [useHotkey](../hooks/useHotkey.ts)
/// accepts either modifier, so this only decides which symbol a tooltip shows.
export const IS_MAC =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
