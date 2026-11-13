import { invoke } from "@/lib/transport";

import type { NoticeKind } from "@/hooks/useNotices";
import { IS_LINUX } from "@/lib/platform";
import { playNotification } from "@/lib/sound";

/// Post a desktop notification that clicks back into its session.
///
/// The whole thing lives in Rust ([notifications.rs](../../src-tauri/src/notifications.rs))
/// rather than in `tauri-plugin-notification`, because the click is only
/// reachable from the handle the plugin throws away. The session id travels out
/// and comes back on `notification_activated`, which is what lets a banner
/// select the session it is about.
///
/// Fire-and-forget by design: this is the *secondary* channel — the sidebar rail
/// survives it either way — so a failure must never surface as an error the
/// reader has to deal with.
///
/// On Linux the banner is posted silent and the window plays the app's own
/// clip: a server's sound is whatever that desktop chose, often nothing, and
/// the Mac's banner sound has no Linux twin to name.
export function notifyOS(sessionId: string, kind: NoticeKind, title: string, body: string) {
  if (IS_LINUX) playNotification();
  void invoke("notify_session", { sessionId, kind, title, body }).catch(() => {});
}
