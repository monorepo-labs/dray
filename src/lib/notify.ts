import { invoke } from "@tauri-apps/api/core";

import type { NoticeKind } from "@/hooks/useNotices";

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
export function notifyOS(sessionId: string, kind: NoticeKind, title: string, body: string) {
  void invoke("notify_session", { sessionId, kind, title, body }).catch(() => {});
}
