"use client";

import { useState } from "react";

import { authClient } from "@/lib/auth-client";

import { SignInMethods } from "./SignInMethods";
import { ERROR, H1, LABEL } from "./styles";

type Account = { name: string; email: string; image: string | null };

/// What the desktop app's sign-in shows a browser already signed in to
/// drayhq.com (#1277): continue as that account, or sign out here and pick
/// another way in. Continue goes on to `next` with `confirmed=1`, which is
/// what lets `/api/app/authorize` hand the app its code.
export function AccountChooser({
  account,
  next,
  machine,
  github,
}: {
  account: Account;
  next: string;
  machine: string | null;
  github: boolean;
}) {
  const [switching, setSwitching] = useState(false);
  const [signedOut, setSignedOut] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const first = account.name.trim().split(/\s+/)[0] || account.email;

  const useAnother = async () => {
    setSwitching(true);
    setError(null);
    const { error } = await authClient.signOut();
    setSwitching(false);
    if (error) return setError(error.message ?? "Couldn't sign out. Try again.");
    setSignedOut(true);
  };

  if (signedOut)
    return (
      <div className="lg:ml-[102px] lg:max-w-[756px]">
        <h1 className={H1}>Sign in to Dray.</h1>
        <div className="mt-10">
          <SignInMethods next={next} via={null} github={github} />
        </div>
      </div>
    );

  return (
    <>
      <p className={`mt-16 flex items-center gap-2 sm:mt-[101px] lg:ml-[102px] ${LABEL}`}>
        <Mark />
        {machine ? `Signing in to Dray on ${machine}` : "Signing in to Dray"}
      </p>
      <h1 className="mt-3.5 font-inter text-[28px] leading-[32px] font-light tracking-[-0.03em] sm:text-[36px] sm:leading-[40px] lg:ml-[102px]">
        Continue as {first}?
      </h1>
      <div className="mt-10 flex flex-col gap-[2px] sm:flex-row">
        <a
          href={`${next}&confirmed=1`}
          className="flex h-[220px] flex-1 basis-0 flex-col justify-between bg-[#1612F8] p-6 text-white transition-opacity hover:opacity-90"
        >
          <span className="flex items-start justify-between">
            <Avatar account={account} />
            <Corner />
          </span>
          <span className="flex flex-col gap-0.5">
            <span className="text-[17px] leading-6 font-medium tracking-[-0.01em]">Continue as {account.name}</span>
            <span className="text-[13px] leading-[18px] text-white/70">{account.email}</span>
          </span>
        </a>
        <button
          type="button"
          onClick={useAnother}
          disabled={switching}
          className="flex h-[220px] flex-1 basis-0 cursor-pointer flex-col justify-between bg-[#1C1C1C] p-6 text-left transition-colors hover:bg-[#242424] disabled:opacity-60 light:bg-black/5 light:hover:bg-black/10"
        >
          <SignOutIcon />
          <span className="flex flex-col gap-0.5">
            <span className="text-[17px] leading-6 tracking-[-0.01em] text-white/80 light:text-black/80">
              Use a different account
            </span>
            <span className="text-[13px] leading-[18px] text-white/40 light:text-black/50">
              Signs you out of drayhq.com first
            </span>
          </span>
        </button>
      </div>
      {error && <p className={`mt-4 ${ERROR}`}>{error}</p>}
    </>
  );
}

function Avatar({ account }: { account: Account }) {
  const [failed, setFailed] = useState(false);
  if (account.image && !failed)
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={account.image} alt="" referrerPolicy="no-referrer" onError={() => setFailed(true)} className="size-10 rounded-full" />;
  return (
    <span className="flex size-10 items-center justify-center rounded-full bg-white/20 text-[17px] font-medium">
      {(account.name.trim() || account.email).charAt(0).toUpperCase()}
    </span>
  );
}

function Mark() {
  return (
    <svg width="11" height="14" viewBox="0 0 159 200" aria-hidden>
      <path
        fill="currentColor"
        d="M101.004 0C104.603 0 107.52 2.926 107.52 6.536V18.301C107.52 36.349 122.108 50.98 140.102 50.98H152.484C156.083 50.98 159 53.907 159 57.516V142.484C159 146.093 156.083 149.02 152.484 149.02H140.102C122.108 149.02 107.52 163.651 107.52 181.699V193.464C107.52 197.074 104.603 200 101.004 200H0.326C0.146 200 0 199.854 0 199.673V134.967C0 134.787 0.146 134.641 0.326 134.641H61.254C79.249 134.641 93.836 120.009 93.836 101.961V98.039C93.836 79.991 79.249 65.36 61.254 65.36H0.326C0.146 65.36 0 65.213 0 65.033V0.327C0 0.146 0.146 0 0.326 0H101.004Z"
      />
    </svg>
  );
}

function Corner() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden>
      <path d="M7 17 17 7M7 7h10v10" fill="none" stroke="#FFFFFFB3" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function SignOutIcon() {
  return (
    <svg width="28" height="28" viewBox="0 0 24 24" aria-hidden className="text-white/90 light:text-black/80">
      <path d="M9 4H4v16h5M15 8l4 4-4 4M19 12H9" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="square" />
    </svg>
  );
}
