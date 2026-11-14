import type Stripe from "stripe";

import { pool, withLock } from "../db";
import { prices, stripe } from "../stripe";
import { billingOf, finishPeriod, type Billing } from "./billing";
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
  const s = need();
  let billing = await ensureBilling(user);
  // A subscription the webhook hasn't mirrored yet still counts, or a second
  // click right after paying would sell a second plan.
  if (!paying(billing)) {
    const { data } = await s.subscriptions.list({ customer: billing.stripeCustomerId, status: "all", limit: 10 });
    const live = data.find((sub) => PAYING.has(sub.status));
    if (live) {
      await syncSubscription(live.id);
      billing = (await billingOf(user.id))!;
    }
  }
  if (paying(billing)) {
    await changePlan(billing, plan);
    return null;
  }
  // One Checkout open at a time: a page left open in another tab is expired,
  // so paying twice for one account takes two fresh starts, not two tabs.
  const open = await s.checkout.sessions.list({ customer: billing.stripeCustomerId, status: "open", limit: 10 });
  await Promise.all(open.data.map((c) => s.checkout.sessions.expire(c.id)));
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
  await s.subscriptions.update(sub.id, {
    items: [{ id: item.id, price: plans[plan] }],
    proration_behavior: "create_prorations",
  });
  await syncSubscription(sub.id);
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

/// Mirrors a subscription onto its customer's row, for the webhook and a plan
/// change alike. The read from Stripe happens inside a per-customer lock, so
/// two events racing can't land an older state over a newer one.
export async function syncSubscription(id: string) {
  const s = need();
  const first = await s.subscriptions.retrieve(id);
  const customer = typeof first.customer === "string" ? first.customer : first.customer.id;
  await withLock(`dray-cloud-billing:${customer}`, async () =>
    mirror(s, await s.subscriptions.retrieve(id), customer),
  );
}

async function mirror(s: Stripe, sub: Stripe.Subscription, customer: string) {
  const billing = await billingOfCustomer(customer);
  if (!billing) return;
  const pays = PAYING.has(sub.status);
  if (billing.stripeSubscriptionId && billing.stripeSubscriptionId !== sub.id && paying(billing)) {
    if (!pays) return;
    // Two paying plans on one account: keep the one already followed, while
    // Stripe still says it pays, and cancel the newcomer with its proration
    // credited back.
    const followed = await s.subscriptions.retrieve(billing.stripeSubscriptionId);
    if (PAYING.has(followed.status)) {
      console.error(`cancelling duplicate subscription ${sub.id} on ${customer}`);
      await s.subscriptions.cancel(sub.id, { prorate: true });
      return;
    }
  }
  const item = sub.items.data.find((i) => planOf(i.price.lookup_key)) ?? sub.items.data[0];
  const periodStart = item ? new Date(item.current_period_start * 1000) : null;
  if (billing.periodStart && periodStart && periodStart.getTime() !== billing.periodStart.getTime()) {
    // The old period's last stretch is only readable while the row still
    // names it; once moved on, every read starts at the new period.
    await finishPeriod(billing.userId).catch((e) => console.error(`finishing period ${billing.userId}:`, e));
  }
  await pool.query(
    `update cloud_billing set
       "stripeSubscriptionId" = $1, plan = $2, status = $3,
       "periodStart" = $4, "periodEnd" = $5, "cancelAtPeriodEnd" = $6
     where id = $7`,
    [
      sub.id,
      item ? planOf(item.price.lookup_key) : null,
      sub.status,
      periodStart,
      item ? new Date(item.current_period_end * 1000) : null,
      sub.cancel_at_period_end || sub.cancel_at != null,
      billing.id,
    ],
  );
}

async function billingOfCustomer(customer: string): Promise<Billing | null> {
  const { rows } = await pool.query<Billing>(`select * from cloud_billing where "stripeCustomerId" = $1`, [customer]);
  return rows[0] ?? null;
}

/// Owner's overage switch and cap. A cap of null is no cap.
export async function setOverage(userId: string, on: boolean, capCents: number | null) {
  await pool.query(`update cloud_billing set overage = $1, "overageCapCents" = $2 where "userId" = $3`, [
    on,
    capCents,
    userId,
  ]);
}
