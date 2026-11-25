import { useEffect } from "react";

import { invoke, listen } from "@/lib/transport";

/// While `active`, a quit — the window's close button, ⌘Q — quits at once,
/// the way the quit dialog's Quit does, leaving the server running.
///
/// For the screens drawn instead of the app or over it, onboarding and the
/// sign-in gate: the dialog lives in the app, so there it was either not
/// mounted or hidden behind them, and only a second close got out. No session
/// can be running yet, so there is nothing for the dialog to ask.
export function useQuitAtOnce(active: boolean) {
  useEffect(() => {
    if (!active) return;
    const unlisten = listen("quit_requested", () => void invoke("confirm_quit", { stopSessions: false }));
    return () => void unlisten.then((f) => f());
  }, [active]);
}
