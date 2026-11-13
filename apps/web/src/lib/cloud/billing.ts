import { randomUUID } from "node:crypto";

import { pool } from "../db";
import { stripe } from "../stripe";
import { boat, BoatError } from "./boat";
import { METER_EVENT, standing, type Standing } from "./plans";

/// Metering Dray Cloud for billing (#1014). Time comes from boat's own meter,
/// `GET /sandboxes/{id}/usage`, which counts a machine only while it runs and
/// splits a running stretch at a period boundary. Dray keeps the last reading
/// per machine per period and sends Stripe only overage, in minutes.

export type Billing = {
  id: string;
  userId: string;
  stripeCustomerId: string;
  stripeSubscriptionId: string | null;
  plan: string | null;
  status: string | null;
  periodStart: Date | null;
  periodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  overage: boolean;
  overageCapCents: number | null;
  reportedMinutes: number;
  reportedFor: Date | null;
};

export async function billingOf(userId: string): Promise<Billing | null> {
  const { rows } = await pool.query<Billing>(`select * from cloud_billing where "userId" = $1`, [userId]);
  return rows[0] ?? null;
}

/// Where a user stands from what was last read. No boat call, so it is cheap
/// enough to gate every create and resume.
export async function standingOf(userId: string): Promise<{ billing: Billing | null; standing: Standing }> {
  const billing = await billingOf(userId);
  if (!billing?.periodStart) return { billing, standing: standing(null, 0) };
  return { billing, standing: standing(billing, await usedSeconds(userId, billing.periodStart)) };
}

async function usedSeconds(userId: string, periodStart: Date): Promise<number> {
  const { rows } = await pool.query<{ n: number }>(
    `select coalesce(sum(seconds), 0)::int as n from cloud_usage
      where "userId" = $1 and "periodStart" = $2`,
    [userId, periodStart],
  );
  return rows[0].n;
}

/// Reads boat's meter for `sandboxIds` into the user's current period, sends
/// Stripe any new overage, and answers where the user now stands. A reading or
/// report that fails is logged and left for the next call, never thrown: a
/// heartbeat must not stop machines because boat or Stripe blinked.
export async function meter(userId: string, sandboxIds: string[]): Promise<Standing> {
  const billing = await billingOf(userId);
  if (!billing?.periodStart || !billing.periodEnd) return standing(null, 0);
  const { periodStart, periodEnd } = billing;
  await Promise.all(
    sandboxIds.map((id) =>
      readUsage(id, userId, periodStart, periodEnd).catch((e) => console.error(`usage ${id}:`, e)),
    ),
  );
  const now = standing(billing, await usedSeconds(userId, periodStart));
  await report(billing, now.billableMinutes).catch((e) => console.error(`stripe report ${userId}:`, e));
  return now;
}

async function readUsage(sandboxId: string, userId: string, since: Date, end: Date) {
  const readAt = new Date();
  const until = new Date(Math.min(readAt.getTime(), end.getTime()));
  if (until <= since) return;
  const query = new URLSearchParams({ since: since.toISOString(), until: until.toISOString() });
  let usage: { seconds: number; running: boolean };
  try {
    usage = await boat("GET", `/sandboxes/${sandboxId}/usage?${query}`);
  } catch (e) {
    // Deleted outside Dray: its last reading is all there will be.
    if (e instanceof BoatError && e.status === 404) return;
    throw e;
  }
  // Boat's billable seconds carry the machine size's multiplier; every Dray
  // Cloud machine is `default`, at 1. Two reads racing keep the larger count
  // and the later flag.
  await pool.query(
    `insert into cloud_usage (id, "sandboxId", "userId", "periodStart", seconds, running, "readAt")
     values ($1, $2, $3, $4, $5, $6, $7)
     on conflict ("sandboxId", "periodStart") do update set
       seconds = greatest(cloud_usage.seconds, excluded.seconds),
       running = case when excluded."readAt" >= cloud_usage."readAt" then excluded.running else cloud_usage.running end,
       "readAt" = greatest(cloud_usage."readAt", excluded."readAt")`,
    [randomUUID(), sandboxId, userId, since, Math.round(usage.seconds), usage.running, readAt],
  );
}

/// Machines of the user whose current-period reading is final: read while
/// stopped, so nothing has run since. The sweep skips these.
export async function settledMachines(userId: string, periodStart: Date): Promise<Set<string>> {
  const { rows } = await pool.query<{ sandboxId: string }>(
    `select "sandboxId" from cloud_usage
      where "userId" = $1 and "periodStart" = $2 and not running`,
    [userId, periodStart],
  );
  return new Set(rows.map((r) => r.sandboxId));
}

/// Sends Stripe the overage minutes it doesn't hold yet. The row is claimed
/// first by a conditional update, so two heartbeats of one user can't both send
/// the same minutes; a send that fails gives the claim back. The identifier is
/// the running total, so a retry after a lost answer is one Stripe drops.
async function report(billing: Billing, minutes: number) {
  const s = stripe();
  const { periodStart, periodEnd } = billing;
  if (!s || !periodStart || !periodEnd) return;
  const sent = billing.reportedFor?.getTime() === periodStart.getTime() ? billing.reportedMinutes : 0;
  if (minutes <= sent) return;
  const claim = await pool.query(
    `update cloud_billing set "reportedMinutes" = $1, "reportedFor" = $2
      where id = $3 and "reportedMinutes" = $4 and "reportedFor" is not distinct from $5`,
    [minutes, periodStart, billing.id, billing.reportedMinutes, billing.reportedFor],
  );
  if (!claim.rowCount) return;
  try {
    await s.billing.meterEvents.create({
      event_name: METER_EVENT,
      payload: { stripe_customer_id: billing.stripeCustomerId, value: String(minutes - sent) },
      identifier: `${billing.userId}:${periodStart.getTime() / 1000}:${minutes}`,
      // Inside the period it belongs to, even when read just after it ended.
      timestamp: Math.floor(Math.min(Date.now(), periodEnd.getTime() - 1000) / 1000),
    });
  } catch (e) {
    await pool.query(
      `update cloud_billing set "reportedMinutes" = $1, "reportedFor" = $2
        where id = $3 and "reportedMinutes" = $4 and "reportedFor" = $5`,
      [billing.reportedMinutes, billing.reportedFor, billing.id, minutes, periodStart],
    );
    throw e;
  }
}
