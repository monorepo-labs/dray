import type { ViewTab } from "@/components/layout/ViewTabs";

/// What arriving at or leaving a full-width view does to the right pane.
///
/// A pure function because the effect that holds it re-runs on state it only
/// *reads*, so the whole rule is which transition is which. It covers every view but Chat — Browser, Diff and Files all want the width —
/// so a move between two of them is neither arriving nor leaving, and a pane
/// opened beside one stays put. And the pane and the view tab are both per
/// session: selecting another session moves the view without the claimed
/// session ever leaving its page. So a claim is given back only once its own
/// key is on screen on Chat, and a hide fires only on a key that stayed put — a
/// session reached already on Diff, pane open, is the reader returning to it
/// rather than arriving.
export type SidebarMove = "hide" | "restore" | null;

export function panelMove({
  from,
  to,
  keyMoved,
  enabled,
  open,
  claimed,
}: {
  from: ViewTab;
  to: ViewTab;
  /// The pane key changed this render: a session, group or crew switch.
  keyMoved: boolean;
  enabled: boolean;
  open: boolean;
  /// Leaving Chat is what closed this key's pane.
  claimed: boolean;
}): SidebarMove {
  if (to === "chat") return claimed ? "restore" : null;
  return enabled && open && from === "chat" && !keyMoved ? "hide" : null;
}
