import { useEffect, useRef } from "react";

import { useChord } from "@/hooks/useShortcuts";
import { IS_MAC } from "@/lib/platform";
import type { ShortcutId } from "@/lib/shortcuts";

type HotkeyOptions = {
  /// False unregisters the listener outright rather than making the handler a
  /// no-op. The difference is `preventDefault`: this claims every chord it
  /// matches, so a binding left registered while its view is hidden would eat
  /// the key from whatever *is* on screen — ⌘⇧← is select-to-line-start in the
  /// composer.
  enabled?: boolean;
  /// Give the chord up while a text field has focus, rather than claiming it.
  ///
  /// For a chord the platform already assigns inside text — ⌘⇧← is
  /// select-to-line-start — where `enabled` cannot express the rule: the view
  /// binding it is on screen, and so is the field. Checked at the keystroke,
  /// where what has focus is knowable, and **before** `preventDefault`, since
  /// claiming the chord is the whole of the harm.
  skipInTextField?: boolean;
  /// Take **only** this platform's own accelerator, not either one.
  ///
  /// `meta` normally accepts Cmd or Ctrl without asking which platform it is
  /// on, which costs nothing for a chord no platform assigns — but Ctrl is a
  /// live modifier on macOS, where ⌃D is delete-forward in every text field.
  /// A binding that claims both takes that away for nothing, since a Mac user
  /// presses ⌘.
  platformOnly?: boolean;
};

/// Chords that still fire while the shell is suspended: they act on the app as
/// a whole, where everything else acts on a session, a view or the composer.
const APP_WIDE: ReadonlySet<ShortcutId> = new Set([
  "settings",
  "theme.next",
  "zoom.in",
  "zoom.out",
  "zoom.reset",
]);

let suspended = false;

/// Silences every shell chord but `APP_WIDE` while a full-window page covers
/// the shell. Settings hides `AppShell` rather than unmounting it, so its
/// bindings stay registered — and each one would claim its key (⇧Tab, ⌘I) and
/// act on a session the reader cannot see. Read at the keystroke, so no
/// listener re-registers and a binding needs no `enabled` gate of its own.
export function setHotkeysSuspended(on: boolean) {
  suspended = on;
}

/// Stands in for a row the reader unbound. The empty key matches no keystroke,
/// and `useHotkey` registers no listener at all for it.
const UNBOUND = { key: "", meta: false, shift: false, alt: false, code: undefined };

/// Binds a document-level shortcut by id. The chord comes from the registry in
/// `lib/shortcuts.ts` through the reader's overrides, so a rebinding in
/// settings re-registers every listener that names the id. The handler is
/// held in a ref so passing a fresh closure each render doesn't re-register.
///
/// On the chord itself: `meta` is Cmd on macOS and Ctrl elsewhere; `code` is a
/// physical key accepted alongside `key`, for a chord whose character moves
/// under Shift — ⌘⇧[ arrives as `{`, and which of the two `key` carries is
/// the browser's call. Matching the character alone is one engine away from
/// silently never firing, and matching position alone would put the chord
/// under a different glyph on every non-US layout, so this takes both.
export function useHotkey(
  id: ShortcutId,
  handler: () => void,
  { enabled = true, platformOnly = false, skipInTextField = false }: HotkeyOptions = {},
) {
  // An unbound row answers no chord, and the listener is left unregistered for
  // the same reason `enabled: false` does: this claims every chord it matches,
  // so a binding standing on an empty key would still be a listener to run.
  const { key, meta, shift, alt, code } = useChord(id) ?? UNBOUND;
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    if (!enabled || !key) return;
    const onKeyDown = (e: KeyboardEvent) => {
      // Before matching, so a suspended chord is left to the page entirely.
      if (suspended && !APP_WIDE.has(id)) return;
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
      // `platformOnly` narrows that to this platform's own, for a chord whose
      // other spelling the OS has already assigned.
      if (meta && platformOnly && !(IS_MAC ? e.metaKey : e.ctrlKey)) return;
      if (meta && !platformOnly && !e.metaKey && !e.ctrlKey) return;
      if (!meta && (e.metaKey || e.ctrlKey)) return;
      if (e.shiftKey !== shift) return;
      // Exact, so ⌘⌥↑ can't also fire the plain ⌘ bindings.
      if (e.altKey !== alt) return;

      if (skipInTextField && isTextField(e.target)) return;

      // Claim the chord before the webview's default — Cmd+B is bold in a
      // contenteditable and would otherwise fire both.
      e.preventDefault();
      handlerRef.current();
    };

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [id, key, meta, shift, alt, code, enabled, platformOnly, skipInTextField]);
}

/// Somewhere a caret can be, and therefore somewhere the platform's own text
/// chords belong. `contentEditable` counts: the markdown a doc renders is not
/// one today, but nothing here should have to be re-read if it becomes one.
function isTextField(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLInputElement ||
    target.isContentEditable
  );
}
