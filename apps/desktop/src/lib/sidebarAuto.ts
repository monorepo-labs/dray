import type { ViewTab } from "@/components/layout/ViewTabs";

/// What arriving at or leaving the Browser view does to the sidebar, and to
/// the right pane, which takes the same rule under its own switch.
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
