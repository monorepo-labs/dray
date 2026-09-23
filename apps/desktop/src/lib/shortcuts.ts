import { IS_MAC } from "@/lib/platform";

/// One key combination, as `useHotkey` matches it.
///
/// `meta` is the platform accelerator — ⌘ on macOS, Ctrl elsewhere — and
/// `code` is the physical key accepted beside `key`, carried only where the
/// character moves under a modifier (see `useHotkey`'s own note on it).
export type Chord = {
  key: string;
  meta: boolean;
  shift: boolean;
  alt: boolean;
  code?: string;
};

export type ShortcutGroup = "General" | "Sessions" | "Panels and views" | "Composer" | "Notifications";

/// The one pair allowed to ship the same default chord, and why.
///
/// `issues.search` lives on the issues page and `composer.fast` on the composer,
/// and the two are never on screen together — the page replaces the main column
/// and every composer control with it. Both bindings are gated accordingly, and
/// `useHotkey` claims a chord only while its binding is enabled, which is the
/// whole reason [`IssuesView`] releases ⌘⇧F when the page is closed rather than
/// leaving it bound and eating the key from whatever *is* on screen.
///
/// It is a list of pairs rather than a flag on the entry so that adding one is
/// a deliberate act naming both sides: a `sharesChord: true` on a single row
/// would let the next collision in silently.
///
/// [`IssuesView`]: ../components/IssuesView.tsx
export const SHARED_CHORDS: [string, string][] = [["issues.search", "composer.fast"]];

/// Whether these two ids are the documented exception above.
export function mayShareChord(a: string, b: string): boolean {
  return SHARED_CHORDS.some(
    ([one, two]) => (one === a && two === b) || (one === b && two === a),
  );
}

