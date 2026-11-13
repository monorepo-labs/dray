/// Dray Cloud's plans and the arithmetic of an allowance. No imports, so a
/// test can load it straight off the disk.

export type PlanId = "starter" | "pro" | "max";

/// `lookupKey` names the plan's monthly price in Stripe, so no price id lives
/// in env and test mode and live mode resolve the same way.
export const PLANS: Record<PlanId, { name: string; dollars: number; hours: number; lookupKey: string }> = {
  starter: { name: "Starter", dollars: 20, hours: 100, lookupKey: "dray_cloud_starter" },
  pro: { name: "Pro", dollars: 100, hours: 600, lookupKey: "dray_cloud_pro" },
  max: { name: "Max", dollars: 200, hours: 1500, lookupKey: "dray_cloud_max" },
};

export const PLAN_IDS = Object.keys(PLANS) as PlanId[];

export const OVERAGE_CENTS_PER_HOUR = 20;
export const OVERAGE_LOOKUP_KEY = "dray_cloud_overage";
/// The Stripe meter's event name. Overage is reported in whole minutes, since
/// a meter event's value is an integer.
export const METER_EVENT = "dray_cloud_overage_minutes";

/// Stripe's statuses that still pay for machine time. `past_due` keeps running
/// while Stripe retries the card; Stripe cancels the subscription if it never
/// lands, and that stops the machines.
export const PAYING = new Set(["active", "trialing", "past_due"]);

export const isPlanId = (p: unknown): p is PlanId => typeof p === "string" && p in PLANS;

export type Standing = {
  plan: PlanId | null;
  usedSeconds: number;
  includedSeconds: number;
  /// Seconds past the included hours this org agreed to pay for: none with
  /// overage off, the cap's worth with one, unbounded without.
  overageSeconds: number;
  /// What Stripe should hold for this period, in whole minutes.
  billableMinutes: number;
  canRun: boolean;
};

/// Where an org stands this period. Overage off means time past the included
/// hours is never billed, even the minute or so a machine runs before the
/// next heartbeat stops it.
export function standing(
  billing: { plan: string | null; status: string | null; overage: boolean; overageCapCents: number | null } | null,
  usedSeconds: number,
): Standing {
  const plan = billing && PAYING.has(billing.status ?? "") && isPlanId(billing.plan) ? billing.plan : null;
  if (!plan) {
    return { plan: null, usedSeconds, includedSeconds: 0, overageSeconds: 0, billableMinutes: 0, canRun: false };
  }
  const includedSeconds = PLANS[plan].hours * 3600;
  const overageSeconds = !billing!.overage
    ? 0
    : billing!.overageCapCents == null
      ? Infinity
      : Math.floor((billing!.overageCapCents / OVERAGE_CENTS_PER_HOUR) * 3600);
  const over = Math.min(Math.max(0, usedSeconds - includedSeconds), overageSeconds);
  return {
    plan,
    usedSeconds,
    includedSeconds,
    overageSeconds,
    billableMinutes: Math.floor(over / 60),
    canRun: usedSeconds < includedSeconds + overageSeconds,
  };
}
