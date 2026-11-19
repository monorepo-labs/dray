"use client";

import { useState } from "react";

import { authClient } from "@/lib/auth-client";

import { SignInMethods } from "./SignInMethods";
import { BlueCard, Card, Cards, Heading, Label, SignOutIcon, Spinner } from "./SignInParts";

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
    if (error) return setError(error.message ?? "Couldn't sign out");
    setSignedOut(true);
  };

  if (signedOut) return <SignInMethods next={next} via={null} github={github} />;

  return (
    <>
      {error ? (
        <Label danger>{error}</Label>
      ) : (
        <Label>{machine ? `Signing in to Dray on ${machine}` : "Signing in to Dray"}</Label>
      )}
      <Heading>Continue as {first}?</Heading>
      <Cards>
        <BlueCard
          href={`${next}&confirmed=1`}
          corner
          icon={<Avatar account={account} />}
          label={`Continue as ${account.name}`}
          detail={account.email}
        />
        <Card
          icon={switching ? <Spinner /> : <SignOutIcon />}
          label="Use a different account"
          detail="Signs you out of drayhq.com first"
          disabled={switching}
          onClick={useAnother}
        />
      </Cards>
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
