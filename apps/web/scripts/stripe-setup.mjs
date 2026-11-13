#!/usr/bin/env node
// Creates what Dray Cloud billing needs in a Stripe account, and finds what
// is already there, so running it twice changes nothing:
//
//   STRIPE_SECRET_KEY=sk_test_… node scripts/stripe-setup.mjs [--webhook-url https://…/api/billing/webhook]
//
// A live key is refused unless --live is passed. Prints the env lines to set.

import Stripe from "stripe";

import { METER_EVENT, OVERAGE_CENTS_PER_HOUR, OVERAGE_LOOKUP_KEY, PLANS } from "../src/lib/cloud/plans.ts";

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? null : (args[i + 1] ?? "");
};
const key = process.env.STRIPE_SECRET_KEY;
if (!key) throw new Error("Set STRIPE_SECRET_KEY.");
if (key.startsWith("sk_live_") && !args.includes("--live")) throw new Error("That is a live key. Pass --live if you mean it.");

const api = process.env.STRIPE_API_URL ? new URL(process.env.STRIPE_API_URL) : null;
const stripe = new Stripe(key, api ? { host: api.hostname, port: Number(api.port), protocol: api.protocol.slice(0, -1) } : {});
const say = (what, obj, made) => console.log(`${made ? "made " : "found"} ${what}: ${obj.id}`);

async function price(lookupKey, productName, params) {
  const { data } = await stripe.prices.list({ lookup_keys: [lookupKey], active: true, limit: 1 });
  if (data[0]) return say(lookupKey, data[0], false);
  const made = await stripe.prices.create({
    currency: "usd",
    lookup_key: lookupKey,
    product_data: { name: productName, metadata: { dray: "cloud" } },
    ...params,
  });
  say(lookupKey, made, true);
}

for (const plan of Object.values(PLANS)) {
  await price(plan.lookupKey, `Dray Cloud ${plan.name}`, {
    unit_amount: plan.dollars * 100,
    recurring: { interval: "month" },
  });
}

const meters = await stripe.billing.meters.list({ status: "active", limit: 100 });
let meter = meters.data.find((m) => m.event_name === METER_EVENT);
if (meter) say("meter", meter, false);
else {
  meter = await stripe.billing.meters.create({
    display_name: "Dray Cloud overage minutes",
    event_name: METER_EVENT,
    default_aggregation: { formula: "sum" },
    customer_mapping: { type: "by_id", event_payload_key: "stripe_customer_id" },
    value_settings: { event_payload_key: "value" },
  });
  say("meter", meter, true);
}

// Billed per minute: Stripe holds fractional cents to 12 places and rounds the
// line's total, so 60 minutes at a third of a cent invoice as $0.20.
await price(OVERAGE_LOOKUP_KEY, "Dray Cloud overage", {
  unit_amount_decimal: (OVERAGE_CENTS_PER_HOUR / 60).toFixed(12),
  recurring: { interval: "month", usage_type: "metered", meter: meter.id },
});

const configs = await stripe.billingPortal.configurations.list({ active: true, limit: 100 });
let portal = configs.data.find((c) => c.metadata?.dray === "cloud");
if (portal) say("portal configuration", portal, false);
else {
  // No plan switching here: Stripe's portal can't change a subscription with
  // more than one price, and every Dray Cloud one carries the overage price.
  // Plans switch on drayhq.com instead.
  portal = await stripe.billingPortal.configurations.create({
    metadata: { dray: "cloud" },
    business_profile: { headline: "Dray Cloud" },
    features: {
      customer_update: { enabled: true, allowed_updates: ["email", "name", "address", "tax_id"] },
      invoice_history: { enabled: true },
      payment_method_update: { enabled: true },
      subscription_cancel: { enabled: true, mode: "at_period_end" },
    },
  });
  say("portal configuration", portal, true);
}

const webhookUrl = flag("--webhook-url");
let webhookSecret = null;
if (webhookUrl) {
  const { data } = await stripe.webhookEndpoints.list({ limit: 100 });
  const found = data.find((w) => w.url === webhookUrl);
  if (found) say("webhook (its secret was shown when made)", found, false);
  else {
    const made = await stripe.webhookEndpoints.create({
      url: webhookUrl,
      enabled_events: [
        "customer.subscription.created",
        "customer.subscription.updated",
        "customer.subscription.deleted",
        "customer.subscription.paused",
        "customer.subscription.resumed",
      ],
    });
    say("webhook", made, true);
    webhookSecret = made.secret;
  }
}

console.log("\nSet on the site:");
console.log(`STRIPE_SECRET_KEY=${key.slice(0, 12)}…`);
if (webhookSecret) console.log(`STRIPE_WEBHOOK_SECRET=${webhookSecret}`);
else if (!webhookUrl) console.log("STRIPE_WEBHOOK_SECRET=  (rerun with --webhook-url, or `stripe listen` locally)");
