import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";

import { useOnboarding } from "@/components/onboarding/state";
import SignInGate, { type GateView } from "@/components/SignInGate";
import { useQuitAtOnce } from "@/hooks/useQuitAtOnce";
import { type GateReason, trackSignInGate } from "@/lib/analytics";
import { useLocalServer } from "@/lib/servers";
import { onFocusChange } from "@/lib/focus";
import { blocksSignIn, ONBOARDED, SIGNED_IN } from "@/lib/signInGate";
import { signInAsked, signInRequired, SKIPPED } from "@/lib/signInNudge";
import { invoke, listen, LOCAL } from "@/lib/transport";
import type { DrayAccountState, SignInMethod, SignInStarted } from "@/types/events";

/// The way in this app last signed in with, for the gate's "Last used" tag.
/// Here and not on the server: it describes this app's reader, not the account.
const LAST_METHOD = "dray.lastSignInMethod";
/// The server's own recheck interval with drayhq.com.
const RECHECK_MS = 60_000;
/// How long the window must have been away for its return to be a calm moment
/// for the nudge: the reader is coming back, not mid-sentence.
const AWAY_MS = 10 * 60_000;

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

/// The sign-in gate (#1277), which a reader may skip (#1590). Draws the app
/// while this machine's server says someone is signed in or the reader
/// skipped, and the gate otherwise. The app is not mounted behind that gate,
/// so nothing in it can be reached by a shortcut.
///
/// A skipped reader meets the gate again from Settings' Sign in, drawn over
/// the app, which stays mounted with keys held back from it. Once their use
/// makes sign-in required (`signInRequired`) the gate loses Skip: in front of
/// the app at launch, or over it when the window comes back after a while
/// away. Only a sign-in the network won't let finish lets them past, for
/// this run alone.
export default function AccountGate({ children }: { children: ReactNode }) {
  const local = useLocalServer();
  const connected = local?.status === "connected";
  const [account, setAccount] = useState<DrayAccountState | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [skipped, setSkipped] = useState(() => localStorage.getItem(SKIPPED) === "1");
  const [remembered] = useState(() => localStorage.getItem(SIGNED_IN) === "1");
  // Signed in at some point, this run or a past one: losing it now is
  // "You've been signed out", unless the reader chose Sign out.
  const everSignedIn = useRef(remembered);
  const url = useRef<string | null>(null);
  const [lastUsed, setLastUsed] = useState(() => storedMethod(localStorage.getItem(LAST_METHOD)));
  // The way in a browser sign-in took, recorded once it lands.
  const picked = useRef<SignInMethod | null>(null);

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
    if (account.signingIn) picked.current = account.signingIn;
    else if (account.error) picked.current = null;
    if (account.user && picked.current) {
      localStorage.setItem(LAST_METHOD, picked.current);
      setLastUsed(picked.current);
      picked.current = null;
    }
    if (account.user) {
      everSignedIn.current = true;
      localStorage.setItem(SIGNED_IN, "1");
      localStorage.setItem(ONBOARDED, "1");
      readerSignedOut = false;
      localStorage.removeItem(SKIPPED);
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
  // Required at launch: the gate stands in front of the app as on a first
  // launch, only without Skip.
  const [shut] = useState(() => signInRequired());
  // Required now, which may have come due while the app ran.
  const [required, setRequired] = useState(shut);
  // Let past a required gate by a sign-in the network wouldn't let finish:
  // this run only, so the gate is back at the next launch or calm moment.
  const [bypassed, setBypassed] = useState(false);
  // The gate drawn over the app, which stays mounted under it, and why.
  const [over, setOver] = useState<GateReason | null>(null);
  // Why the gate on screen is up, for its analytics.
  const reason = useRef<GateReason | null>(null);
  const skip = useCallback(() => {
    if (reason.current) trackSignInGate("skipped", reason.current);
    localStorage.setItem(SKIPPED, "1");
    // Clears an `offline` or failed sign-in, so a later gate opens fresh.
    void invoke("account_sign_in_cancel", {}, LOCAL).catch(() => {});
    setSkipped(true);
    setBypassed(true);
    setOver(null);
  }, []);

  useEffect(() => signInAsked.subscribe(() => setOver("settings")), []);
  useEffect(() => {
    if (signedIn) setOver(null);
  }, [signedIn]);

  // Only once the server has said no one is signed in, so a slow answer
  // can't put the gate over a signed-in reader. A calm moment is the window
  // coming back after a while away: the reader is returning, not mid-sentence.
  const signedOut = Boolean(account && !account.user);
  useEffect(() => {
    if (!signedOut || !skipped) return;
    let leftAt: number | null = null;
    return onFocusChange((focused) => {
      if (!focused) leftAt = Date.now();
      else if (leftAt !== null && Date.now() - leftAt >= AWAY_MS && signInRequired()) {
        setRequired(true);
        setBypassed(false);
        setOver("required");
      }
    });
  }, [signedOut, skipped]);

  // Keys stay with the gate while it covers the app: no shortcut, and no
  // typing into a composer the reader can't see.
  const covering = over !== null;
  useEffect(() => {
    if (!covering) return;
    (document.activeElement as HTMLElement | null)?.blur?.();
    const hold = (e: KeyboardEvent) => {
      if ((e.target as Element | null)?.closest?.("[data-sign-in-gate]")) return;
      e.stopPropagation();
      e.preventDefault();
    };
    window.addEventListener("keydown", hold, true);
    return () => window.removeEventListener("keydown", hold, true);
  }, [covering]);

  // Until the server answers, a machine signed in last time draws the app,
  // which is nearly always right; anyone else sees the gate's empty frame.
  const open = signedIn || (skipped && (!shut || bypassed)) || (!account && !failed && remembered);
  useQuitAtOnce(!open);

  let view: GateView | null = null;
  if (account?.signingIn) view = { kind: "waiting", method: account.signingIn, finishing: account.finishing };
  else if (account || failed) {
    const error = account?.error ?? null;
    view = {
      kind: "choose",
      revoked: everSignedIn.current && !readerSignedOut,
      offline: error === "offline",
      error: error === "offline" ? null : error ? (ERRORS[error] ?? error) : failed,
      emailOff: account?.emailOff ?? false,
      lastUsed,
      required,
      // Never locked out by the network: a failure trying again can't fix
      // opens the way past a required gate.
      canSkip: !required || blocksSignIn(error) || failed !== null,
    };
  }
  // In front of the app, required at launch, a sign-in gone, or a reader who
  // has neither signed in nor skipped; over it, whatever brought it up.
  const front: GateReason = shut ? "required" : everSignedIn.current ? "signed_out" : "first_launch";
  const showing = !view ? null : !open ? front : over && !signedIn ? over : null;
  reason.current = showing;
  // Counted once it can be seen: onboarding draws over the gate on a first
  // launch, and the gate's empty frame waiting on the server is not it yet.
  const onboarding = useOnboarding();
  const counted = useRef<GateReason | null>(null);
  useEffect(() => {
    if (onboarding || counted.current === showing) return;
    counted.current = showing;
    if (showing) trackSignInGate("shown", showing);
  }, [onboarding, showing]);

  const gate = <SignInGate view={view} onPick={pick} onOpenAgain={openAgain} onCancel={cancel} onSkip={skip} />;
  if (!open) return gate;
  // One shape whether or not the gate is up, so the app never remounts.
  return (
    <>
      {children}
      {over && !signedIn ? gate : null}
    </>
  );
}

function storedMethod(value: string | null): SignInMethod | null {
  return value === "github" || value === "google" || value === "email" ? value : null;
}
