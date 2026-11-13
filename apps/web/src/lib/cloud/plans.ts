/// Dray Cloud's plans (#1021): a monthly price buys awake machine-hours, and
/// hours past those are billed at `OVERAGE_PER_HOUR`. Agents run on the
/// customer's own Claude or Codex subscription, so no plan pays for tokens.
/// The pricing page, the dashboard and the app's setup sheet all read this.

export type PlanId = "starter" | "pro" | "max";

export type Plan = {
  id: PlanId;
  name: string;
  /// US dollars a month.
  price: number;
  /// Awake machine-hours included each billing period.
  hours: number;
  /// Machines awake at once, which is tasks running at once.
  machines: number;
  blurb: string;
};

export const PLANS: Plan[] = [
  { id: "starter", name: "Starter", price: 20, hours: 40, machines: 3, blurb: "A few tasks a day off your laptop." },
  { id: "pro", name: "Pro", price: 100, hours: 250, machines: 10, blurb: "Agents working all day, in parallel." },
  { id: "max", name: "Max", price: 200, hours: 600, machines: 25, blurb: "A fleet for every repo you own." },
];

/// US dollars per awake hour past a plan's included ones.
export const OVERAGE_PER_HOUR = 0.4;

/// Every machine stops itself this long after its agents go quiet.
export const IDLE_MINUTES = 15;

export function planById(id: string | null | undefined): Plan | null {
  return PLANS.find((p) => p.id === id) ?? null;
}

export const isPlanId = (id: unknown): id is PlanId => typeof id === "string" && !!planById(id);

/// Hours past the included ones, and what they cost so far.
export function overage(hours: number, included: number): { hours: number; dollars: number } {
  const over = Math.max(0, hours - included);
  return { hours: over, dollars: Math.round(over * OVERAGE_PER_HOUR * 100) / 100 };
}
