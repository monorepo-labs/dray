/// The text sizes the reader can set, in px.
///
/// Each slot is one of the semantic `text-*` utilities in App.css, which read
/// their size off an overridable `--fs-<slot>` on `<html>`; this is the only
/// thing that writes one. Composer and tool output are deliberately absent —
/// both keep the size App.css gives them, and `--fs-composer`/`--fs-tool` stay
/// as hooks nothing writes.
///
/// Defaults are the rem values in App.css at a 16px root, stated here in px
/// because px is the unit the reader sees. Stored as `ade.fontSizes`, and the
/// pre-paint script in index.html reads that key by hand — keep the two in step.
export const FONT_SLOTS = [
  { id: "ui", label: "Interface", px: 13 },
  { id: "chat", label: "Chat messages", px: 15 },
  { id: "code", label: "Code", px: 14 },
] as const;

export type FontSlot = (typeof FONT_SLOTS)[number]["id"];
export type FontSizes = Record<FontSlot, number>;

export const FONT_MIN = 10;
export const FONT_MAX = 24;
export const FONT_SIZES_KEY = "ade.fontSizes";

export const DEFAULT_FONT_SIZES: FontSizes = Object.fromEntries(
  FONT_SLOTS.map((s) => [s.id, s.px]),
) as FontSizes;

/// A stored value made safe: unknown keys dropped, non-numbers and anything
/// outside the range replaced by the default. Never throws, since it runs on
/// the launch path.
export function coerceFontSizes(raw: unknown): FontSizes {
  const out = { ...DEFAULT_FONT_SIZES };
  if (!raw || typeof raw !== "object") return out;
  for (const { id } of FONT_SLOTS) {
    const v = (raw as Record<string, unknown>)[id];
    if (typeof v === "number" && Number.isFinite(v)) out[id] = clampFontSize(v);
  }
  return out;
}

export function clampFontSize(px: number): number {
  return Math.min(FONT_MAX, Math.max(FONT_MIN, Math.round(px)));
}

export function isDefaultFontSizes(sizes: FontSizes): boolean {
  return FONT_SLOTS.every((s) => sizes[s.id] === s.px);
}

/// Writes each size onto `<html>`, removing the property where it is the
/// default so App.css's own fallback stays the source of truth there.
export function applyFontSizes(sizes: FontSizes, el: HTMLElement = document.documentElement) {
  for (const { id, px } of FONT_SLOTS) {
    if (sizes[id] === px) el.style.removeProperty(`--fs-${id}`);
    else el.style.setProperty(`--fs-${id}`, `${sizes[id]}px`);
  }
}
