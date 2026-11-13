import { useCallback, useEffect, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";

import { invoke, listen, LOCAL, type ServerId } from "@/lib/transport";
import type { DrayAccountState, LinkState } from "@/types/events";

/// The servers' own recheck interval with drayhq.com.
const RECHECK_MS = 60_000;

/// Reads `cmd` now, again on `event` from `server`, and once a minute, while
/// `enabled`. `null` until the first answer, and for a server too old to
/// know the command, which answers `unknown command`.
function useServerState<T>(server: ServerId, enabled: boolean, cmd: string, event: string) {
  const [state, setState] = useState<T | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    let unlisten: (() => void) | undefined;
    // A timed reread that fails keeps what it had, so a blip never blanks
    // the row; the first read's failure is what marks a server too old.
    const load = (keep = false) =>
      void invoke<T>(cmd, {}, server)
        .then((now) => live && setState(now))
        .catch(() => live && !keep && setState(null));
    void listen(event, ({ server: from }) => {
      if (from === server) load();
    }).then((off) => {
      if (!live) return off();
      unlisten = off;
      load();
    });
    // A change made on the site sends no event: the server only rechecks
    // when asked, at most once a minute, so ask that often while shown.
    const timer = setInterval(() => load(true), RECHECK_MS);
    return () => {
      live = false;
      clearInterval(timer);
      unlisten?.();
    };
  }, [server, enabled, cmd, event]);
  return state;
}

/// One server's link to an org at drayhq.com (#874): where it stands, and
/// starting, cancelling and ending a link. Read while `connected`, and again
/// on every reconnect, since a change made while the connection was down
/// sends no event this side hears.
export function useOrgLink(server: ServerId, connected: boolean) {
  const state = useServerState<LinkState>(server, connected, "org_link_state", "org_link_changed");
  const [error, setError] = useState<string | null>(null);

  /// Starts the server's flow and opens the approve page with the code in it.
  /// `signIn` is the app's own Sign in, This Mac's alone.
  const start = useCallback(
    async (signIn = false) => {
      setError(null);
      try {
        const pending = await invoke<{ url: string }>("org_link_start", signIn ? { signIn } : {}, server);
        await openUrl(pending.url);
      } catch (e) {
        setError(String(e));
      }
    },
    [server],
  );
  const cancel = useCallback(() => void invoke("org_link_cancel", {}, server).catch((e) => setError(String(e))), [server]);
  const unlink = useCallback(async () => {
    setError(null);
    try {
      const done = await invoke<{ warning: string | null }>("org_unlink", {}, server);
      if (done.warning) setError(done.warning);
    } catch (e) {
      setError(String(e));
    }
  }, [server]);

  return { state, error: error ?? state?.error ?? null, start, cancel, unlink };
}

/// Who the app on this machine is signed in to drayhq.com as. The local
/// server holds it, since its link flow is what signs the app in.
export function useDrayAccount(connected: boolean) {
  return useServerState<DrayAccountState>(LOCAL, connected, "account_state", "account_changed");
}
