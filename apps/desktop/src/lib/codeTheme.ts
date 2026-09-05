/// Syntax-highlighting theme for the two code surfaces — diffs and markdown code
/// blocks. Separate from `lib/theme.ts`, which owns the app's own palette: this
/// picks the colors *inside* a code block, that one picks the chrome around it.
///
/// A choice is a light/dark pair, not a single theme, because the app's mode can
/// change under it (`system` follows the OS) and a dark syntax theme on a light
/// page is unreadable. The user picks one entry; the resolved mode picks a side.

// Via streamdown, which re-exports it: `shiki` is a transitive dependency here
// and pnpm doesn't hoist it, so importing the name directly doesn't resolve.
import type { BundledTheme } from "streamdown";

/// `@pierre/theming` registers these alongside Shiki's bundled set, so the
/// shared highlighter resolves them by name like any other — but they are
/// absent from `BundledTheme`, which only covers what Shiki itself ships.
type PierreTheme = "pierre-dark" | "pierre-light";

/// A theme id the shared highlighter can resolve. Keeping this a union rather
/// than `string` means a typo in the table below is a build error instead of a
/// theme that silently fails to load at runtime.
type ShikiThemeName = BundledTheme | PierreTheme;

export type CodeThemePair = { light: ShikiThemeName; dark: ShikiThemeName };

export type CodeThemeId =
  | "auto"
  | "pierre"
  | "github"
  | "vitesse"
  | "one"
  | "material"
  | "rose-pine"
  | "catppuccin"
  | "nord"
  | "gruvbox"
  | "tokyo-night"
  | "solarized";

type CodeThemeEntry = {
  id: CodeThemeId;
  label: string;
  pair: CodeThemePair;
};

/// The pair used when the user hasn't chosen, and the one `auto` resolves to.
/// Pierre's own themes: they ship with the diff renderer and were drawn for it,
/// so the diff chrome and the syntax colors come from one hand.
const DEFAULT_PAIR: CodeThemePair = { light: "pierre-light", dark: "pierre-dark" };

/// The picker's contents. Every entry is a real light/dark pair — a theme with
/// no counterpart in the other mode would leave one mode unreadable, so
/// single-mode themes are deliberately absent.
export const CODE_THEMES: CodeThemeEntry[] = [
  { id: "auto", label: "Match app theme", pair: DEFAULT_PAIR },
  { id: "pierre", label: "Pierre", pair: DEFAULT_PAIR },
  { id: "github", label: "GitHub", pair: { light: "github-light", dark: "github-dark" } },
  { id: "vitesse", label: "Vitesse", pair: { light: "vitesse-light", dark: "vitesse-dark" } },
  { id: "one", label: "One", pair: { light: "one-light", dark: "one-dark-pro" } },
  {
    id: "material",
    label: "Material",
    pair: { light: "material-theme-lighter", dark: "material-theme-palenight" },
  },
  {
    id: "rose-pine",
    label: "Rosé Pine",
    pair: { light: "rose-pine-dawn", dark: "rose-pine-moon" },
  },
  {
    id: "catppuccin",
    label: "Catppuccin",
    pair: { light: "catppuccin-latte", dark: "catppuccin-mocha" },
  },
  // Nord is a dark-only palette; `nord` on a light page is the closest thing it
  // has to a light mode, so pair it with a neutral rather than inventing one.
  { id: "nord", label: "Nord", pair: { light: "min-light", dark: "nord" } },
  {
    id: "gruvbox",
    label: "Gruvbox",
    pair: { light: "gruvbox-light-medium", dark: "gruvbox-dark-medium" },
  },
  { id: "tokyo-night", label: "Tokyo Night", pair: { light: "min-light", dark: "tokyo-night" } },
  {
    id: "solarized",
    label: "Solarized",
    pair: { light: "solarized-light", dark: "solarized-dark" },
  },
];

export const DEFAULT_CODE_THEME: CodeThemeId = "auto";

/// The pair for an id, falling back to the default for an id from a newer build
/// or a hand-edited store.
export function codeThemePair(id: CodeThemeId): CodeThemePair {
  return CODE_THEMES.find((t) => t.id === id)?.pair ?? DEFAULT_PAIR;
}
