import { useEffect, useRef } from "react";

type HotkeyOptions = {
  /// Cmd on macOS, Ctrl elsewhere — the platform's own accelerator.
  meta?: boolean;
  shift?: boolean;
  /// Option on macOS, Alt elsewhere.
  alt?: boolean;
  /// A physical key accepted alongside `key`, for a chord whose character moves
  /// under Shift — ⌘⇧[ arrives as `{`, and which of the two `key` carries is
  /// the browser's call. Matching the character alone is one engine away from
  /// silently never firing, and matching position alone would put the chord
  /// under a different glyph on every non-US layout, so this takes both.
  code?: string;
};

/// Binds a document-level shortcut. The handler is held in a ref so passing a
/// fresh closure each render doesn't re-register the listener.
export function useHotkey(
  key: string,
  handler: () => void,
  { meta = true, shift = false, alt = false, code }: HotkeyOptions = {},
) {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // `code` is only consulted for an Option chord, and only for a letter.
      // macOS applies the Option layout to `key` — ⌥O can arrive as "ø" — so a
      // binding that reads `key` alone silently never fires. The narrowness is
      // the point: matching by physical position everywhere would fire ⌘B on
      // Dvorak's N key, so the fallback stays where the layout has already
      // broken the character.
      const matches =
        e.key.toLowerCase() === key.toLowerCase() ||
        (alt && key.length === 1 && e.code === `Key${key.toUpperCase()}`) ||
        (code !== undefined && e.code === code);
      if (!matches) return;
      // Accept either modifier rather than branching on platform: a Mac reports
      // metaKey, everything else ctrlKey, and neither fires the other's chord.
      if (meta && !e.metaKey && !e.ctrlKey) return;
      if (!meta && (e.metaKey || e.ctrlKey)) return;
      if (e.shiftKey !== shift) return;
      // Exact, so ⌘⌥↑ can't also fire the plain ⌘ bindings.
      if (e.altKey !== alt) return;

      // Claim the chord before the webview's default — Cmd+B is bold in a
      // contenteditable and would otherwise fire both.
      e.preventDefault();
      handlerRef.current();
    };

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [key, meta, shift, alt, code]);
}
