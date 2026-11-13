import Stripe from "stripe";

import { OVERAGE_LOOKUP_KEY, PLANS, type PlanId } from "./cloud/plans";

const held = globalThis as { drayStripe?: Stripe; drayPrices?: Promise<Prices> };

/// The Stripe client, or null while `STRIPE_SECRET_KEY` is unset, so a site
/// without billing keeps every other page. `STRIPE_API_URL` points it at a
/// fake in tests.
export function stripe(): Stripe | null {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return null;
  if (!held.drayStripe) {
    const url = process.env.STRIPE_API_URL ? new URL(process.env.STRIPE_API_URL) : null;
    held.drayStripe = new Stripe(key, {
      ...(url && {
        host: url.hostname,
        port: Number(url.port),
        protocol: url.protocol.slice(0, -1) as "http" | "https",
      }),
      appInfo: { name: "Dray Cloud" },
    });
  }
  return held.drayStripe;
}

type Prices = { plans: Record<PlanId, string>; overage: string };

/// Price ids by lookup key, read once per process. A failed read is dropped
/// so the next call tries again rather than caching the failure.
export function prices(s: Stripe): Promise<Prices> {
  held.drayPrices ??= (async () => {
    const keys = [...Object.values(PLANS).map((p) => p.lookupKey), OVERAGE_LOOKUP_KEY];
    const { data } = await s.prices.list({ lookup_keys: keys, active: true, limit: keys.length });
    const id = (key: string) => {
      const price = data.find((p) => p.lookup_key === key);
      if (!price) throw new Error(`Stripe has no active price with lookup key ${key}. Run scripts/stripe-setup.mjs.`);
      return price.id;
    };
    return {
      plans: { starter: id(PLANS.starter.lookupKey), pro: id(PLANS.pro.lookupKey), max: id(PLANS.max.lookupKey) },
      overage: id(OVERAGE_LOOKUP_KEY),
    };
  })().catch((e) => {
    held.drayPrices = undefined;
    throw e;
  });
  return held.drayPrices;
}
