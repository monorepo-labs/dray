/// Theme state lives on `<html>` as `data-theme` (palette) × `data-mode` (light/dark),
/// mirrored to localStorage. The two axes are independent so a palette doesn't have to
/// know which mode it renders in. Only dark neutral is implemented; the rest of the
/// machinery is here so adding one is a CSS block plus an entry in `THEMES`.

export type ThemeName = "neutral";
export type ThemeMode = "light" | "dark" | "system";

/// Resolved mode — what actually lands on `data-mode`. `system` never does.
export type ResolvedMode = "light" | "dark";

export const THEMES: { id: ThemeName; label: string }[] = [
  { id: "neutral", label: "Neutral" },
];

export const DEFAULT_THEME: ThemeName = "neutral";
export const DEFAULT_MODE: ThemeMode = "dark";

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
    const name = localStorage.getItem(THEME_KEY);
    const mode = localStorage.getItem(MODE_KEY);
    return {
      name: THEMES.some((t) => t.id === name) ? (name as ThemeName) : DEFAULT_THEME,
      mode:
        mode === "light" || mode === "dark" || mode === "system" ? mode : DEFAULT_MODE,
    };
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
