import { HAS_DICTATION, IS_LINUX, IS_MAC } from "@/lib/platform";

/// Every Settings tab, in sidebar order. Its own module so `App`, which loads
/// the Settings page lazily, can name a tab without pulling the page in.
export const ALL_SETTINGS_TABS = [
  "appearance",
  "spaces",
  "servers",
  "accounts",
  "transcription",
  "integrations",
  "shortcuts",
  "island",
  "composer",
  "breaks",
  "changelog",
  "about",
] as const;

export type SettingsTab = (typeof ALL_SETTINGS_TABS)[number];

/// Dray Island runs on a Mac and on Linux, so elsewhere its tab would be a page
/// of controls for nothing.
export const SETTINGS_TABS: readonly SettingsTab[] = ALL_SETTINGS_TABS.filter(
  (t) => (IS_MAC || IS_LINUX || t !== "island") && (HAS_DICTATION || t !== "transcription"),
);

/// A tab this platform's Settings shows, read off a string from outside.
export function isSettingsTab(id: string): id is SettingsTab {
  return (SETTINGS_TABS as readonly string[]).includes(id);
}
