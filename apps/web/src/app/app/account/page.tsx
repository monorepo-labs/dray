import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { AccountForm } from "@/components/account/AccountForm";
import { AppShell } from "@/components/account/AppShell";
import { TITLE } from "@/components/account/styles";
import { listOrgs, requireSession } from "@/lib/session";

export const metadata: Metadata = { title: "Account - Dray" };

/// The reader's own settings, apart from any org's.
export default async function AccountPage() {
  const { user, session } = await requireSession("/app/account");
  const orgs = await listOrgs();
  const org = orgs.find((o) => o.id === session.activeOrganizationId) ?? orgs[0];
  // The bar needs an org to show; `/app` makes one for an account left with none.
  if (!org) redirect("/app");

  return (
    <AppShell org={org} orgs={orgs} user={user}>
      <h1 className={TITLE}>Account</h1>
      <AccountForm user={{ name: user.name, email: user.email, username: user.username ?? "" }} />
    </AppShell>
  );
}
