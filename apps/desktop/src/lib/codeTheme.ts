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

import { DEFAULT_THEME, type ThemeName } from "@/lib/theme";

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
  | "night-owl"
  | "gruvbox"
  | "tokyo-night"
  | "solarized";

type CodeThemeEntry = {
  id: CodeThemeId;
  label: string;
  pair: CodeThemePair;
};

/// The pair used when the user hasn't chosen and the app theme has no syntax
/// counterpart. Pierre's own themes: they ship with the diff renderer and were drawn
/// for it, so the diff chrome and the syntax colors come from one hand.
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
    id: "night-owl",
    label: "Night Owl",
    pair: { light: "night-owl-light", dark: "night-owl" },
  },
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

/// What `auto` resolves to, per app theme. Three of the app's palettes are ports of
/// editor themes Shiki bundles too, so the code block is drawn in the same hand as the
/// chrome around it. An app theme absent here falls through to Pierre's, which is what
/// `default`'s own palette is drawn against.
///
/// **Cobalt2 is an approximation and the only one.** Shiki bundles no Cobalt2, and a
/// diff keeps its theme's `editor.background` (a markdown fence doesn't — App.css
/// forces that transparent), so the *background family* is what a mismatch shows
/// first. Night Owl is the one navy in the bundle; its accents are purple and peach
/// where Cobalt2's are yellow and cyan, so this matches the page and not the syntax.
/// A true one means shipping the tmTheme through `registerCustomTheme`, which the
/// diff **worker** has no path for — so diffs would fall back while fences didn't.
const AUTO_THEMES: Partial<Record<ThemeName, CodeThemeId>> = {
  catppuccin: "catppuccin",
  gruvbox: "gruvbox",
  "one-dark-pro": "one",
  cobalt2: "night-owl",
};

/// The pair for an id, falling back to the default for an id from a newer build
/// or a hand-edited store.
///
/// `appTheme` is here for `auto` alone, which means "match the app theme" and so
/// cannot be answered without it. It defaults so a caller with no theme to hand — a
/// test, a preview swatch — still gets the shipped default rather than nothing.
export function codeThemePair(
  id: CodeThemeId,
  appTheme: ThemeName = DEFAULT_THEME,
): CodeThemePair {
  const resolved = id === "auto" ? (AUTO_THEMES[appTheme] ?? "pierre") : id;
  return CODE_THEMES.find((t) => t.id === resolved)?.pair ?? DEFAULT_PAIR;
}
