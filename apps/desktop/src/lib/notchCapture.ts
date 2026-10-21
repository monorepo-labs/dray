import { modCaps, type Mods } from "@/lib/digitChords";

/// The notch's screenshot chord, as it rides `notch.captureKey`: a Carbon key
/// code and modifier mask, since the notch registers it with
/// `RegisterEventHotKey`, which speaks nothing else. `null` is no chord at all.
export type CaptureKey = { code: string; mods: Mods } | null;

export const DEFAULT_CAPTURE: CaptureKey = {
  code: "Digit2",
  mods: { meta: true, ctrl: false, alt: false, shift: true },
};

/// `KeyboardEvent.code` to Carbon's `kVK_*` and the cap it draws. Read off the
/// physical key, since ⌥ and ⇧ both rewrite `key`.
const KEYS: Record<string, [number, string]> = {
  KeyA: [0, "A"], KeyS: [1, "S"], KeyD: [2, "D"], KeyF: [3, "F"], KeyH: [4, "H"], KeyG: [5, "G"],
  KeyZ: [6, "Z"], KeyX: [7, "X"], KeyC: [8, "C"], KeyV: [9, "V"], KeyB: [11, "B"], KeyQ: [12, "Q"],
  KeyW: [13, "W"], KeyE: [14, "E"], KeyR: [15, "R"], KeyY: [16, "Y"], KeyT: [17, "T"], KeyO: [31, "O"],
  KeyU: [32, "U"], KeyI: [34, "I"], KeyP: [35, "P"], KeyL: [37, "L"], KeyJ: [38, "J"], KeyK: [40, "K"],
  KeyN: [45, "N"], KeyM: [46, "M"],
  Digit1: [18, "1"], Digit2: [19, "2"], Digit3: [20, "3"], Digit4: [21, "4"], Digit5: [23, "5"],
  Digit6: [22, "6"], Digit7: [26, "7"], Digit8: [28, "8"], Digit9: [25, "9"], Digit0: [29, "0"],
  Equal: [24, "="], Minus: [27, "-"], BracketRight: [30, "]"], BracketLeft: [33, "["], Quote: [39, "'"],
  Semicolon: [41, ";"], Backslash: [42, "\\"], Comma: [43, ","], Slash: [44, "/"], Period: [47, "."],
  Backquote: [50, "`"], Space: [49, "Space"],
  F1: [122, "F1"], F2: [120, "F2"], F3: [99, "F3"], F4: [118, "F4"], F5: [96, "F5"], F6: [97, "F6"],
  F7: [98, "F7"], F8: [100, "F8"], F9: [101, "F9"], F10: [109, "F10"], F11: [103, "F11"], F12: [111, "F12"],
};

/// Carbon's `cmdKey`, `shiftKey`, `optionKey`, `controlKey`.
const MASKS = { meta: 256, shift: 512, alt: 2048, ctrl: 4096 } as const;

export function encodeCapture(k: CaptureKey): string {
  if (!k) return "none";
  const mask = (Object.keys(MASKS) as (keyof Mods)[]).reduce((m, mod) => (k.mods[mod] ? m | MASKS[mod] : m), 0);
  return `${KEYS[k.code][0]} ${mask}`;
}

/// An absent or unreadable value is the default, which is what the notch does with it.
export function decodeCapture(value: string | undefined): CaptureKey {
  if (value === "none") return null;
  const [key, mask] = (value ?? "").split(" ").map(Number);
  const code = Object.keys(KEYS).find((c) => KEYS[c][0] === key);
  if (!code || !Number.isInteger(mask)) return DEFAULT_CAPTURE;
  const mods = { meta: !!(mask & MASKS.meta), ctrl: !!(mask & MASKS.ctrl), alt: !!(mask & MASKS.alt), shift: !!(mask & MASKS.shift) };
  return { code, mods };
}

export function captureCaps(k: NonNullable<CaptureKey>): string[] {
  return [...modCaps(k.mods), KEYS[k.code][1]];
}

/// The chord a keystroke spells, or why it cannot be one. It fires in every
/// app, so it must hold ⌘, ⌃ or ⌥: Shift alone would take a letter from
/// whatever is being typed.
export function captureFrom(e: { code: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }):
  | { key: NonNullable<CaptureKey> }
  | { refused: string } {
  if (!KEYS[e.code]) return { refused: "That key can't be a shortcut." };
  if (!e.metaKey && !e.ctrlKey && !e.altKey) return { refused: "Hold ⌘, ⌃ or ⌥." };
  const mods = { meta: e.metaKey, ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey };
  if (mods.meta && mods.shift && !mods.ctrl && !mods.alt && ["Digit3", "Digit4", "Digit5"].includes(e.code)) {
    return { refused: "macOS keeps ⌘ Shift 3, 4 and 5 for screenshots." };
  }
  return { key: { code: e.code, mods } };
}
