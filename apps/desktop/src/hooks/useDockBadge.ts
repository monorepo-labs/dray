import { useEffect, useMemo, useRef } from "react";

import { getCurrentWindow } from "@tauri-apps/api/window";

import { attentionCount } from "@/lib/attention";
import { isWindowFocused, onFocusChange } from "@/lib/focus";
import { IS_LINUX } from "@/lib/platform";
import { invoke } from "@/lib/transport";
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
      // On Linux this reaches a launcher only where libunity is installed.
      void getCurrentWindow()
        .setBadgeCount(count === 0 ? undefined : count)
        .catch(() => {});
    } catch {
      // No Tauri window under `pnpm dev` — `getCurrentWindow` throws rather
      // than rejecting there.
    }
  }, [count]);

  // Linux's other half: the window's urgency hint. Raised only by a count
  // rising while the reader is away, and dropped on their return, since a
  // taskbar entry flashing at someone looking at the window says nothing.
  const seen = useRef(count);
  useEffect(() => {
    if (!IS_LINUX) return;
    if (count === 0) setUrgent(false);
    else if (count > seen.current && !isWindowFocused()) setUrgent(true);
    seen.current = count;
  }, [count]);
  useEffect(() => (IS_LINUX ? onFocusChange((focused) => focused && setUrgent(false)) : undefined), []);
}

function setUrgent(urgent: boolean) {
  void invoke("set_window_urgent", { urgent }).catch(() => {});
}
