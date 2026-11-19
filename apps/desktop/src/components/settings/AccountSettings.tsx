import { useState } from "react";

import { markSignOut } from "@/components/AccountGate";
import { CancelOrConfirm } from "@/components/settings/InRowConfirm";
import { Button } from "@/components/ui/button";
import { useDrayAccount, useOrgLink } from "@/hooks/useOrgLink";
import { MACHINE } from "@/lib/platform";
import { useLocalServer } from "@/lib/servers";
import { invoke, LOCAL } from "@/lib/transport";
import type { DrayUser } from "@/types/events";

/// The Dray account the app is signed in to (#874, #1277). Signing in happens
/// on the gate before the app opens, so this tab shows who and offers Sign
/// out, which forgets the account and leaves this machine's link alone.
export default function AccountSettings() {
  const local = useLocalServer();
  const connected = local?.status === "connected";
  const account = useDrayAccount(connected);
  const link = useOrgLink(LOCAL, connected);
  const [confirming, setConfirming] = useState(false);

  if (!account?.user)
    // Reached only after Skip for now offline; the gate is back once online.
    return (
      <div className="flex flex-col gap-1">
        <span className="text-ui font-medium">Not signed in</span>
        <span className="text-ui text-muted-foreground">Dray asks you to sign in as soon as it can reach drayhq.com.</span>
      </div>
    );

  return (
    <div className="flex min-h-9 items-center gap-3">
      <Avatar user={account.user} />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-ui font-medium">{account.user.name}</span>
        {account.user.username && (
          <span className="truncate text-ui text-muted-foreground">@{account.user.username}</span>
        )}
      </div>
      {confirming ? (
        <CancelOrConfirm
          verb="Sign out"
          autoFocus
          onCancel={() => setConfirming(false)}
          onConfirm={() => {
            setConfirming(false);
            markSignOut();
            void invoke("account_sign_out", {}, LOCAL).catch(console.error);
          }}
        >
          {link.state?.linked && <span className="text-ui text-muted-foreground">This {MACHINE} stays linked.</span>}
        </CancelOrConfirm>
      ) : (
        <Button variant="outline" size="sm" onClick={() => setConfirming(true)}>
          Sign out
        </Button>
      )}
    </div>
  );
}

/// The account's picture, or the name's first letter where there is none or
/// it fails to load.
function Avatar({ user }: { user: DrayUser }) {
  const [failed, setFailed] = useState(false);
  if (user.image && !failed) {
    return (
      <img
        src={user.image}
        alt=""
        referrerPolicy="no-referrer"
        onError={() => setFailed(true)}
        className="size-8 shrink-0 rounded-full"
      />
    );
  }
  return (
    <span
      aria-hidden
      className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-ui font-medium text-muted-foreground"
    >
      {user.name.trim().charAt(0).toUpperCase() || "?"}
    </span>
  );
}
