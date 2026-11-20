import { useState } from "react";
import { ChevronsUpDown, Mail } from "lucide-react";

import { markSignOut } from "@/components/AccountGate";
import GitHubIcon from "@/components/GitHubIcon";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useDrayAccount, useOrgLink } from "@/hooks/useOrgLink";
import { MACHINE } from "@/lib/platform";
import { useLocalServer } from "@/lib/servers";
import { invoke, LOCAL } from "@/lib/transport";
import { cn } from "@/lib/utils";
import type { DrayUser } from "@/types/events";

/// The account's picture, or its initials where there is none or it fails to
/// load: first and last name. Size it with `size-*` alone; the letters scale
/// with the circle.
function AccountAvatar({ user, className }: { user: DrayUser; className?: string }) {
  const [failed, setFailed] = useState(false);
  if (user.image && !failed) {
    return (
      <img
        src={user.image}
        alt=""
        referrerPolicy="no-referrer"
        onError={() => setFailed(true)}
        className={cn("size-8 shrink-0 rounded-full object-cover", className)}
      />
    );
  }
  // SVG so the baseline is placed by hand: a centred line box puts the caps
  // wherever the engine's ascent and descent say, which drifted on macOS.
  // 0.355 is half Geist's 710/1000 cap height, so the capitals sit at centre.
  return (
    <svg aria-hidden viewBox="0 0 100 100" className={cn("size-8 shrink-0 select-none", className)}>
      <circle cx="50" cy="50" r="50" className="fill-muted-foreground" />
      <text
        x="50"
        y={50 + 0.355 * INITIALS_SIZE}
        textAnchor="middle"
        fontSize={INITIALS_SIZE}
        className="fill-background font-sans font-medium"
      >
        {initials(user.name)}
      </text>
    </svg>
  );
}

/// The letters' size against a 100-unit circle.
const INITIALS_SIZE = 40;

function initials(name: string) {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return "?";
  const first = words[0].charAt(0);
  const last = words.length > 1 ? words[words.length - 1].charAt(0) : "";
  return (first + last).toUpperCase();
}

/// Google's mark in its own colours, which is how the sign-in gate draws it.
function GoogleIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 48 48" className={cn("size-4 shrink-0", className)} role="img" aria-label="Google">
      <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 13 4 4 13 4 24s9 20 20 20 20-9 20-20c0-1.3-.1-2.4-.4-3.5z" />
      <path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
      <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z" />
      <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z" />
    </svg>
  );
}

/// The sign-ins the site reports. An account with neither signed in with
/// email, the only other way in.
const PROVIDERS = [
  { id: "github", label: "GitHub", Icon: GitHubIcon },
  { id: "google", label: "Google", Icon: GoogleIcon },
];
const EMAIL = { id: "email", label: "email", Icon: Mail };

/// The Dray account the app is signed in to (#874, #1277, #1314), at the top
/// of Settings' list: picture or initials, name and email. Its menu says how
/// the account signs in and offers Sign out, which forgets the account,
/// leaves this machine's link alone, and lands on the sign-in gate. Draws
/// nothing while signed out, which happens after Skip for now offline and in a
/// dev build, which has no gate.
export default function AccountCard() {
  const local = useLocalServer();
  const connected = local?.status === "connected";
  const user = useDrayAccount(connected)?.user;
  const linked = !!useOrgLink(LOCAL, connected).state?.linked;
  const [asking, setAsking] = useState(false);
  if (!user) return null;
  // A local server still on the previous build, waiting for its turns to end
  // before it restarts, sends no `providers` at all.
  const linkedIds = user.providers ?? [];
  const social = PROVIDERS.filter((p) => linkedIds.includes(p.id));
  const ways = social.length ? social : [EMAIL];
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="mb-3 flex w-full cursor-pointer items-center gap-2 rounded-lg px-1.5 py-1.5 text-left transition-colors hover:bg-(--fill-soft,var(--sidebar-accent)) data-[state=open]:bg-(--fill-soft,var(--sidebar-accent))"
          >
            <AccountAvatar user={user} className="size-7" />
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-ui font-medium text-foreground">{user.name}</span>
              {user.email && <span className="truncate text-xs text-muted-foreground">{user.email}</span>}
            </div>
            <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" />
          </button>
        </DropdownMenuTrigger>
        {/* The row already says who; the menu says only how, and the way out. */}
        <DropdownMenuContent align="start" className="w-(--radix-dropdown-menu-trigger-width)">
          <DropdownMenuLabel className="flex items-center gap-2 font-normal text-muted-foreground">
            <span className="flex shrink-0 items-center gap-1">
              {ways.map((w) => (
                <w.Icon key={w.id} className="size-3.5" />
              ))}
            </span>
            <span className="truncate">Signed in with {ways.map((w) => w.label).join(" and ")}</span>
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => setAsking(true)}>Sign out…</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <AlertDialog open={asking} onOpenChange={setAsking}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Sign out of Dray?</AlertDialogTitle>
            <AlertDialogDescription>
              You'll need to sign in again to use Dray.{linked && ` This ${MACHINE} stays linked.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              destructive
              onClick={() => {
                markSignOut();
                void invoke("account_sign_out", {}, LOCAL).catch(console.error);
              }}
            >
              Sign out
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
