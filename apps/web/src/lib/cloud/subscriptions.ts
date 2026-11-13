import type Stripe from "stripe";

import { pool } from "../db";
import { prices, stripe } from "../stripe";
import { billingOf, type Billing } from "./billing";
import { PAYING, PLANS, PLAN_IDS, type PlanId } from "./plans";

/// The Stripe side of a Dray Cloud plan: the customer, checkout, plan change,
/// the portal, and mirroring a subscription onto `cloud_billing`.

type Account = { id: string; name: string; email: string };

export const paying =(b: Billing | null) => !!b?.stripeSubscriptionId && PAYING.has(b.status ?? "");

function need(): Stripe {
  const s = stripe();
  if (!s) throw new Error("Billing isn't set up on this site.");
  return s;
}

/// The user's billing row, made with its Stripe customer on first use. The
/// idempotency key makes two first clicks one customer.
async function ensureBilling(user: Account): Promise<Billing> {
  const found = await billingOf(user.id);
  if (found) return found;
  const customer = await need().customers.create(
    { name: user.name, email: user.email, metadata: { userId: user.id } },
    { idempotencyKey: `dray-cloud-customer-${user.id}` },
  );
  // Better Auth's schema defaults live in its adapter, not the table, so a
  // raw insert names every not-null column.
  await pool.query(
    `insert into cloud_billing (id, "userId", "stripeCustomerId", "cancelAtPeriodEnd", overage, "reportedMinutes")
     values ($1, $2, $3, false, false, 0)
     on conflict do nothing`,
    [crypto.randomUUID(), user.id, customer.id],
  );
  return (await billingOf(user.id))!;
}

/// Where to send the reader to subscribe: a Checkout page for a user with no
/// paying plan. One already paying is moved to `plan` in place instead, and
/// answers null.
export async function subscribe(
  user: Account,
  plan: PlanId,
  returnTo: string,
): Promise<string | null> {
  const billing = await ensureBilling(user);
  if (paying(billing)) {
    await changePlan(billing, plan);
    return null;
  }
  const s = need();
  const { plans, overage } = await prices(s);
  const session = await s.checkout.sessions.create({
    mode: "subscription",
    customer: billing.stripeCustomerId,
    client_reference_id: user.id,
    // The overage price rides every subscription, so turning overage on later
    // needs no change in Stripe; a user who never goes over is billed nothing on it.
    line_items: [{ price: plans[plan], quantity: 1 }, { price: overage }],
    subscription_data: { metadata: { userId: user.id } },
    allow_promotion_codes: true,
    success_url: `${returnTo}?checkout=done`,
    cancel_url: returnTo,
  });
  if (!session.url) throw new Error("Stripe gave no checkout page.");
  return session.url;
}

/// Swaps the plan's price on the subscription, prorated. The included hours
/// change at once, since `standing` reads the plan the row holds now.
async function changePlan(billing: Billing, plan: PlanId) {
  const s = need();
  const { plans } = await prices(s);
  const sub = await s.subscriptions.retrieve(billing.stripeSubscriptionId!);
  const item = sub.items.data.find((i) => planOf(i.price.lookup_key));
  if (!item) throw new Error("This subscription has no Dray Cloud plan on it.");
  if (item.price.id === plans[plan]) return;
  const updated = await s.subscriptions.update(sub.id, {
    items: [{ id: item.id, price: plans[plan] }],
    proration_behavior: "create_prorations",
  });
  await mirror(updated);
}

/// A Stripe customer portal page for card, invoices and cancelling.
export async function portal(userId: string, returnTo: string): Promise<string> {
  const billing = await billingOf(userId);
  if (!billing) throw new Error("You have no billing yet.");
  const s = need();
  const session = await s.billingPortal.sessions.create({
    customer: billing.stripeCustomerId,
    return_url: returnTo,
    configuration: await portalConfiguration(s),
  });
  return session.url;
}

const held = globalThis as { drayPortalConfig?: Promise<string | undefined> };

/// The portal configuration `scripts/stripe-setup.mjs` made, found by its
/// metadata, else Stripe's default.
function portalConfiguration(s: Stripe) {
  held.drayPortalConfig ??= s.billingPortal.configurations
    .list({ active: true, limit: 100 })
    .then(({ data }) => data.find((c) => c.metadata?.dray === "cloud")?.id)
    .catch((e) => {
      held.drayPortalConfig = undefined;
      throw e;
    });
  return held.drayPortalConfig;
}

const planOf = (lookupKey: string | null): PlanId | null =>
  PLAN_IDS.find((p) => PLANS[p].lookupKey === lookupKey) ?? null;

/// Webhook entry: reads the subscription fresh rather than trusting the
/// event's copy, since Stripe can deliver an older event after a newer one.
export async function syncSubscription(id: string) {
  await mirror(await need().subscriptions.retrieve(id));
}

/// Writes a subscription onto its customer's row. A customer can briefly hold
/// two (a second checkout racing the first), and a row already following one
/// that pays is never moved onto one that doesn't.
async function mirror(sub: Stripe.Subscription) {
  const customer = typeof sub.customer === "string" ? sub.customer : sub.customer.id;
  const item = sub.items.data.find((i) => planOf(i.price.lookup_key)) ?? sub.items.data[0];
  const pays = PAYING.has(sub.status);
  await pool.query(
    `update cloud_billing set
       "stripeSubscriptionId" = $1, plan = $2, status = $3,
       "periodStart" = $4, "periodEnd" = $5, "cancelAtPeriodEnd" = $6
     where "stripeCustomerId" = $7
       and ("stripeSubscriptionId" is null or "stripeSubscriptionId" = $1 or $8::boolean
            or status is null or status not in ('active', 'trialing', 'past_due'))`,
    [
      sub.id,
      item ? planOf(item.price.lookup_key) : null,
      sub.status,
      item ? new Date(item.current_period_start * 1000) : null,
      item ? new Date(item.current_period_end * 1000) : null,
      sub.cancel_at_period_end || sub.cancel_at != null,
      customer,
      pays,
    ],
  );
}

/// Owner's overage switch and cap. A cap of null is no cap.
export async function setOverage(userId: string, on: boolean, capCents: number | null) {
  await pool.query(`update cloud_billing set overage = $1, "overageCapCents" = $2 where "userId" = $3`, [
    on,
    capCents,
    userId,
  ]);
}
