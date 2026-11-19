import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";

import SignInGate, { type GateView } from "@/components/SignInGate";
import { useLocalServer } from "@/lib/servers";
import { invoke, listen, LOCAL } from "@/lib/transport";
import type { DrayAccountState, SignInMethod, SignInStarted } from "@/types/events";

/// Set while this app has been signed in, so the next launch draws the app at
/// once rather than the gate, and a sign-in that later vanishes reads as
/// "You've been signed out" rather than a first visit.
const SIGNED_IN = "dray.signedIn";
/// How often a skipped gate asks whether drayhq.com is back.
const PROBE_MS = 10_000;
/// The server's own recheck interval with drayhq.com.
const RECHECK_MS = 60_000;

let readerSignedOut = false;

/// Called by Settings' Sign out, so the gate it leads to greets a returning
/// reader rather than telling them they were signed out.
export function markSignOut() {
  readerSignedOut = true;
}

const ERRORS: Record<string, string> = {
  cancelled: "Sign-in was cancelled",
  timed_out: "Sign-in timed out",
};

/// Everyone signs in before using Dray (#1277). Draws the app while this
/// machine's server says someone is signed in, and the sign-in gate
/// otherwise. The app is not mounted behind the gate, so nothing in it can be
/// reached by a shortcut. Offline, the gate offers Skip for now; once the
/// site answers again, the gate is back.
export default function AccountGate({ children }: { children: ReactNode }) {
  const local = useLocalServer();
  const connected = local?.status === "connected";
  const [account, setAccount] = useState<DrayAccountState | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [skipped, setSkipped] = useState(false);
  const [remembered] = useState(() => localStorage.getItem(SIGNED_IN) === "1");
  // Signed in at some point, this run or a past one: losing it now is
  // "You've been signed out", unless the reader chose Sign out.
  const everSignedIn = useRef(remembered);
  const url = useRef<string | null>(null);

  const load = useCallback(() => {
    invoke<DrayAccountState>("account_state", {}, LOCAL)
      .then((now) => {
        setAccount(now);
        setFailed(null);
      })
      .catch((e) => setFailed(String(e)));
  }, []);

  useEffect(() => {
    let live = true;
    let off: (() => void) | undefined;
    void listen("account_changed", ({ server }) => {
      if (server === LOCAL) load();
    }).then((unlisten) => {
      if (!live) return unlisten();
      off = unlisten;
      load();
    });
    return () => {
      live = false;
      off?.();
    };
  }, [load]);

  // A restarted server sends no event this side hears.
  useEffect(() => {
    if (connected) load();
  }, [connected, load]);

  // The server checks with the site only when asked, so ask on its own
  // cadence: a sign-in revoked on drayhq.com brings the gate back within a
  // minute or two.
  useEffect(() => {
    const timer = setInterval(load, RECHECK_MS);
    return () => clearInterval(timer);
  }, [load]);

  const signedIn = Boolean(account?.user);
  useEffect(() => {
    if (!account) return;
    if (account.user) {
      everSignedIn.current = true;
      localStorage.setItem(SIGNED_IN, "1");
      readerSignedOut = false;
      setSkipped(false);
    } else if (readerSignedOut) {
      localStorage.removeItem(SIGNED_IN);
    }
  }, [account]);

  // Coming back from the browser: the window was behind it.
  const wasSignedIn = useRef(signedIn);
  useEffect(() => {
    if (signedIn && !wasSignedIn.current && account?.user) {
      void import("@tauri-apps/api/window")
        .then(({ getCurrentWindow }) => getCurrentWindow().setFocus())
        .catch(() => {});
    }
    wasSignedIn.current = signedIn;
  }, [signedIn, account]);

  useEffect(() => {
    if (!skipped) return;
    const timer = setInterval(() => {
      void invoke<boolean>("account_reachable", {}, LOCAL)
        .then(async (up) => {
          if (!up) return;
          // Clears the `offline` the skip was taken under, so the gate comes
          // back as a plain sign-in rather than offering Skip again.
          await invoke("account_sign_in_cancel", {}, LOCAL).catch(() => {});
          setSkipped(false);
        })
        .catch(() => {});
    }, PROBE_MS);
    return () => clearInterval(timer);
  }, [skipped]);

  const pick = useCallback(async (method: SignInMethod) => {
    setFailed(null);
    try {
      const started = await invoke<SignInStarted>("account_sign_in_start", { method }, LOCAL);
      url.current = started.url;
      await openUrl(started.url);
    } catch (e) {
      // `offline` arrives as state through `account_changed`.
      if (String(e) !== "offline") setFailed(String(e));
    }
  }, []);
  const openAgain = useCallback(() => {
    if (url.current) void openUrl(url.current);
    else if (account?.signingIn) void pick(account.signingIn);
  }, [account, pick]);
  const cancel = useCallback(() => void invoke("account_sign_in_cancel", {}, LOCAL).catch(() => {}), []);

  // Until the server answers, a machine signed in last time draws the app,
  // which is nearly always right; anyone else sees the gate's empty frame.
  if (signedIn || skipped || (!account && !failed && remembered)) return <>{children}</>;

  let view: GateView | null = null;
  if (account?.signingIn) view = { kind: "waiting", method: account.signingIn, finishing: account.finishing };
  else if (account || failed) {
    const error = account?.error ?? null;
    view = {
      kind: "choose",
      revoked: everSignedIn.current && !readerSignedOut,
      offline: error === "offline",
      error: error === "offline" ? null : error ? (ERRORS[error] ?? error) : failed,
    };
  }
  return <SignInGate view={view} onPick={pick} onOpenAgain={openAgain} onCancel={cancel} onSkip={() => setSkipped(true)} />;
}
