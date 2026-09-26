import type { ViewTab } from "@/components/layout/ViewTabs";

/// What arriving at or leaving the Browser view does to the sidebar.
///
/// A pure function rather than two branches in `App`'s effect, because the
/// whole rule is which transition is which and the effect that holds it re-runs
/// on state it only *reads*: `collapsed` is a dep, so collapsing the sidebar
/// runs the rule again with the view unchanged. A branch naming only where the
/// reader came *from* gave the sidebar straight back on the frame it took it,
/// and nothing on screen said so until a review caught it.
export type SidebarMove = "hide" | "restore" | null;

export function sidebarMove({
  from,
  to,
  enabled,
  collapsed,
  /// Whether arriving at the Browser is what collapsed the sidebar. A sidebar
  /// the reader closed themselves is theirs, so leaving must not open it.
  claimed,
}: {
  from: ViewTab;
  to: ViewTab;
  enabled: boolean;
  collapsed: boolean;
  claimed: boolean;
}): SidebarMove {
  if (from === to) return null;
  // Nothing to hide when it is already away, and nothing to explain either —
  // the notice rides this answer, so an arrival that moved nothing says nothing.
  if (to === "browser") return enabled && !collapsed ? "hide" : null;
  if (from === "browser") return claimed ? "restore" : null;
  return null;
}

/// The right pane's half of the same rule, which differs because the pane and
/// the view tab are both per session: selecting another session moves the view
/// without the claimed session ever leaving its page. So a claim is given back
/// only once its own key is on screen off the Browser view, and a hide fires
/// only on a key that stayed put — a session reached already on the Browser,
/// pane open, is the reader returning to it rather than arriving.
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
  /// Arriving at the Browser is what closed this key's pane.
  claimed: boolean;
}): SidebarMove {
  if (to !== "browser") return claimed ? "restore" : null;
  return enabled && open && from !== "browser" && !keyMoved ? "hide" : null;
}
