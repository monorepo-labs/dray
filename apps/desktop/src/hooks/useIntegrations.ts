import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useState } from "react";

import { forgetIssues } from "@/hooks/useIssues";
import { connectedTrackers } from "@/lib/issueTracker";
import type { IntegrationsView } from "@/types/events";

/// The connected issue tracker, and the two writes that change it.
///
/// Lives in `App` rather than in the dialog that used to own it: three surfaces
/// read it now — the settings row, the issues page's own connect form, and the
/// composer's placeholder — and a second copy per surface is a second answer to
/// "are we connected" free to disagree with the first.
export function useIntegrations(
  enabled: boolean,
  /// Called once a disconnect lands. Rust clears the project pins and filters
  /// naming the workspace, and the app's copy of the projects has to hear of
  /// it, or a reconnect revives pins the backend no longer holds.
  onDisconnected?: () => void,
) {
  const [integrations, setIntegrations] = useState<IntegrationsView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) return;

    let live = true;
    invoke<IntegrationsView>("get_integrations")
      .then((next) => live && setIntegrations(next))
      .catch((e) => console.error("[integrations]", e));

    return () => {
      live = false;
    };
  }, [enabled]);

  /// Saves a key, or reports why it was refused.
  ///
  /// The error is *returned into state* rather than thrown: the row draws it
  /// under the field, where a pasted key that was truncated or revoked is one
  /// sentence away from being fixed. Answers whether it worked, so the caller
  /// can clear the field only on success.
  const connect = useCallback(async (key: string): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      setIntegrations(await invoke<IntegrationsView>("connect_linear", { key }));
      // Every cached answer was taken with no key, including the
      // `not_connected` failure the page's empty state was drawn from — so
      // without this, connecting leaves the reader looking at the form they
      // just filled in.
      forgetIssues();
      return true;
    } catch (e) {
      setError(String(e));
      return false;
    } finally {
      setBusy(false);
    }
  }, []);

  /// Asks again whether `gh` is there and signed in, after the reader has gone
  /// and done something about it.
  ///
  /// **Two caches, and clearing one is not enough.** `binpath::gh` remembers an
  /// absent CLI and `issues::github` remembers a logged-out one, both for the
  /// life of the process — so without this, a `gh auth login` that worked left
  /// the connect pane exactly as it was until the app was relaunched, which is
  /// the one thing a pane asking for a sign-in cannot look like. `recheck_gh`
  /// throws the first away; re-reading the integrations is what the pane draws
  /// from; `forgetIssues` is what makes the list actually re-read, since every
  /// cached answer here was taken while signed out — the `not_connected`
  /// failure this pane was drawn from included.
  ///
  /// The same control serves both halves, deliberately: a missing `gh` and a
  /// logged-out one are one state on this surface (`NotConnected`), so a button
  /// that claimed to know which one it had just fixed would be guessing.
  const recheckGithub = useCallback(async () => {
    setBusy(true);
    try {
      await invoke<boolean>("recheck_gh").catch(() => false);
      setIntegrations(await invoke<IntegrationsView>("get_integrations"));
      forgetIssues();
    } catch (e) {
      console.error("[integrations]", e);
    } finally {
      setBusy(false);
    }
  }, []);

  /// One write that answers with the whole view, busy while it runs and with
  /// its refusal in `error`. `forget` is for writes that change which keys
  /// exist, since every cached answer was read with one of them.
  const write = useCallback(
    async (command: string, args: Record<string, unknown>, forget: boolean) => {
      setBusy(true);
      setError(null);
      try {
        setIntegrations(await invoke<IntegrationsView>(command, args));
        if (forget) forgetIssues();
      } catch (e) {
        setError(String(e));
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  /// Forgets one Linear workspace — `null` for the default, which is the only
  /// way to name one Linear never identified. The other direction from
  /// `connect`, and the same reason: a list read with its key must not outlive
  /// it.
  const disconnect = useCallback(
    async (workspace: string | null) => {
      await write("disconnect_linear", { workspace }, true);
      onDisconnected?.();
    },
    [write, onDisconnected],
  );

  /// What an unpinned project reads. Moves no key a list was read with, so the
  /// caches stand: each is keyed by its workspace already.
  const makeDefault = useCallback(
    (workspace: string) => write("set_default_linear_workspace", { workspace }, false),
    [write],
  );

  /// Pins every project in a Space to a workspace, or clears it with `null`.
  const pinSpace = useCallback(
    (space: string, workspace: string | null) =>
      write("set_space_linear_workspace", { space, workspace }, false),
    [write],
  );

  /// Re-reads the view, for a change made elsewhere that moves a Space's pin —
  /// renaming a Space carries its pin in Rust, and nothing here saw it.
  const reload = useCallback(() => {
    invoke<IntegrationsView>("get_integrations")
      .then(setIntegrations)
      .catch((e) => console.error("[integrations]", e));
  }, []);

  return {
    integrations,
    /// Which trackers have something behind them. Read by the chips, by the
    /// page's empty state and by `App`'s own "is anything connected" — one
    /// answer, since a second reading of `integrations` per surface is a second
    /// answer free to disagree with the first.
    connected: connectedTrackers(integrations),
    busy,
    error,
    connect,
    disconnect,
    makeDefault,
    pinSpace,
    reload,
    recheckGithub,
  };
}
