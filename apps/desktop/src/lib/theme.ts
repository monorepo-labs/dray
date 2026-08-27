/// Appearance state lives on `<html>` as attributes, mirrored to localStorage and
/// stamped before first paint by the script in index.html: `data-theme` (palette) ×
/// `data-mode` (light/dark), plus `data-transparency` and `data-vibrancy`, which
/// [useGlass](../hooks/useGlass.ts) owns from mount on and derives from the theme —
/// neither is a preference and neither is stored.
///
/// A theme carries its own background, so there is no second axis for it. That was
/// tried: a backdrop the reader picked apart from the palette could not reach
/// `--composer`, which has to stay an opaque fill, and a grey composer on a tinted
/// page is what a second axis buys.

export type ThemeName = "default" | "catppuccin" | "gruvbox";
export type ThemeMode = "light" | "dark" | "system";

/// Resolved mode — what actually lands on `data-mode`. `system` never does.
export type ResolvedMode = "light" | "dark";

/// Two fields, and both are *opt-outs* — a theme added later gets the good
/// behaviour by saying nothing.
///
/// `flatInFullscreen`: a theme keeps its layering when there is nothing behind the
/// window unless it says otherwise. Default is the exception because its backdrop is
/// a flat near-black, so in fullscreen its veils have nothing to sit on and only cost
/// contrast. This was a switch in Settings for about an hour; it asked the reader a
/// question that belongs to the theme, in a dialog, about a state they were not in.
///
/// `darkOnly`: a theme has both palettes unless it says otherwise. Only Default sets
/// it, and only because its light side is unbuilt rather than unwanted — so the row
/// in Settings is disabled and says so, rather than hidden. A light palette is a
/// second full ramp, not an inversion, which is why it is not free.
export type Theme = {
  id: ThemeName;
  label: string;
  flatInFullscreen?: boolean;
  darkOnly?: boolean;
  /// Whose palette this is, for the credit in the README and nothing else.
  credit?: { name: string; url: string };
};

export const THEMES: Theme[] = [
  { id: "default", label: "Default", flatInFullscreen: true, darkOnly: true },
  {
    id: "catppuccin",
    label: "Catppuccin",
    credit: { name: "Catppuccin", url: "https://github.com/catppuccin/catppuccin" },
  },
  {
    id: "gruvbox",
    label: "Gruvbox",
    credit: { name: "gruvbox", url: "https://github.com/morhetz/gruvbox" },
  },
];

export const DEFAULT_THEME: ThemeName = "default";
export const DEFAULT_MODE: ThemeMode = "dark";

function theme(name: ThemeName): Theme | undefined {
  return THEMES.find((t) => t.id === name);
}

/// Whether the app stays layered once there is nothing behind the window.
///
/// Two ways to answer no, and the mode is the blunter one. **Light is always flat in
/// fullscreen**, whatever the theme: a light palette's veil is *black*, and windowed
/// that reads as depth because the desktop is genuinely showing through it. Fullscreen
/// there is nothing behind, so the same veil is a grey smudge on a light page — and a
/// light palette has far less room below its page colour than a dark one has above
/// its own, so the smudge is all it can be.
///
/// `flatInFullscreen` is the per-theme half, for a dark palette whose backdrop is not
/// worth layering over. Both are facts about the palette rather than tastes about the
/// window, which is why neither is a setting.
export function keepsGlassInFullscreen(name: ThemeName, mode: ResolvedMode): boolean {
  if (mode === "light") return false;
  return !theme(name)?.flatInFullscreen;
}

/// Whether this theme has a light palette to switch to.
export function hasLightMode(name: ThemeName): boolean {
  return !theme(name)?.darkOnly;
}

/// The mode this theme can actually render, given the one asked for.
///
/// The guard that matters: picking a dark-only theme while in light mode has to force
/// dark, or `[data-theme="default"][data-mode="light"]` matches no block and the app
/// falls through to the light ramp's own neutral values — legible, but not the theme
/// anyone chose, and nothing on screen would say why. Applied on every write and on
/// the first read, so a store carrying that pair from an older build heals itself.
export function modeFor(name: ThemeName, mode: ThemeMode): ThemeMode {
  return hasLightMode(name) ? mode : "dark";
}

// Shared with the pre-paint script in index.html. Changing either key means
// changing it there too, or the script and this module disagree for one frame.
const THEME_KEY = "ade.theme";
const MODE_KEY = "ade.mode";

const DARK_QUERY = "(prefers-color-scheme: dark)";

/// Whether the OS currently prefers dark. Falsy in any environment without matchMedia.
export function systemPrefersDark(): boolean {
  return typeof window !== "undefined" && window.matchMedia(DARK_QUERY).matches;
}

export function resolveMode(mode: ThemeMode): ResolvedMode {
  if (mode === "system") return systemPrefersDark() ? "dark" : "light";
  return mode;
}

/// Narrows whatever is in the store to a theme we actually ship. Split from the read
/// so the rule is testable without a `localStorage` to write into.
///
/// A name we have dropped falls back rather than failing, which is also the whole of
/// the `neutral` → `shadcn` rename: a store still holding the old id lands on the
/// default, and the default is the same palette under its new name.
export function coerceTheme(raw: string | null): ThemeName {
  return THEMES.some((t) => t.id === raw) ? (raw as ThemeName) : DEFAULT_THEME;
}

/// Stamps the document and persists the choice. The `.dark` class is set alongside
/// `data-mode` because shadcn primitives and Streamdown both style through `dark:`
/// variants — dropping it would leave them light against a dark palette.
export function applyTheme(name: ThemeName, mode: ThemeMode): ResolvedMode {
  const resolved = resolveMode(mode);
  const el = document.documentElement;

  el.dataset.theme = name;
  el.dataset.mode = resolved;
  el.classList.toggle("dark", resolved === "dark");
  // Lets the webview render form controls and scrollbars to match.
  el.style.colorScheme = resolved;

  try {
    localStorage.setItem(THEME_KEY, name);
    localStorage.setItem(MODE_KEY, mode);
  } catch {
    // A full or disabled store shouldn't cost the user their theme this session.
  }

  return resolved;
}

export function readStoredTheme(): { name: ThemeName; mode: ThemeMode } {
  try {
    const stored = localStorage.getItem(MODE_KEY);
    const name = coerceTheme(localStorage.getItem(THEME_KEY));
    const mode =
      stored === "light" || stored === "dark" || stored === "system"
        ? stored
        : DEFAULT_MODE;
    return { name, mode: modeFor(name, mode) };
  } catch {
    return { name: DEFAULT_THEME, mode: DEFAULT_MODE };
  }
}

/// Subscribes to OS appearance changes. Callers only care while mode is `system`.
export function watchSystemMode(onChange: (dark: boolean) => void): () => void {
  if (typeof window === "undefined") return () => {};
  const mq = window.matchMedia(DARK_QUERY);
  const handler = (e: MediaQueryListEvent) => onChange(e.matches);
  mq.addEventListener("change", handler);
  return () => mq.removeEventListener("change", handler);
}
