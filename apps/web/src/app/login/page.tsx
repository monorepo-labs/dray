import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { AccountChooser } from "@/components/account/AccountChooser";
import { SignInMethods } from "@/components/account/SignInMethods";
import { H1, LEAD, PAGE } from "@/components/account/styles";
import { SiteNav } from "@/components/home/SiteNav";
import { auth } from "@/lib/auth";

export const metadata: Metadata = { title: "Sign in - Dray" };

/// Only a path on this site, so a crafted `?next=` can't send a fresh
/// sign-in somewhere else. `//host` is a path to the browser's eye too.
function safeNext(next: string | string[] | undefined): string {
  return typeof next === "string" && /^\/(?![/\\])/.test(next) ? next : "/app";
}

/// Sign in to Dray with GitHub, Google or email. A reader already signed in
/// goes straight on, unless the desktop app sent them, which asks whether
/// that is the account they want; `via` is the method the app picked.
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string | string[]; via?: string | string[] }>;
}) {
  const params = await searchParams;
  const next = safeNext(params.next);
  const via = typeof params.via === "string" ? params.via : null;
  const fromApp = next.startsWith("/api/app/authorize");
  const github = Boolean(process.env.GITHUB_CLIENT_ID);
  const session = await auth.api.getSession({ headers: await headers() });
  // The desktop app asks which account; the site's own pages just go on.
  if (session && !fromApp) redirect(next);

  if (session)
    return (
      <div data-home className={PAGE}>
        <main className="px-5 pb-[120px] sm:px-8">
          <div className="mx-auto w-full max-w-[960px]">
            <SiteNav bare />
            <AccountChooser
              account={{ name: session.user.name, email: session.user.email, image: session.user.image ?? null }}
              next={next}
              machine={new URLSearchParams(next.split("?")[1] ?? "").get("name")}
              github={github}
            />
          </div>
        </main>
      </div>
    );

  return (
    <div data-home className={PAGE}>
      <main className="px-5 pb-[120px] sm:px-8">
        <div className="mx-auto w-full max-w-[960px]">
          <SiteNav bare />
          <div className="lg:ml-[102px] lg:max-w-[756px]">
            <h1 className={H1}>Sign in to Dray.</h1>
            <p className={LEAD}>
              {fromApp
                ? "Then you're sent straight back to the app."
                : "Your account holds your orgs and the servers linked to them."}
            </p>
            <div className="mt-10">
              <SignInMethods next={next} via={via} github={github} />
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
