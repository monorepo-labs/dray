import { useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";

import { CancelOrConfirm } from "@/components/settings/InRowConfirm";
import SettingRow from "@/components/settings/SettingRow";
import { Button } from "@/components/ui/button";
import Spinner from "@/components/ui/spinner";
import { useDrayAccount, useOrgLink } from "@/hooks/useOrgLink";
import { MACHINE } from "@/lib/platform";
import { useLocalServer } from "@/lib/servers";
import { invoke, LOCAL } from "@/lib/transport";
import type { DrayUser } from "@/types/events";

/// The Dray account the app is signed in to (#874). Sign in is This
/// machine's link flow with the app's sign-in riding it, so one page at
/// drayhq.com does both; Sign out forgets the account and leaves the link.
export default function AccountSettings() {
  const local = useLocalServer();
  const connected = local?.status === "connected";
  const account = useDrayAccount(connected);
  const link = useOrgLink(LOCAL, connected);
  const [confirming, setConfirming] = useState(false);
  const pending = link.state?.pending?.signIn ? link.state.pending : null;

  if (account?.user) {
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

  if (pending) {
    return (
      <SettingRow
        id="dray-account"
        asGroup
        label="Waiting for drayhq.com"
        description={
          <>
            Code <span className="font-mono tracking-wider text-foreground">{pending.code}</span>
          </>
        }
      >
        <div className="flex items-center gap-1.5">
          <Button variant="ghost" size="sm" onClick={() => void openUrl(pending.url)}>
            Open again
          </Button>
          <Button variant="ghost" size="sm" onClick={link.cancel}>
            Cancel
          </Button>
        </div>
      </SettingRow>
    );
  }

  return (
    <SettingRow
      id="dray-account"
      label="Dray account"
      description={
        !connected ? (
          `The server on this ${MACHINE} isn't running, so you can't sign in right now.`
        ) : link.error ? (
          <span className="text-destructive">{link.error}</span>
        ) : (
          `Sign in with Google at drayhq.com. This ${MACHINE} joins your org.`
        )
      }
    >
      <Button
        id="dray-account"
        variant="outline"
        size="sm"
        disabled={!connected || account === null}
        onClick={() => void link.start(true)}
      >
        {connected && account === null && <Spinner className="size-3.5" />}
        Sign in
      </Button>
    </SettingRow>
  );
}

/// The Google picture, or the name's first letter where there is none or
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