/// Every chord the app binds, in one place.
///
/// The id is what a `useHotkey` call names and what an override is stored
/// under, so renaming one orphans the reader's rebinding of it. The default is
/// the chord as it shipped before rebinding existed; each carries the reason it
/// is shaped that way at its call site, not here.
///
/// Two ids sharing a default is refused by test: overlapping chords fire both
/// handlers where both are enabled, which is the collision the settings tab
/// exists to prevent. One shortcut bound from two components under different
/// `enabled` gates is one *id* (`subtab.prev`), not two — and where two genuinely
/// different actions can never be on screen together, [`SHARED_CHORDS`] is where
/// that is written down and the test reads it.
export const SHORTCUTS = [
  { id: "session.new", label: "New task", group: "Sessions", chord: k("n") },
  { id: "session.prev", label: "Previous session", group: "Sessions", chord: k("ArrowUp", { shift: true }) },
  { id: "session.next", label: "Next session", group: "Sessions", chord: k("ArrowDown", { shift: true }) },
  { id: "group.prev", label: "Previous project", group: "Sessions", chord: k("ArrowUp", { alt: true }) },
  { id: "group.next", label: "Next project", group: "Sessions", chord: k("ArrowDown", { alt: true }) },
  { id: "filter.prev", label: "Previous project filter", group: "Sessions", chord: k("ArrowLeft", { alt: true }) },
  { id: "filter.next", label: "Next project filter", group: "Sessions", chord: k("ArrowRight", { alt: true }) },
  { id: "search", label: "Search sessions", group: "Sessions", chord: k("f") },
  { id: "pane.1", label: "Focus pane 1", group: "Sessions", chord: k("1", { alt: true, code: "Digit1" }) },
  { id: "pane.2", label: "Focus pane 2", group: "Sessions", chord: k("2", { alt: true, code: "Digit2" }) },
  { id: "pane.3", label: "Focus pane 3", group: "Sessions", chord: k("3", { alt: true, code: "Digit3" }) },
  { id: "pane.4", label: "Focus pane 4", group: "Sessions", chord: k("4", { alt: true, code: "Digit4" }) },
  { id: "pane.5", label: "Focus pane 5", group: "Sessions", chord: k("5", { alt: true, code: "Digit5" }) },
  { id: "pane.6", label: "Focus pane 6", group: "Sessions", chord: k("6", { alt: true, code: "Digit6" }) },
  { id: "pane.7", label: "Focus pane 7", group: "Sessions", chord: k("7", { alt: true, code: "Digit7" }) },
  { id: "pane.8", label: "Focus pane 8", group: "Sessions", chord: k("8", { alt: true, code: "Digit8" }) },
  { id: "pane.9", label: "Focus pane 9", group: "Sessions", chord: k("9", { alt: true, code: "Digit9" }) },
  { id: "tab.close", label: "Close tab or pane", group: "Sessions", chord: k("w") },

  { id: "sidebar.toggle", label: "Toggle sidebar", group: "Panels and views", chord: k("b") },
  { id: "panel.toggle", label: "Toggle right panel", group: "Panels and views", chord: k("e") },
  // The only way to the crew. It has no button anywhere, deliberately — the
  // column is a fixed 320px and a permanent control for it would be chrome in
  // the titlebar for a thing most conversations never have. ⌘⇧C is free of ⌘C,
  // which `sameChord` compares Shift for, so copy is untouched.
  { id: "crew.toggle", label: "Toggle crew", group: "Panels and views", chord: k("c", { shift: true }) },
  { id: "panel.tab.prev", label: "Previous panel tab", group: "Panels and views", chord: k("{", { shift: true, code: "BracketLeft" }) },
  { id: "panel.tab.next", label: "Next panel tab", group: "Panels and views", chord: k("}", { shift: true, code: "BracketRight" }) },
  { id: "panel.refresh", label: "Refresh panel", group: "Panels and views", chord: k("r") },
  { id: "doc.save", label: "Save doc", group: "Panels and views", chord: k("s") },
  { id: "subtab.prev", label: "Previous tab in the view or panel", group: "Panels and views", chord: k("ArrowLeft", { shift: true }) },
  { id: "subtab.next", label: "Next tab in the view or panel", group: "Panels and views", chord: k("ArrowRight", { shift: true }) },
  { id: "view.chat", label: "Chat view", group: "Panels and views", chord: k("1") },
  { id: "view.browser", label: "Browser view", group: "Panels and views", chord: k("2") },
  { id: "view.changes", label: "Changes view", group: "Panels and views", chord: k("3") },
  { id: "view.files", label: "Files view", group: "Panels and views", chord: k("4") },
  { id: "chat.bottom", label: "Scroll chat to bottom", group: "Panels and views", chord: k("ArrowDown") },
  { id: "issues.open", label: "Open issues", group: "Panels and views", chord: k("i") },
  { id: "issues.search", label: "Search issues", group: "Panels and views", chord: k("f", { shift: true }) },

  { id: "dictate", label: "Dictate", group: "Composer", chord: k("d") },
  { id: "attach", label: "Attach files", group: "Composer", chord: k("o", { alt: true }) },
  { id: "model.next", label: "Next model", group: "Composer", chord: k("Tab", { meta: false, shift: true }) },
  { id: "effort.next", label: "Next effort level", group: "Composer", chord: k("e", { shift: true }) },
  { id: "composer.fast", label: "Toggle fast mode", group: "Composer", chord: k("f", { shift: true }) },
  { id: "harness.next", label: "Next agent", group: "Composer", chord: k("a", { shift: true }) },
  { id: "worktree.toggle", label: "Toggle worktree", group: "Composer", chord: k("t", { shift: true }) },
  { id: "project.next", label: "Next project in picker", group: "Composer", chord: k("p", { shift: true }) },
  { id: "queue.send", label: "Send queued prompts now", group: "Composer", chord: k("Enter") },

  { id: "notice.take", label: "Open the notification", group: "Notifications", chord: k("g") },
  { id: "notice.delete", label: "Delete worktree from notification", group: "Notifications", chord: k("d", { shift: true }) },

  { id: "settings", label: "Settings", group: "General", chord: k(",") },
] as const satisfies readonly { id: string; label: string; group: ShortcutGroup; chord: Chord }[];

export type ShortcutId = (typeof SHORTCUTS)[number]["id"];

/// Defaults a later build moved, and what they were.
///
/// Only a rebinding is stored, so moving a default is invisible to a reader who
/// never touched the row — and a collision for one who did: a chord they bound
/// somewhere while it was free can become another row's new default, and both
/// would fire on one press. The row whose default moved is the one that yields,
/// back to the chord it had before the update, since the reader chose theirs
/// and only this build chose the other. See `yieldMovedDefaults`.
///
/// The views and the panes traded places: ⌘ digits were the panes' and ⌘⌥
/// digits the views'.
export const PREVIOUS_DEFAULTS: Partial<Record<ShortcutId, Chord>> = {
  ...Object.fromEntries(
    [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => [`pane.${n}`, k(String(n))]),
  ),
  "view.chat": k("1", { alt: true, code: "Digit1" }),
  "view.browser": k("2", { alt: true, code: "Digit2" }),
  "view.changes": k("3", { alt: true, code: "Digit3" }),
  "view.files": k("4", { alt: true, code: "Digit4" }),
};

export const SHORTCUT_GROUPS: ShortcutGroup[] = [
  "General",
  "Sessions",
  "Panels and views",
  "Composer",
  "Notifications",
];

function k(key: string, opts: Partial<Omit<Chord, "key">> = {}): Chord {
  return { key, meta: true, shift: false, alt: false, ...opts };
}

export function defaultChord(id: ShortcutId): Chord {
  return SHORTCUTS.find((s) => s.id === id)!.chord;
}

