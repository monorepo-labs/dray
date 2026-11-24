import { useCallback, useEffect, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";

import { useAgentAccounts } from "@/hooks/useAgentAccounts";
import { rereadAgentAvailability } from "@/hooks/useAgentAvailability";
import { onFocusChange } from "@/lib/focus";
import { AGENT_LABELS, HARNESS_ORDER } from "@/lib/model";
import { invoke, LOCAL } from "@/lib/transport";
import type { AuthOption, Harness, IntegrationsView } from "@/types/events";

import { useFreshMachine } from "./state";

export type SetupState = "checking" | "ready" | "signin" | "install" | "installing" | "signing" | "failed";

export type SetupRow = { harness: Harness; label: string; state: SetupState; error: string | null };

export type AgentSetup = {
  rows: SetupRow[];
  ready: SetupRow[];
  /// The one thing to do about `harness`: install it, sign it in, or retry a
  /// failed install in Terminal.
  act: (harness: Harness) => void;
};

/// Every agent on this Mac, read the way the Accounts tab reads them, plus
/// whatever onboarding is doing about each one right now.
export function useAgentSetup(): AgentSetup {
  const { agents, refresh } = useAgentAccounts("", LOCAL);
  const fresh = useFreshMachine();
  // What this screen started, keyed by agent: the accounts read can't say
  // "installing", and a login in Terminal reads as signed out until it lands.
  const [doing, setDoing] = useState<Partial<Record<Harness, { state: SetupState; error?: string }>>>({});
  // Installs handed to Terminal, looked for again when the window comes back.
  const inTerminal = useRef(new Set<Harness>());

  useEffect(
    () =>
      onFocusChange((focused) => {
        if (!focused) return;
        const pending = [...inTerminal.current];
        inTerminal.current.clear();
        void Promise.all(pending.map((harness) => invoke<boolean>("recheck_agent", { harness }, LOCAL).catch(() => false))).then(
          (found) => {
            if (found.some(Boolean)) rereadAgentAvailability();
            void refresh();
          },
        );
      }),
    [refresh],
  );

  const mark = (harness: Harness, state: SetupState | null, error?: string) =>
    setDoing((was) => {
      const next = { ...was };
      if (state) next[harness] = { state, error };
      else delete next[harness];
      return next;
    });

  const signIn = useCallback(async (harness: Harness) => {
    const options = await invoke<AuthOption[]>("agent_auth_options", { harness, provider: null }, LOCAL).catch(() => []);
    const first = options.find((o) => o.command);
    if (!first) return mark(harness, null);
    mark(harness, "signing");
    await invoke("run_agent_login", { harness, provider: null, auth: first.id, cwd: "" }, LOCAL).catch(() => mark(harness, null));
  }, []);

  const rows = HARNESS_ORDER.map((harness): SetupRow => {
    const agent = agents?.find((a) => a.harness === harness);
    const signedIn = !fresh && agent?.accounts.some((a) => a.state === "logged_in");
    const known: SetupState = !agent ? "checking" : !agent.installed ? "install" : signedIn ? "ready" : "signin";
    const now = doing[harness];
    // A sign-in that landed wins over "signing"; anything else this screen
    // started wins over the last read.
    const state = known === "ready" || !now ? known : now.state;
    return { harness, label: agent?.label ?? AGENT_LABELS[harness], state, error: now?.error ?? null };
  });

  const act = (harness: Harness) => {
    const row = rows.find((r) => r.harness === harness);
    if (!row) return;
    if (row.state === "signin" || row.state === "signing") void signIn(harness);
    else if (row.state === "failed") {
      inTerminal.current.add(harness);
      mark(harness, "install");
      void invoke("install_agent_in_terminal", { harness }, LOCAL).catch(() => {});
    } else if (row.state === "install") {
      mark(harness, "installing");
      invoke("install_agent", { harness }, LOCAL)
        .then(async () => {
          rereadAgentAvailability();
          await refresh();
          await signIn(harness);
        })
        .catch((err) => mark(harness, "failed", String(err)));
    }
  };

  return { rows, ready: rows.filter((r) => r.state === "ready"), act };
}

export type GithubSetup = { state: SetupState; error: string | null; act: () => void };

/// `gh` on this Mac, installed and signed in, read the way Settings reads it
/// and read again whenever the window comes back from Terminal or a browser.
export function useGithubSetup(): GithubSetup {
  const fresh = useFreshMachine();
  const [known, setKnown] = useState<SetupState>("checking");
  const [doing, setDoing] = useState<{ state: SetupState; error?: string } | null>(null);

  const read = useCallback(async () => {
    const found = await invoke<boolean>("recheck_gh", {}, LOCAL).catch(() => false);
    if (!found) return setKnown("install");
    const view = await invoke<IntegrationsView>("get_integrations", {}, LOCAL).catch(() => null);
    setKnown(view?.github ? "ready" : "signin");
  }, []);

  useEffect(() => {
    void read();
    return onFocusChange((focused) => focused && void read());
  }, [read]);

  const signIn = () => {
    setDoing({ state: "signing" });
    invoke("run_gh_login", { server: null }, LOCAL).catch(() => setDoing(null));
  };

  const shown = fresh && known === "ready" ? "signin" : known;
  const state = shown === "ready" || !doing ? shown : doing.state;

  const act = () => {
    if (state === "signin" || state === "signing") signIn();
    else if (state === "failed") void openUrl(GH_PAGE);
    else if (state === "install") {
      setDoing({ state: "installing" });
      invoke<boolean>("install_gh", {}, LOCAL)
        .then(async (found) => {
          await read();
          if (found) signIn();
          else setDoing({ state: "failed", error: "GitHub CLI installed, but Dray can't find it" });
        })
        .catch((err) => {
          if (String(err) === "no-brew") {
            setDoing(null);
            void openUrl(GH_PAGE);
          } else setDoing({ state: "failed", error: String(err) });
        });
    }
  };

  return { state, error: doing?.error ?? null, act };
}

const GH_PAGE = "https://cli.github.com";
