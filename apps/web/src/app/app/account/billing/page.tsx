import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { AppShell } from "@/components/account/AppShell";
import { BillingPanel } from "@/components/account/BillingPanel";
import { LEAD, TITLE } from "@/components/account/styles";
import { standingOf } from "@/lib/cloud/billing";
import { paying } from "@/lib/cloud/subscriptions";
import { listOrgs, requireSession } from "@/lib/session";
import { stripe } from "@/lib/stripe";

export const metadata: Metadata = { title: "Billing - Dray" };

/// The reader's own Dray Cloud plan: hours used this period, plans, overage,
/// and the way into Stripe's portal. A plan belongs to the account, not an org.
export default async function BillingPage({ searchParams }: { searchParams: Promise<{ checkout?: string }> }) {
  const { user, session } = await requireSession("/app/account/billing");
  const orgs = await listOrgs();
  const org = orgs.find((o) => o.id === session.activeOrganizationId) ?? orgs[0];
  // The bar needs an org to show; `/app` makes one for an account left with none.
  if (!org) redirect("/app");
  const { checkout } = await searchParams;
  const { billing, standing } = await standingOf(user.id);
  const date = (d: Date | null) =>
    d ? d.toLocaleDateString("en-US", { dateStyle: "medium", timeZone: "UTC" }) : null;

  return (
    <AppShell org={org} orgs={orgs} user={user}>
      <h1 className={TITLE}>Billing</h1>
      <p className={LEAD}>
        Dray Cloud runs each task on a machine of its own and bills only the hours it is awake. Agents use your own
        Claude or Codex subscription.
      </p>
      <BillingPanel
        configured={!!stripe()}
        awaitingCheckout={checkout === "done" && !paying(billing)}
        current={
          paying(billing) && standing.plan
            ? {
                plan: standing.plan,
                status: billing!.status!,
                renews: date(billing!.periodEnd),
                cancels: billing!.cancelAtPeriodEnd,
                usedSeconds: standing.usedSeconds,
                billableMinutes: standing.billableMinutes,
                overage: billing!.overage,
                overageCapCents: billing!.overageCapCents,
              }
            : null
        }
      />
    </AppShell>
  );
}
