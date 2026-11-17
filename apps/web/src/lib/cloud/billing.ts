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
  pendingTotal: number | null;
  pendingFor: Date | null;
  pendingAt: Date | null;
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
/// report that fails is logged and left for the next call: a heartbeat must not
/// stop machines because boat or Stripe blinked. `strict` throws a failed
/// reading instead, for a delete that must not go ahead without one.
export async function meter(userId: string, sandboxIds: string[], strict = false): Promise<Standing> {
  const billing = await billingOf(userId);
  if (!billing?.periodStart || !billing.periodEnd) return standing(null, 0);
  const { periodStart, periodEnd } = billing;
  const reads = await Promise.allSettled(sandboxIds.map((id) => readUsage(id, userId, periodStart, periodEnd)));
  for (const [i, r] of reads.entries()) {
    if (r.status === "rejected") {
      if (strict) throw r.reason;
      console.error(`usage ${sandboxIds[i]}:`, r.reason);
    }
  }
  const now = standing(billing, await usedSeconds(userId, periodStart));
  await report(billing.id, now.billableMinutes, { start: periodStart, end: periodEnd }).catch((e) => console.error(`stripe report ${userId}:`, e));
  return now;
}

/// Reads what is left of the period a renewal is about to replace: every
/// machine whose last reading said running, up to the period's end, and the
/// overage that adds. Called before the row moves on, while it still names
/// the old period's plan and reports.
export async function finishPeriod(userId: string) {
  const billing = await billingOf(userId);
  if (!billing?.periodStart) return;
  const { rows } = await pool.query<{ sandboxId: string }>(
    `select "sandboxId" from cloud_usage where "userId" = $1 and "periodStart" = $2 and running`,
    [userId, billing.periodStart],
  );
  await meter(userId, rows.map((r) => r.sandboxId));
}

/// A resumed machine runs again, so its readings stop counting as final and
/// the sweep reads it next time even if no heartbeat does.
export async function markRunning(sandboxId: string) {
  await pool.query(`update cloud_usage set running = true where "sandboxId" = $1`, [sandboxId]);
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
  // A period already over reads final whatever the machine does now.
  const running = usage.running && until.getTime() === readAt.getTime();
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
    [randomUUID(), sandboxId, userId, since, Math.round(usage.seconds), running, readAt],
  );
}

/// Machines of the user whose current-period reading is final: read while
/// stopped, and not resumed since. The sweep skips these.
export async function settledMachines(userId: string, periodStart: Date): Promise<Set<string>> {
  const { rows } = await pool.query<{ sandboxId: string }>(
    `select "sandboxId" from cloud_usage
      where "userId" = $1 and "periodStart" = $2 and not running`,
    [userId, periodStart],
  );
  return new Set(rows.map((r) => r.sandboxId));
}

/// Brings Stripe up to `minutes` of overage for the row's current period.
///
/// One report is in flight per user at a time, and it is written down before
/// it is sent: a send whose answer is lost is retried with the same value and
/// identifier, which Stripe drops as a duplicate, rather than folded into a
/// larger report that would count it twice. A new report is claimed only
/// while none is pending, so two heartbeats can't both send the same minutes.
/// `minutes` were measured over `period`; a renewal that moved the row on
/// since leaves them unsent, `finishPeriod` having reported that period first.
async function report(billingId: string, minutes: number, period: { start: Date; end: Date }) {
  const s = stripe();
  if (!s) return;
  let row = await reread(billingId);
  if (row?.pendingFor) {
    await send(s, row);
    row = await reread(billingId);
  }
  if (!row || row.pendingFor || row.periodStart?.getTime() !== period.start.getTime()) return;
  const sent = row.reportedFor?.getTime() === period.start.getTime() ? row.reportedMinutes : 0;
  if (minutes <= sent) return;
  const claim = await pool.query(
    `update cloud_billing set "pendingTotal" = $1, "pendingFor" = $2, "pendingAt" = $3
      where id = $4 and "pendingFor" is null and "periodStart" = $2
        and "reportedMinutes" = $5 and "reportedFor" is not distinct from $6`,
    // Inside the period it belongs to, even when read just after it ended.
    [minutes, period.start, new Date(Math.min(Date.now(), period.end.getTime() - 1000)), row.id, row.reportedMinutes, row.reportedFor],
  );
  if (!claim.rowCount) return;
  await send(s, (await reread(billingId))!);
}

async function reread(id: string): Promise<Billing | null> {
  const { rows } = await pool.query<Billing>(`select * from cloud_billing where id = $1`, [id]);
  return rows[0] ?? null;
}

/// Sends the pending report and, once Stripe has it, makes it the confirmed
/// count. A failure leaves it pending for the next call to send again.
async function send(s: NonNullable<ReturnType<typeof stripe>>, row: Billing) {
  const { pendingTotal, pendingFor, pendingAt } = row;
  if (pendingTotal == null || !pendingFor || !pendingAt) return;
  const sent = row.reportedFor?.getTime() === pendingFor.getTime() ? row.reportedMinutes : 0;
  if (pendingTotal > sent) {
    await s.billing.meterEvents.create({
      event_name: METER_EVENT,
      payload: { stripe_customer_id: row.stripeCustomerId, value: String(pendingTotal - sent) },
      identifier: `${row.userId}:${pendingFor.getTime() / 1000}:${pendingTotal}`,
      timestamp: Math.floor(pendingAt.getTime() / 1000),
    });
  }
  await pool.query(
    `update cloud_billing set "reportedMinutes" = $1, "reportedFor" = $2,
       "pendingTotal" = null, "pendingFor" = null, "pendingAt" = null
      where id = $3 and "pendingTotal" = $1 and "pendingFor" = $2`,
    [pendingTotal, pendingFor, row.id],
  );
}
