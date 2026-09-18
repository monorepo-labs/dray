import { createContext, useContext, type ReactNode } from "react";
import { createPortal } from "react-dom";

/// The node a tab hangs a control on when that control belongs beside the
/// dialog's title rather than inside its scrolling body. Rendered by
/// `SettingsTabs`, which owns where it sits.
export const SettingsHeaderSlot = createContext<HTMLElement | null>(null);

/// Draws its children up in the dialog's header strip.
///
/// A portal rather than a prop on `SettingsTabs`, because the state behind such
/// a control lives in the tab's own component — Accounts' Refresh is its hook's
/// `refresh` and `busy` — and lifting that to the dialog would spawn four child
/// processes on every settings open whichever tab the reader wanted. The
/// dialog switches bodies rather than hiding them, so a tab off screen is
/// unmounted and its action leaves the strip with it.
export default function SettingsHeaderAction({ children }: { children: ReactNode }) {
  const slot = useContext(SettingsHeaderSlot);
  return slot ? createPortal(children, slot) : null;
}
