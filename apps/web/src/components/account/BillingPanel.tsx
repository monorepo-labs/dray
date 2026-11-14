"use client";

import { useState, useTransition } from "react";

import { choosePlan, openPortal, saveOverage } from "@/app/app/account/billing/actions";
import { OVERAGE_CENTS_PER_HOUR, PLAN_IDS, PLANS, type PlanId } from "@/lib/cloud/plans";

import { BOX, ERROR, INPUT, LABEL, MUTED, PRIMARY, SECONDARY } from "./styles";

type Current = {
  plan: PlanId;
  status: string;
  renews: string | null;
  cancels: boolean;
  usedSeconds: number;
  billableMinutes: number;
  overage: boolean;
  overageCapCents: number | null;
};

const hours = (seconds: number) => (seconds / 3600).toFixed(seconds < 36_000 ? 1 : 0);
const dollars = (cents: number) => `$${(cents / 100).toFixed(2).replace(/\.00$/, "")}`;

/// The billing page's body: this period's hours on a paying plan, the three
/// plans, and the overage switch.
export function BillingPanel({
  configured,
  awaitingCheckout,
  current,
}: {
  configured: boolean;
  awaitingCheckout: boolean;
  current: Current | null;
}) {
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const run = (action: () => Promise<string | null>) =>
    start(async () => {
      setError(null);
      setError(await action());
    });
  const locked = !configured || pending;

  return (
    <div className="mt-8 flex flex-col gap-12">
      {!configured && <p className={`text-[13px] ${MUTED}`}>Billing isn't set up on this site yet.</p>}
      {awaitingCheckout && (
        <p className={`${BOX} px-4 py-3 text-[14px]`}>
          Payment received. Your plan shows here once Stripe confirms it, usually within a few seconds. Refresh to
          check.
        </p>
      )}
      {current && <Usage current={current} />}
      <section>
        <h2 className={LABEL}>Plans</h2>
        <ul className="mt-3 grid gap-3 sm:grid-cols-3">
          {PLAN_IDS.map((id) => {
            const plan = PLANS[id];
            const here = current?.plan === id;
            return (
              <li key={id} className={`${BOX} flex flex-col gap-3 p-4 ${here ? "bg-white/5 light:bg-black/[0.03]" : ""}`}>
                <div className="flex items-baseline justify-between">
                  <h3 className="text-[15px]">{plan.name}</h3>
                  <span className="text-[15px]">${plan.dollars}/mo</span>
                </div>
                <p className={`text-[13px] ${MUTED}`}>{plan.hours.toLocaleString("en-US")} awake hours a month</p>
                <button
                  type="button"
                  disabled={locked || here}
                  onClick={() => run(() => choosePlan(id))}
                  className={current ? SECONDARY : PRIMARY}
                >
                  {here ? "Current plan" : current ? `Switch to ${plan.name}` : `Choose ${plan.name}`}
                </button>
              </li>
            );
          })}
        </ul>
        <p className={`mt-3 text-[13px] ${MUTED}`}>
          Past a plan's hours, machines stop unless overage is on. Overage is {dollars(OVERAGE_CENTS_PER_HOUR)} an
          hour. A switch is prorated and its hours apply at once.
        </p>
      </section>
      {current && <Overage current={current} locked={locked} run={run} />}
      {current && (
        <section>
          <h2 className={LABEL}>Card, invoices, cancel</h2>
          <button type="button" disabled={locked} onClick={() => run(() => openPortal())} className={`mt-3 ${SECONDARY}`}>
            Manage in Stripe
          </button>
        </section>
      )}
      {error && <p className={ERROR}>{error}</p>}
    </div>
  );
}

function Usage({ current }: { current: Current }) {
  const plan = PLANS[current.plan];
  const included = plan.hours * 3600;
  const share = Math.min(1, current.usedSeconds / included);
  const over = current.billableMinutes > 0;
  return (
    <section className={`${BOX} flex flex-col gap-3 p-4`}>
      <div className="flex items-baseline justify-between gap-4">
        <h2 className="text-[15px]">
          {plan.name} · ${plan.dollars}/mo
        </h2>
        <span className={`text-[13px] ${MUTED}`}>
          {current.status === "past_due"
            ? "Payment failed. Update your card in Stripe."
            : current.renews && (current.cancels ? `Ends ${current.renews}` : `Renews ${current.renews}`)}
        </span>
      </div>
      <p className="text-[14px]">
        {hours(Math.min(current.usedSeconds, included))} of {plan.hours.toLocaleString("en-US")} hours used
        {over &&
          ` · ${hours(current.billableMinutes * 60)} h overage, ${dollars(
            Math.round((current.billableMinutes / 60) * OVERAGE_CENTS_PER_HOUR),
          )}`}
      </p>
      <div className="h-1.5 w-full bg-white/10 light:bg-black/10" role="progressbar" aria-valuenow={Math.round(share * 100)}>
        <div
          className={`h-full ${share >= 1 ? "bg-[#FF5A4E]" : "bg-white light:bg-[#0A0A0A]"}`}
          style={{ width: `${share * 100}%` }}
        />
      </div>
      {share >= 1 && !current.overage && (
        <p className={ERROR}>Hours used up. Machines stay stopped until the plan renews, overage is on, or you switch plan.</p>
      )}
    </section>
  );
}

function Overage({
  current,
  locked,
  run,
}: {
  current: Current;
  locked: boolean;
  run: (action: () => Promise<string | null>) => void;
}) {
  const [on, setOn] = useState(current.overage);
  const [cap, setCap] = useState(current.overageCapCents == null ? "" : String(current.overageCapCents / 100));
  return (
    <section>
      <h2 className={LABEL}>Overage</h2>
      <form
        className="mt-3 flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          run(() => saveOverage(on, cap));
        }}
      >
        <label className="flex items-center gap-2 text-[14px]">
          <input type="checkbox" checked={on} disabled={locked} onChange={(e) => setOn(e.target.checked)} />
          Keep machines running past the plan's hours, at {dollars(OVERAGE_CENTS_PER_HOUR)} an hour
        </label>
        <label className="flex max-w-xs flex-col gap-1.5">
          <span className={`text-[13px] ${MUTED}`}>Monthly cap in dollars, blank for none</span>
          <input
            className={INPUT}
            inputMode="decimal"
            placeholder="No cap"
            value={cap}
            disabled={locked || !on}
            onChange={(e) => setCap(e.target.value)}
          />
        </label>
        <div>
          <button type="submit" disabled={locked} className={SECONDARY}>
            Save
          </button>
        </div>
      </form>
    </section>
  );
}
