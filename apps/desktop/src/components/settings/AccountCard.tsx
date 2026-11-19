import { useState } from "react";
import { ChevronsUpDown } from "lucide-react";

import { markSignOut } from "@/components/AccountGate";
import { CancelOrConfirm } from "@/components/settings/InRowConfirm";
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
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useLocalStorage } from "@/hooks/useLocalStorage";
import { useDrayAccount, useOrgLink } from "@/hooks/useOrgLink";
import { MACHINE } from "@/lib/platform";
import { useLocalServer } from "@/lib/servers";
import { invoke, LOCAL } from "@/lib/transport";
import { cn } from "@/lib/utils";
import type { DrayUser } from "@/types/events";

/// Where the account shows in Settings, while the Apple-style card is being
/// tried out (`tab` is today's Account tab). Picked from a dev-only switch.
export type AccountCardVariant = "tab" | "sidebar" | "page" | "menu";

export const ACCOUNT_CARD_VARIANTS: { id: AccountCardVariant; label: string }[] = [
  { id: "tab", label: "Tab" },
  { id: "sidebar", label: "Sidebar" },
  { id: "page", label: "Page" },
  { id: "menu", label: "Menu" },
];

export function useAccountCardVariant() {
  const [variant, setVariant] = useLocalStorage<AccountCardVariant>("dray.dev.accountCard", "tab");
  return [import.meta.env.DEV ? variant : "tab", setVariant] as const;
}

/// The signed-in account, and whether this machine stays linked after Sign out.
function useAccount() {
  const local = useLocalServer();
  const connected = local?.status === "connected";
  const account = useDrayAccount(connected);
  const link = useOrgLink(LOCAL, connected);
  return { user: account?.user ?? null, linked: !!link.state?.linked };
}

function signOut() {
  markSignOut();
  void invoke("account_sign_out", {}, LOCAL).catch(console.error);
}

/// The account's picture, or its initials where there is none or it fails to
/// load: first and last name, on Apple's grey monogram.
export function AccountAvatar({ user, className }: { user: DrayUser; className?: string }) {
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
  return (
    <span
      aria-hidden
      className={cn(
        "flex size-8 shrink-0 items-center justify-center rounded-full bg-linear-to-b from-[#a9aeb8] to-[#868b95] font-medium text-white select-none",
        className,
      )}
    >
      {initials(user.name)}
    </span>
  );
}

function initials(name: string) {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return "?";
  const first = words[0].charAt(0);
  const last = words.length > 1 ? words[words.length - 1].charAt(0) : "";
  return (first + last).toUpperCase();
}

/// Name over email, both truncating, for a row too narrow to wrap.
function NameAndEmail({ user, big = false }: { user: DrayUser; big?: boolean }) {
  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <span className={cn("truncate font-medium text-foreground", big ? "text-base" : "text-ui")}>{user.name}</span>
      {user.email && (
        <span className={cn("truncate text-muted-foreground", big ? "text-ui" : "text-xs")}>{user.email}</span>
      )}
    </div>
  );
}

/// Sign out, asked in place: the button gives way to Cancel and Sign out.
function SignOutInPlace({ linked, className, wide = false }: { linked: boolean; className?: string; wide?: boolean }) {
  const [confirming, setConfirming] = useState(false);
  if (!confirming)
    return (
      <Button variant="outline" size="sm" className={cn(wide && "w-full", className)} onClick={() => setConfirming(true)}>
        Sign out
      </Button>
    );
  return (
    <div className={cn("flex flex-col gap-1.5", wide ? "items-stretch" : "items-center", className)}>
      {linked && <span className="text-xs text-muted-foreground">This {MACHINE} stays linked.</span>}
      <CancelOrConfirm
        verb="Sign out"
        autoFocus
        className={cn(wide && "[&>button]:flex-1")}
        onCancel={() => setConfirming(false)}
        onConfirm={() => {
          setConfirming(false);
          signOut();
        }}
      />
    </div>
  );
}

/// Variant A: a card at the top of Settings' list, where macOS puts the
/// Apple Account, with Sign out right under the name.
export function SidebarAccountCard() {
  const { user, linked } = useAccount();
  if (!user) return null;
  return (
    <div className="mb-3 flex flex-col gap-2.5 rounded-xl bg-card p-2.5">
      <div className="flex items-center gap-2.5">
        <AccountAvatar user={user} className="size-9 text-sm" />
        <NameAndEmail user={user} />
      </div>
      <SignOutInPlace linked={linked} wide />
    </div>
  );
}

/// Variant B: the account heading the first page, picture large and
/// centred as on the Apple Account page.
export function PageAccountCard() {
  const { user, linked } = useAccount();
  if (!user) return null;
  return (
    <section className="flex flex-col items-center gap-3 rounded-xl border border-border/60 bg-card px-6 py-6 text-center">
      <AccountAvatar user={user} className="size-16 text-2xl" />
      <div className="flex flex-col gap-0.5">
        <span className="text-base font-medium text-foreground">{user.name}</span>
        {user.email && <span className="text-ui text-muted-foreground">{user.email}</span>}
      </div>
      <SignOutInPlace linked={linked} />
    </section>
  );
}

/// Variant C: one compact row at the top of Settings' list; Sign out lives
/// in the menu it opens, and asks before it acts.
export function MenuAccountCard() {
  const { user, linked } = useAccount();
  const [asking, setAsking] = useState(false);
  if (!user) return null;
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="mb-3 flex w-full cursor-pointer items-center gap-2 rounded-lg px-1.5 py-1.5 text-left transition-colors hover:bg-(--fill-soft,var(--sidebar-accent)) data-[state=open]:bg-(--fill-soft,var(--sidebar-accent))"
          >
            <AccountAvatar user={user} className="size-7 text-xs" />
            <NameAndEmail user={user} />
            <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-(--radix-dropdown-menu-trigger-width)">
          <DropdownMenuLabel className="flex items-center gap-2 py-1.5">
            <AccountAvatar user={user} className="size-8 text-xs" />
            <NameAndEmail user={user} />
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
            <AlertDialogAction destructive onClick={signOut}>
              Sign out
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

/// Dev builds only: which account variant Settings draws.
export function AccountCardSwitch({
  value,
  onChange,
}: {
  value: AccountCardVariant;
  onChange: (next: AccountCardVariant) => void;
}) {
  if (!import.meta.env.DEV) return null;
  return (
    <div className="mt-auto mb-3 flex flex-col gap-1 px-1.5">
      <span className="text-xs text-muted-foreground">Account card (dev)</span>
      <div role="radiogroup" aria-label="Account card" className="flex rounded-lg bg-(--surface-well) p-0.5">
        {ACCOUNT_CARD_VARIANTS.map((v) => (
          <button
            key={v.id}
            type="button"
            role="radio"
            aria-checked={value === v.id}
            onClick={() => onChange(v.id)}
            className={cn(
              "flex-1 cursor-pointer rounded-md py-0.5 text-xs transition-colors",
              value === v.id
                ? "bg-(--surface-thumb) text-foreground shadow-(--shadow-button)"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {v.label}
          </button>
        ))}
      </div>
    </div>
  );
}