export function shortcutLabel(id: ShortcutId): string {
  return SHORTCUTS.find((s) => s.id === id)!.label;
}

/// Chords the platform already means something by, which the recorder refuses.
///
/// ⌘Q reaches the menu bar before the webview, so a shortcut bound to it would
/// never fire. The editing set — select all, cut, copy, paste, undo, redo — is
/// what every text field expects, and `useHotkey` claims a chord it matches, so
/// binding one takes it out of the composer. Plain ⌘ only, apart from redo.
///
/// **⌘W is not reserved**, though it is close-window in every other Mac app:
/// this one has a single window and quitting is confirmed, so the Close Window
/// item is left out of the menu (see `quit.rs`) and the key is the app's to
/// spend on closing a tab or a pane.
const RESERVED: Chord[] = [
  k("q"),
  k("a"),
  k("x"),
  k("c"),
  k("v"),
  k("z"),
  k("z", { shift: true }),
];

export function isReserved(chord: Chord): boolean {
  return RESERVED.some((r) => sameChord(r, chord));
}

/// Two chords the matcher would treat as one. `code` is not compared: it is a
/// second spelling of `key`, and a chord recorded on a layout where the
/// character differs still lands on the same physical key.
export function sameChord(a: Chord, b: Chord): boolean {
  return (
    a.key.toLowerCase() === b.key.toLowerCase() &&
    a.meta === b.meta &&
    a.shift === b.shift &&
    a.alt === b.alt
  );
}

/// The chord a keystroke asks for, or `null` for one that cannot be a chord.
///
/// A bare printable key, shifted or not, is refused: the recorder is a button
/// and typing `a` into it must not bind `a`. Keys that are not characters —
/// Tab, arrows, Enter — take Shift as a modifier, which is how Shift+Tab stays
/// bindable while a bare Tab, which every field needs, does not. A modifier
/// pressed alone is nothing yet.
///
/// `code` rides along under the same two conditions the defaults use it for:
/// Option, which rewrites `key` on macOS, and a shifted punctuation key, whose
/// character depends on the layout.
export function chordFromKey(e: {
  key: string;
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}): Chord | null {
  if (["Meta", "Control", "Alt", "Shift", "Escape"].includes(e.key)) return null;
  const meta = e.metaKey || e.ctrlKey;
  const alt = e.altKey;
  const shift = e.shiftKey;
  let key = e.key;
  let code: string | undefined;
  const byCode = /^(?:Key|Digit)(\w)$/.exec(e.code);
  if (alt && byCode) {
    key = byCode[1].toLowerCase();
    code = e.code;
  } else if (shift && key.length === 1 && !/[a-z0-9]/i.test(key)) {
    code = e.code;
  }
  if (key.length === 1) {
    if (!meta && !alt) return null;
    key = key.toLowerCase();
  } else if (!meta && !alt && !shift) {
    return null;
  }
  return code ? { key, meta, shift, alt, code } : { key, meta, shift, alt };
}

const KEY_LABELS: Record<string, string> = {
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
  Enter: "⏎",
  Escape: "Esc",
  " ": "Space",
  Backspace: "⌫",
  Delete: "⌦",
};

const CODE_LABELS: Record<string, string> = {
  BracketLeft: "[",
  BracketRight: "]",
};

/// The key's own cap, with the modifiers left off.
export function keyLabel(chord: Chord): string {
  if (chord.code && CODE_LABELS[chord.code]) return CODE_LABELS[chord.code];
  if (KEY_LABELS[chord.key]) return KEY_LABELS[chord.key];
  return chord.key.length === 1 ? chord.key.toUpperCase() : chord.key;
}

/// The modifier caps, in the order the app has always drawn them.
///
/// Shift is spelled out rather than ⇧: beside an arrow the glyph reads as a
/// third arrow, and beside a letter as part of it.
export function modifierLabels(chord: Chord): string[] {
  const caps: string[] = [];
  if (chord.meta) caps.push(IS_MAC ? "⌘" : "Ctrl");
  if (chord.alt) caps.push(IS_MAC ? "⌥" : "Alt");
  if (chord.shift) caps.push("Shift");
  return caps;
}

export function formatChord(chord: Chord): string[] {
  return [...modifierLabels(chord), keyLabel(chord)];
}

/// One row of caps for several chords: where they share modifiers the keys
/// fold into one cap (`⌘ Shift ↑↓`), and where they don't each is drawn whole.
export function formatChords(chords: Chord[]): string[][] {
  if (chords.length === 0) return [];
  const mods = modifierLabels(chords[0]);
  const shared = chords.every((c) => modifierLabels(c).join() === mods.join());
  if (shared) return [[...mods, chords.map(keyLabel).join("")]];
  return chords.map(formatChord);
}
