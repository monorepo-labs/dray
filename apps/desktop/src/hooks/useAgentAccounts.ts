import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

import type { AgentAccounts, AuthOption, Harness } from "@/types/events";

/// Who each agent CLI is signed in as, and the two writes that move it.
///
/// Per-component state rather than the module store [useAgentAvailability]
/// keeps, and the difference is what the two answer. That one answers "is this
/// agent offerable", which cannot change while the app runs and is read by the
/// composer on every render; this one answers "who is it", which the reader is
/// on this page to *change* — so it is read when the tab opens, re-read after
/// every write, and forgotten when the dialog closes.
///
/// It takes no `enabled` flag, unlike every other hook the settings dialog
/// reads: the dialog switches tab bodies rather than hiding them, so the one
/// component calling this exists only while its tab is on screen. Mounting is
/// the gate, and a flag beside it would be a second answer to the same
/// question.
export function useAgentAccounts() {
  const [agents, setAgents] = useState<AgentAccounts[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      setAgents(await invoke<AgentAccounts[]>("agent_accounts"));
      // A read that worked describes the page now, so whatever failed before it
      // no longer does — and the sentence is the only thing that would still be
      // claiming otherwise.
      setError(null);
    } catch (err) {
      // The list is kept: a failed refresh must not blank rows that were read
      // a moment ago and are still true. Same reading the PR marks cache takes
      // of a failed `gh`.
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /// Saves a pasted key into the agent's own store.
  ///
  /// Only the key routes reach Rust at all — every other method is a command
  /// the reader runs themselves, so there is nothing here to invoke for it, and
  /// Refresh is how the page learns a terminal sign-in landed.
  ///
  /// Answers whether it took, so the form closes only on success and a refused
  /// key stays in the field: a key refused as truncated is one paste away from
  /// being right, and clearing it takes that away.
  const addAccount = useCallback(
    async (
      harness: Harness,
      provider: string | null,
      auth: string,
      key: string | null,
    ): Promise<boolean> => {
      setError(null);
      setBusy(true);
      let took = true;
      try {
        await invoke("add_agent_account", { harness, provider, auth, key });
      } catch (err) {
        setError(String(err));
        took = false;
      } finally {
        setBusy(false);
      }
      // After the flag is settled either way: a refused write still wants the
      // rows re-read, since the CLI may have cleared what was there first.
      await load();
      return took;
    },
    [load],
  );

  const signOut = useCallback(
    async (harness: Harness, provider: string | null) => {
      setError(null);
      setBusy(true);
      try {
        await invoke("sign_out_agent", { harness, provider });
      } catch (err) {
        setError(String(err));
      } finally {
        setBusy(false);
      }
      await load();
    },
    [load],
  );

  return { agents, busy, error, refresh: load, addAccount, signOut };
}

/// The ways into one agent, or one of its providers.
///
/// Asked of Rust rather than derived here, because the same list is what
/// `add_account` checks against — a second copy in the frontend could offer a
/// route the backend then refuses, which is a control that looks fine and does
/// nothing.
export function useAuthOptions(harness: Harness | null, provider: string | null) {
  const [options, setOptions] = useState<AuthOption[]>([]);

  useEffect(() => {
    if (!harness) {
      setOptions([]);
      return;
    }

    let live = true;
    invoke<AuthOption[]>("agent_auth_options", { harness, provider })
      .then((next) => live && setOptions(next))
      .catch(() => live && setOptions([]));

    return () => {
      live = false;
    };
  }, [harness, provider]);

  return options;
}
