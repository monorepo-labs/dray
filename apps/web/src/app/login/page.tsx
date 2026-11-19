import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { AccountChooser } from "@/components/account/AccountChooser";
import { Heading, Label, SignInShell } from "@/components/account/SignInParts";
import { SignInMethods } from "@/components/account/SignInMethods";
import { auth } from "@/lib/auth";

export const metadata: Metadata = { title: "Sign in - Dray" };

/// Only a path on this site, so a crafted `?next=` can't send a fresh
/// sign-in somewhere else. `//host` is a path to the browser's eye too.
function safeNext(next: string | string[] | undefined): string {
  return typeof next === "string" && /^\/(?![/\\])/.test(next) ? next : "/app";
}

/// What a failed try says. Better Auth sends its own codes here
/// (`onAPIError.errorURL`); `broken_link` is `/api/app/authorize`'s.
function problemFor(error: string | string[] | undefined): string | null {
  if (typeof error !== "string") return null;
  if (error === "access_denied") return "Sign-in was cancelled";
  if (/state|restart|expired/i.test(error)) return "That sign-in expired";
  return "Sign-in didn't work";
}

/// Sign in to Dray with GitHub, Google or email. A reader already signed in
/// goes straight on, unless the desktop app sent them, which asks whether
/// that is the account they want; `via` is the method the app picked.
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string | string[]; via?: string | string[]; error?: string | string[] }>;
}) {
  const params = await searchParams;
  const next = safeNext(params.next);
  const via = typeof params.via === "string" ? params.via : null;
  const fromApp = next.startsWith("/api/app/authorize");
  const github = Boolean(process.env.GITHUB_CLIENT_ID);

  if (params.error === "broken_link")
    return (
      <SignInShell>
        <Label danger>This sign-in link is broken</Label>
        <Heading>Start again from Dray.</Heading>
      </SignInShell>
    );

  const session = await auth.api.getSession({ headers: await headers() });
  // The desktop app asks which account; the site's own pages just go on.
  if (session && !fromApp) redirect(next);

  return (
    <SignInShell>
      {session ? (
        <AccountChooser
          account={{ name: session.user.name, email: session.user.email, image: session.user.image ?? null }}
          next={next}
          machine={new URLSearchParams(next.split("?")[1] ?? "").get("name")}
          github={github}
        />
      ) : (
        <SignInMethods next={next} via={via} github={github} problem={problemFor(params.error)} />
      )}
    </SignInShell>
  );
}
