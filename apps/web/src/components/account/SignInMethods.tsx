"use client";

import { type FormEvent, type ReactNode, useEffect, useRef, useState } from "react";

import { authClient } from "@/lib/auth-client";

import {
  BlueCard,
  Card,
  Cards,
  FIELD,
  FieldCard,
  GitHubIcon,
  GoogleIcon,
  Heading,
  Label,
  LastUsed,
  LINK,
  Links,
  MailIcon,
  RULE,
  Spinner,
} from "./SignInParts";

type Provider = "github" | "google";
export type Method = Provider | "email";
type Mode = "methods" | "sign-in" | "sign-up" | "verify" | "forgot" | "reset";

/// Every way into Dray: GitHub, Google, or an email whose address a code
/// proves. Lands on `next` once signed in. `via` is the method the desktop
/// app picked, started at once so the reader isn't asked twice. `emailOpen` is
/// false while email sign-in is off, which leaves its card in place, disabled.
/// `problem` is why the last try failed, shown until the next one.
/// `lastUsed` is how this browser last signed in, tagged on its card.
export function SignInMethods({
  next,
  via,
  github,
  emailOpen,
  lastUsed,
  problem = null,
}: {
  next: string;
  via: string | null;
  github: boolean;
  emailOpen: boolean;
  lastUsed: Method | null;
  problem?: string | null;
}) {
  const [mode, setMode] = useState<Mode>(via === "email" && emailOpen ? "sign-in" : "methods");
  const [busy, setBusy] = useState<Provider | "form" | null>(null);
  const [error, setError] = useState<string | null>(problem);
  // The desktop app may still offer Email; say why it isn't here.
  const [notice, setNotice] = useState<string | null>(
    via === "email" && !emailOpen ? "Email sign-in is coming in the next few days" : null,
  );
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const started = useRef(false);
  // The app's own sign-in comes back through `/api/app/authorize`, which
  // turns a provider's Cancel into the app's "Sign-in was cancelled".
  const fromApp = next.startsWith("/api/app/authorize");
  // Signing in here is the choice of account, so the app's flow is not
  // asked again ("Continue as…" is for a browser already signed in).
  const done = fromApp ? `${next}&confirmed=1` : next;

  const social = async (provider: Provider) => {
    if (provider === "github" && !github) return setError("GitHub sign-in isn't set up here yet");
    setBusy(provider);
    setError(null);
    const { error } = await authClient.signIn.social({
      provider,
      callbackURL: done,
      ...(fromApp && { errorCallbackURL: next }),
    });
    // On success the browser is already leaving for the provider.
    if (error) {
      setError(error.message ?? "Couldn't start sign-in");
      setBusy(null);
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
    setBusy("form");
    setError(null);
    setNotice(null);
    const { error } = await step();
    setBusy(null);
    return error;
  };

  const signedIn = () => {
    // Held busy: the next page is already loading.
    setBusy("form");
    window.location.assign(done);
  };

  const signIn = async (e: FormEvent) => {
    const error = await run(e, () => authClient.signIn.email({ email, password }));
    if (!error) return signedIn();
    // An unverified address gets a fresh code on every sign-in attempt.
    if (error.code === "EMAIL_NOT_VERIFIED") return go("verify");
    setError(error.message ?? "Couldn't sign in");
  };
  const signUp = async (e: FormEvent) => {
    const error = await run(e, () => authClient.signUp.email({ email, password, name: name.trim() }));
    if (error) return setError(error.message ?? "Couldn't create the account");
    go("verify");
  };
  const verify = async (e: FormEvent) => {
    const error = await run(e, () => authClient.emailOtp.verifyEmail({ email, otp: code.trim() }));
    if (error) return setError(error.message ?? "That code didn't work");
    signedIn();
  };
  const forgot = async (e: FormEvent) => {
    const error = await run(e, () => authClient.emailOtp.requestPasswordReset({ email }));
    if (error) return setError(error.message ?? "Couldn't send a code");
    go("reset");
  };
  const reset = async (e: FormEvent) => {
    const error = await run(e, () => authClient.emailOtp.resetPassword({ email, otp: code.trim(), password }));
    if (error) return setError(error.message ?? "Couldn't reset the password");
    setPassword("");
    go("sign-in");
    setNotice("Password changed. Sign in with it.");
  };
  const resend = async () => {
    setError(null);
    setNotice(null);
    const { error } =
      mode === "reset"
        ? await authClient.emailOtp.requestPasswordReset({ email })
        : await authClient.emailOtp.sendVerificationOtp({ email, type: "email-verification" });
    if (error) setError(error.message ?? "Couldn't send a code");
    else setNotice(`New code sent to ${email}`);
  };
  const go = (to: Mode) => {
    setCode("");
    setError(null);
    setNotice(null);
    setMode(to);
  };

  /// The label line: what went wrong, else what just happened, else `plain`.
  const label = (plain: string) =>
    error ? <Label danger>{trimStop(error)}</Label> : <Label>{notice ? trimStop(notice) : plain}</Label>;

  if (mode === "methods")
    return (
      <>
        {label("Welcome to Dray")}
        <Heading>{error ? "Pick an account to try again." : "Pick an account to sign in with."}</Heading>
        <Cards>
          <Card
            icon={busy === "github" ? <Spinner size={40} /> : <GitHubIcon />}
            label="GitHub"
            corner
            tag={lastUsed === "github" && <LastUsed />}
            disabled={busy !== null}
            onClick={() => social("github")}
          />
          <Card
            icon={busy === "google" ? <Spinner size={40} /> : <GoogleIcon />}
            label="Google"
            corner
            tag={lastUsed === "google" && <LastUsed />}
            disabled={busy !== null}
            onClick={() => social("google")}
          />
          {emailOpen ? (
            <Card
              icon={<MailIcon />}
              label="Email"
              corner
              tag={lastUsed === "email" && <LastUsed />}
              disabled={busy !== null}
              onClick={() => go("sign-in")}
            />
          ) : (
            <Card
              icon={<MailIcon />}
              label="Email"
              detail="Coming in the next few days"
              tag={lastUsed === "email" && <LastUsed />}
              disabled
            />
          )}
        </Cards>
      </>
    );

  const emailField = (focus = true) => (
    <FieldCard label="Email">
      <input
        className={FIELD}
        type="email"
        autoComplete="email"
        placeholder="you@example.com"
        required
        autoFocus={focus}
        value={email}
        onChange={(e) => setEmail(e.target.value)}
      />
    </FieldCard>
  );
  const passwordField = (name: string, autoComplete: string, focus = false) => (
    <FieldCard label={name}>
      <input
        className={FIELD}
        type="password"
        autoComplete={autoComplete}
        placeholder="At least 8 characters"
        required
        minLength={8}
        autoFocus={focus}
        value={password}
        onChange={(e) => setPassword(e.target.value)}
      />
    </FieldCard>
  );
  const link = (text: string, onClick: () => void) => (
    <button type="button" className={LINK} onClick={onClick} disabled={busy !== null}>
      {text}
    </button>
  );
  const step = (onSubmit: (e: FormEvent) => void, plain: string, heading: string, cards: ReactNode, links: ReactNode) => (
    // Keyed so each step mounts its own inputs: reused ones never take `autoFocus`.
    <form key={mode} onSubmit={onSubmit}>
      {label(plain)}
      <Heading>{heading}</Heading>
      <Cards>{cards}</Cards>
      {links}
    </form>
  );

  if (mode === "sign-in")
    return step(
      signIn,
      "Welcome to Dray",
      "Sign in with email.",
      <>
        {emailField()}
        {passwordField("Password", "current-password")}
        <BlueCard label="Sign in" busy={busy === "form"} />
      </>,
      <Links onBack={() => go("methods")}>
        {link("Create an account", () => go("sign-up"))}
        {link("Forgot password", () => go("forgot"))}
      </Links>,
    );
  if (mode === "sign-up")
    return step(
      signUp,
      "Welcome to Dray",
      "Create your account.",
      <>
        <FieldCard label="Name">
          <input
            className={FIELD}
            autoComplete="name"
            placeholder="Your name"
            required
            autoFocus
            value={name}
            // Spaces alone would pass `required` and leave an empty name.
            onChange={(e) => setName(e.target.value.trimStart())}
          />
        </FieldCard>
        {emailField(false)}
        {passwordField("Password", "new-password")}
        <BlueCard label="Create account" busy={busy === "form"} />
      </>,
      <Links onBack={() => go("methods")}>{link("Have an account? Sign in", () => go("sign-in"))}</Links>,
    );
  if (mode === "verify")
    return step(
      verify,
      `Sent to ${email}`,
      "Enter the code we emailed you.",
      <>
        <CodeBoxes value={code} onChange={setCode} />
        <BlueCard label="Verify" busy={busy === "form"} />
      </>,
      <Links onBack={() => go("sign-in")}>{link("Send a new code", resend)}</Links>,
    );
  if (mode === "forgot")
    return step(
      forgot,
      "Forgot password",
      "We'll email you a code to reset it.",
      <>
        {emailField()}
        <BlueCard label="Send a code" busy={busy === "form"} />
      </>,
      <Links onBack={() => go("sign-in")} />,
    );
  return step(
    reset,
    `Sent to ${email}`,
    "Set a new password.",
    <>
      <FieldCard label="Code from the email">
        <input
          className={`${FIELD} font-mono tracking-[0.3em]`}
          inputMode="numeric"
          autoComplete="one-time-code"
          placeholder="000000"
          required
          autoFocus
          maxLength={6}
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
        />
      </FieldCard>
      {passwordField("New password", "new-password")}
      <BlueCard label="Set password" busy={busy === "form"} />
    </>,
    <Links onBack={() => go("forgot")}>{link("Send a new code", resend)}</Links>,
  );
}

/// Six boxes for the emailed code, drawn over one real input so paste,
/// autofill and the keyboard's one-time-code suggestion all just work.
function CodeBoxes({ value, onChange }: { value: string; onChange: (code: string) => void }) {
  const [focused, setFocused] = useState(true);
  const at = Math.min(value.length, 5);
  return (
    <label className="relative flex min-w-0 flex-[2_1_0] gap-[2px] sm:flex-[1.75_1_0]">
      <input
        className="absolute inset-0 z-10 w-full cursor-text bg-transparent text-transparent caret-transparent opacity-0 outline-none"
        aria-label="Code from the email"
        inputMode="numeric"
        autoComplete="one-time-code"
        required
        autoFocus
        minLength={6}
        maxLength={6}
        pattern="\d{6}"
        value={value}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onChange={(e) => onChange(e.target.value.replace(/\D/g, "").slice(0, 6))}
      />
      {Array.from({ length: 6 }, (_, i) => {
        const current = focused && i === at;
        return (
          <span
            key={i}
            className={`flex h-[140px] min-w-0 flex-1 basis-0 items-center justify-center bg-[#1C1C1C] font-inter text-[44px] font-light text-white sm:h-[220px] sm:text-[56px] light:bg-[#F4F4F5] light:text-[#0A0A0A] ${current ? RULE : ""}`}
          >
            {value[i] ?? (current && <span className="h-14 w-px animate-pulse bg-white/90 light:bg-black/90" />)}
          </span>
        );
      })}
    </label>
  );
}

/// Labels are one line in caps; a sentence's full stop reads oddly there.
function trimStop(text: string) {
  return text.replace(/\.\s*$/, "");
}
