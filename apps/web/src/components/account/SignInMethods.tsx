"use client";

import { type FormEvent, useEffect, useRef, useState } from "react";

import { authClient } from "@/lib/auth-client";

import { ERROR, INPUT, LABEL, PRIMARY, SECONDARY } from "./styles";

type Provider = "github" | "google";
type Mode = "methods" | "sign-in" | "sign-up" | "verify" | "forgot" | "reset";

const ROW =
  "flex h-12 w-full items-center gap-3 border border-white/20 px-4 text-left text-[15px] transition-colors hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-50 light:border-black/15 light:hover:bg-black/5";

/// Every way into Dray: GitHub, Google, or an email whose address a code
/// proves. Lands on `next` once signed in. `via` is the method the desktop
/// app picked, started at once so the reader isn't asked twice.
export function SignInMethods({ next, via, github }: { next: string; via: string | null; github: boolean }) {
  const [mode, setMode] = useState<Mode>(via === "email" ? "sign-in" : "methods");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const started = useRef(false);
  // The app's own sign-in comes back through `/api/app/authorize`, which
  // turns a provider's Cancel into the app's "Sign-in was cancelled".
  const fromApp = next.startsWith("/api/app/authorize");

  const social = async (provider: Provider) => {
    if (provider === "github" && !github) return setError("GitHub sign-in isn't set up on this site yet.");
    setBusy(true);
    setError(null);
    const { error } = await authClient.signIn.social({
      provider,
      callbackURL: next,
      ...(fromApp && { errorCallbackURL: next }),
    });
    // On success the browser is already leaving for the provider.
    if (error) {
      setError(error.message ?? "Couldn't start sign-in. Try again.");
      setBusy(false);
    }
  };

  useEffect(() => {
    if (started.current || (via !== "github" && via !== "google")) return;
    started.current = true;
    void social(via);
    // Once, on arrival from the app.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const run = async (e: FormEvent, step: () => Promise<{ error: { message?: string; code?: string } | null }>) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { error } = await step();
    setBusy(false);
    return error;
  };

  const signedIn = () => window.location.assign(next);

  const signIn = async (e: FormEvent) => {
    const error = await run(e, () => authClient.signIn.email({ email, password }));
    if (!error) return signedIn();
    // An unverified address gets a fresh code on every sign-in attempt.
    if (error.code === "EMAIL_NOT_VERIFIED") return go("verify");
    setError(error.message ?? "Couldn't sign in.");
  };
  const signUp = async (e: FormEvent) => {
    const error = await run(e, () => authClient.signUp.email({ email, password, name: email.split("@")[0] }));
    if (error) return setError(error.message ?? "Couldn't create the account.");
    go("verify");
  };
  const verify = async (e: FormEvent) => {
    const error = await run(e, () => authClient.emailOtp.verifyEmail({ email, otp: code.trim() }));
    if (error) return setError(error.message ?? "That code didn't work.");
    signedIn();
  };
  const forgot = async (e: FormEvent) => {
    const error = await run(e, () => authClient.emailOtp.requestPasswordReset({ email }));
    if (error) return setError(error.message ?? "Couldn't send a code.");
    go("reset");
  };
  const reset = async (e: FormEvent) => {
    const error = await run(e, () => authClient.emailOtp.resetPassword({ email, otp: code.trim(), password }));
    if (error) return setError(error.message ?? "Couldn't reset the password.");
    setPassword("");
    go("sign-in");
  };
  const resend = async () => {
    setError(null);
    const { error } = await authClient.emailOtp.sendVerificationOtp({ email, type: "email-verification" });
    setError(error ? (error.message ?? "Couldn't send a code.") : null);
  };
  const go = (to: Mode) => {
    setCode("");
    setError(null);
    setMode(to);
  };

  const emailField = (
    <label className="flex flex-col gap-2">
      <span className={LABEL}>Email</span>
      <input
        className={INPUT}
        type="email"
        autoComplete="email"
        required
        autoFocus
        value={email}
        onChange={(e) => setEmail(e.target.value)}
      />
    </label>
  );
  const passwordField = (label: string, autoComplete: string) => (
    <label className="flex flex-col gap-2">
      <span className={LABEL}>{label}</span>
      <input
        className={INPUT}
        type="password"
        autoComplete={autoComplete}
        required
        minLength={8}
        value={password}
        onChange={(e) => setPassword(e.target.value)}
      />
    </label>
  );
  const codeField = (
    <label className="flex flex-col gap-2">
      <span className={LABEL}>Code from the email</span>
      <input
        className={`${INPUT} font-mono tracking-[0.3em]`}
        inputMode="numeric"
        autoComplete="one-time-code"
        required
        autoFocus
        maxLength={6}
        value={code}
        onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
      />
    </label>
  );
  const link = (label: string, to: Mode) => (
    <button type="button" className={SECONDARY} onClick={() => go(to)}>
      {label}
    </button>
  );
  const errorLine = error && <p className={ERROR}>{error}</p>;

  if (mode === "methods")
    return (
      <div className="flex max-w-[400px] flex-col gap-2">
        <button type="button" className={ROW} disabled={busy} onClick={() => social("github")}>
          <GitHubGlyph className="size-4" /> Continue with GitHub
        </button>
        <button type="button" className={ROW} disabled={busy} onClick={() => social("google")}>
          <GoogleGlyph className="size-4" /> Continue with Google
        </button>
        <button type="button" className={ROW} disabled={busy} onClick={() => go("sign-in")}>
          <MailGlyph className="size-4" /> Continue with email
        </button>
        {errorLine}
      </div>
    );

  const form = (onSubmit: (e: FormEvent) => void, submit: string, body: React.ReactNode, links: React.ReactNode) => (
    <form onSubmit={onSubmit} className="flex max-w-[400px] flex-col gap-5">
      {body}
      <button type="submit" className={PRIMARY} disabled={busy}>
        {submit}
      </button>
      {errorLine}
      <div className="flex flex-wrap gap-2">{links}</div>
    </form>
  );

  if (mode === "sign-in")
    return form(
      signIn,
      "Sign in",
      <>
        {emailField}
        {passwordField("Password", "current-password")}
      </>,
      <>
        {link("Back", "methods")}
        {link("Create an account", "sign-up")}
        {link("Forgot password", "forgot")}
      </>,
    );
  if (mode === "sign-up")
    return form(
      signUp,
      "Create account",
      <>
        {emailField}
        {passwordField("Password, at least 8 characters", "new-password")}
      </>,
      <>
        {link("Back", "methods")}
        {link("Have an account? Sign in", "sign-in")}
      </>,
    );
  if (mode === "verify")
    return form(
      verify,
      "Verify",
      <>
        <p className="text-[15px]">We emailed a code to {email}.</p>
        {codeField}
      </>,
      <>
        {link("Back", "sign-in")}
        <button type="button" className={SECONDARY} onClick={resend}>
          Send a new code
        </button>
      </>,
    );
  if (mode === "forgot")
    return form(forgot, "Send a reset code", emailField, link("Back", "sign-in"));
  return form(
    reset,
    "Set new password",
    <>
      <p className="text-[15px]">We emailed a code to {email}.</p>
      {codeField}
      {passwordField("New password, at least 8 characters", "new-password")}
    </>,
    link("Back", "sign-in"),
  );
}

function GitHubGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className={className}>
      <path
        fill="currentColor"
        d="M12 .3a12 12 0 0 0-3.8 23.4c.6.1.8-.3.8-.6v-2c-3.3.7-4-1.6-4-1.6-.6-1.4-1.4-1.8-1.4-1.8-1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1 1.8 2.8 1.3 3.5 1 0-.8.4-1.3.7-1.6-2.7-.3-5.5-1.3-5.5-6 0-1.2.5-2.3 1.3-3.1-.2-.4-.6-1.6 0-3.2 0 0 1-.3 3.4 1.2a11.5 11.5 0 0 1 6 0c2.3-1.5 3.3-1.2 3.3-1.2.6 1.6.2 2.8 0 3.2.9.8 1.3 1.9 1.3 3.2 0 4.6-2.8 5.6-5.5 5.9.5.4.9 1 .9 2.2v3.3c0 .3.1.7.8.6A12 12 0 0 0 12 .3"
      />
    </svg>
  );
}

function MailGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className={className}>
      <path fill="currentColor" d="M2 5h20v1.4l-10 6.4L2 6.4z" />
      <path fill="currentColor" d="M2 8.8l10 6.4 10-6.4V19H2z" />
    </svg>
  );
}

export function GoogleGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className={className}>
      <path fill="#4285F4" d="M23.5 12.27c0-.85-.08-1.67-.22-2.45H12v4.64h6.45a5.5 5.5 0 0 1-2.4 3.62v3h3.88c2.27-2.09 3.57-5.17 3.57-8.81Z" />
      <path fill="#34A853" d="M12 24c3.24 0 5.96-1.07 7.94-2.9l-3.88-3.02c-1.07.72-2.45 1.15-4.06 1.15-3.13 0-5.78-2.11-6.72-4.95H1.27v3.11A12 12 0 0 0 12 24Z" />
      <path fill="#FBBC05" d="M5.28 14.28a7.2 7.2 0 0 1 0-4.56V6.61H1.27a12 12 0 0 0 0 10.78l4.01-3.11Z" />
      <path fill="#EA4335" d="M12 4.77c1.76 0 3.34.61 4.59 1.8l3.44-3.44A11.97 11.97 0 0 0 1.27 6.61l4.01 3.11C6.22 6.88 8.87 4.77 12 4.77Z" />
    </svg>
  );
}
