import { createContext, useContext, type ReactNode } from "react";
import { createPortal } from "react-dom";

/// The node a tab hangs a control on when that control belongs beside the
/// page's title rather than inside its scrolling body. Rendered by
/// `SettingsTabs`, which owns where it sits.
export const SettingsHeaderSlot = createContext<HTMLElement | null>(null);

/// Draws its children up in the page's heading row.
///
/// A portal rather than a prop on `SettingsTabs`, because the state behind such
/// a control lives in the tab's own component — Accounts' Refresh is its hook's
/// `refresh` and `busy` — and lifting that to the page would spawn four child
/// processes on every settings open whichever tab the reader wanted. The
/// page switches bodies rather than hiding them, so a tab off screen is
/// unmounted and its action leaves the heading with it.
export default function SettingsHeaderAction({ children }: { children: ReactNode }) {
  const slot = useContext(SettingsHeaderSlot);
  return slot ? createPortal(children, slot) : null;
}
