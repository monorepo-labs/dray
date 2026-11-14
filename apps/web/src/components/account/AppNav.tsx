"use client";

import { Check, ChevronDown, Plus } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";

import { SchemeToggle } from "@/components/home/SchemeToggle";
import { Wordmark } from "@/components/Wordmark";
import { authClient } from "@/lib/auth-client";

import { MENU_ITEM, Menu } from "./Menu";
import { CELL, MUTED } from "./styles";

type Org = { id: string; name: string; slug: string };
type User = { name: string; email: string; image?: string | null };

/// The account pages' bar: wordmark, then the org switcher, scheme and the
/// reader's own menu in the site's cells.
export function AppNav({ org, orgs, user }: { org: Org; orgs: Org[]; user: User }) {
  const router = useRouter();

  const signOut = async () => {
    await authClient.signOut();
    router.push("/");
    router.refresh();
  };

  return (
    <nav aria-label="Account" className="flex h-10 items-start justify-between">
      <Link href="/" aria-label="Dray home" className="flex h-10 w-[120px] items-center pl-4">
        <Wordmark className="h-[11px] w-auto text-white light:text-[#0A0A0A]" />
      </Link>
      <div className="flex h-10 border-r border-b border-white/20 light:border-black/15">
        <Menu
          label="Switch org"
          className={`${CELL} max-w-[150px] sm:max-w-[220px]`}
          trigger={
            <>
              <span className="truncate">{org.name}</span>
              <ChevronDown className="size-3 shrink-0" />
            </>
          }
        >
          {orgs.map((o) => (
            <Link key={o.id} href={`/app/${o.slug}/servers`} className={MENU_ITEM}>
              <span className="truncate">{o.name}</span>
              {o.id === org.id && <Check className="size-3.5 shrink-0" />}
            </Link>
          ))}
          <div className="my-1 border-t border-white/20 light:border-black/15" />
          <Link href="/app/new" className={MENU_ITEM}>
            New org
            <Plus className="size-3.5 shrink-0" />
          </Link>
        </Menu>
        <SchemeToggle className={`${CELL} flex w-10 cursor-pointer px-0!`} />
        <Menu label="Account" className={`${CELL} w-10 px-0!`} trigger={<Avatar user={user} />}>
          <div className="px-4 py-2">
            <p className="truncate text-[14px]">{user.name}</p>
            <p className={`truncate text-[13px] ${MUTED}`}>{user.email}</p>
          </div>
          <div className="my-1 border-t border-white/20 light:border-black/15" />
          <Link href="/app/account" className={MENU_ITEM}>
            Account settings
          </Link>
          <Link href="/app/account/billing" className={MENU_ITEM}>
            Billing
          </Link>
          <button type="button" onClick={signOut} className={MENU_ITEM}>
            Sign out
          </button>
        </Menu>
      </div>
    </nav>
  );
}

export function Avatar({ user, size = 20 }: { user: User; size?: number }) {
  if (user.image)
    // Google's own avatar host; next/image would need it allow-listed for nothing gained at 20px.
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={user.image} alt="" width={size} height={size} referrerPolicy="no-referrer" className="rounded-full" />;
  return (
    <span
      style={{ width: size, height: size }}
      className="flex items-center justify-center rounded-full bg-white/20 text-[10px] light:bg-black/10"
    >
      {user.name.slice(0, 1).toUpperCase()}
    </span>
  );
}

/// Servers, Members, Settings: the org's pages, as a strip of cells.
export function OrgTabs({ slug }: { slug: string }) {
  const path = usePathname();
  const tabs = ["servers", "members", "settings"];
  return (
    <div className="flex h-10 w-fit border-y border-r border-white/20 light:border-black/15">
      {tabs.map((tab) => {
        const href = `/app/${slug}/${tab}`;
        const here = path === href;
        return (
          <Link
            key={tab}
            href={href}
            aria-current={here ? "page" : undefined}
            className={`${CELL} flex ${here ? "bg-white/10 light:bg-black/5" : "text-[#7C7C7C]! light:text-[#8A8A8A]!"}`}
          >
            {tab}
          </Link>
        );
      })}
    </div>
  );
}
