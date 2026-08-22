import { useEffect, useMemo } from "react";

import { getCurrentWindow } from "@tauri-apps/api/window";

import { attentionCount } from "@/lib/attention";
import type { SessionIndexItem, SessionStatus } from "@/types/events";

/// Mirror the attention count onto the dock icon's badge.
///
/// Nothing here has to clear it: both marks retire themselves — viewing a row
/// reads its completion, answering a request retires the ask — so the count
/// falls to zero through the same path the rail empties by. Zero is passed as
/// `undefined`, which is what removes the badge rather than drawing a `0`.
///
/// `core:window:allow-set-badge-count` is **not** in `core:default` and has to
/// be named in the capability file. Without it the ACL refuses the call and
/// reports nothing, which looks exactly like a badge that was never wired up —
/// the same trap `start-dragging` has.
export function useDockBadge(
  statusBySession: Record<string, SessionStatus>,
  asksBySession: Record<string, string[]>,
  items: SessionIndexItem[],
): void {
  const count = useMemo(
    () => attentionCount(statusBySession, asksBySession, items),
    [statusBySession, asksBySession, items],
  );

  useEffect(() => {
    try {
      // Best-effort like the desktop banner: the rail is the signal that has to
      // work, and a dock icon that failed to update is not worth raising.
      void getCurrentWindow()
        .setBadgeCount(count === 0 ? undefined : count)
        .catch(() => {});
    } catch {
      // No Tauri window under `pnpm dev` — `getCurrentWindow` throws rather
      // than rejecting there.
    }
  }, [count]);
}
