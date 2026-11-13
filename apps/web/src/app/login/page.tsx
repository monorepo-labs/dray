import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { GoogleButton } from "@/components/account/GoogleButton";
import { H1, LEAD, PAGE } from "@/components/account/styles";
import { SiteNav } from "@/components/home/SiteNav";
import { auth } from "@/lib/auth";

export const metadata: Metadata = { title: "Sign in - Dray" };

/// Only a path on this site, so a crafted `?next=` can't send a fresh
/// sign-in somewhere else. `//host` is a path to the browser's eye too.
function safeNext(next: string | string[] | undefined): string {
  return typeof next === "string" && /^\/(?![/\\])/.test(next) ? next : "/app";
}

/// Sign in to Dray with Google. A reader already signed in goes straight on.
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string | string[] }>;
}) {
  const next = safeNext((await searchParams).next);
  if (await auth.api.getSession({ headers: await headers() })) redirect(next);

  return (
    <div data-home className={PAGE}>
      <main className="px-5 pb-[120px] sm:px-8">
        <div className="mx-auto w-full max-w-[960px]">
          <SiteNav bare />
          <div className="lg:ml-[102px] lg:max-w-[756px]">
            <h1 className={H1}>Sign in to Dray.</h1>
            <p className={LEAD}>Your account holds your orgs and the servers linked to them.</p>
            <div className="mt-10">
              <GoogleButton next={next} />
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
