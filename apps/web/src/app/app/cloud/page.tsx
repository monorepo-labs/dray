import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { AppShell } from "@/components/account/AppShell";
import { BOX, ERROR, LABEL, LEAD, MUTED, ROWS, SECONDARY, TITLE } from "@/components/account/styles";
import { PlanCards } from "@/components/cloud/PlanCards";
import { SetupRows } from "@/components/cloud/SetupRows";
import { cloudAccount, originOf, toUser, type CloudAccount } from "@/lib/cloud/account";
import { IDLE_MINUTES, overage } from "@/lib/cloud/plans";
import { listOrgs, requireSession } from "@/lib/session";

export const metadata: Metadata = { title: "Dray Cloud - Dray" };

/// The reader's Dray Cloud: this period's hours, the machines awake now, the
/// plan with billing behind it, and what setup still wants.
export default async function CloudDashboard({ searchParams }: { searchParams: Promise<{ billing?: string }> }) {
  const { user, session } = await requireSession("/app/cloud");
  const orgs = await listOrgs();
  const org = orgs.find((o) => o.id === session.activeOrganizationId) ?? orgs[0];
  if (!org) redirect("/app");
  const account = await cloudAccount(toUser(user), originOf(await headers(), "https://www.drayhq.com"));
  const { billing } = await searchParams;

  return (
    <AppShell org={org} orgs={orgs} user={user}>
      <h1 className={TITLE}>Dray Cloud</h1>
      {billing === "soon" && (
        <p className={`mt-4 ${BOX} px-4 py-3 text-[14px]`}>Billing isn&apos;t open yet, so no plan can be chosen today.</p>
      )}
      {account.plan ? (
        <>
          <Usage account={account} plan={account.plan} />
          <Machines machines={account.machines} />
          <PlanRow plan={account.plan} />
        </>
      ) : (
        <section className="mt-8">
          <p className={LEAD}>Pick a plan to run tasks in the cloud. Agents use your own Claude or Codex subscription.</p>
          <div className="mt-8">
            <PlanCards />
          </div>
        </section>
      )}
      <section className="mt-14">
        <h2 className={LABEL}>Setup</h2>
        <p className={`mt-2 text-[14px] ${MUTED}`}>Cloud needs GitHub and one of Claude or Codex.</p>
        <div className="mt-4">
          <SetupRows github={account.github} agents={account.agents} />
        </div>
      </section>
    </AppShell>
  );
}

const day = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

const hours = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

function Usage({ account, plan }: { account: CloudAccount; plan: NonNullable<CloudAccount["plan"]> }) {
  const used = account.usage?.hours ?? 0;
  const over = overage(used, plan.hours);
  const share = Math.min(1, used / plan.hours);
  return (
    <section className="mt-8">
      <h2 className={LABEL}>
        This period{account.usage && ` · ${day(account.usage.from)} – ${day(account.usage.to)}`}
      </h2>
      <p className="mt-4 flex items-baseline gap-2">
        <span className="text-[36px] leading-[40px] tracking-[-0.03em]">{hours(used)}</span>
        <span className={`text-[16px] ${MUTED}`}>of {plan.hours} awake hours</span>
      </p>
      <div
        role="meter"
        aria-label="Awake hours used"
        aria-valuemin={0}
        aria-valuemax={plan.hours}
        aria-valuenow={used}
        className="mt-4 h-2 w-full rounded-full bg-white/10 light:bg-black/10"
      >
        <div
          className={`h-full rounded-full ${over.hours > 0 ? "bg-[#FF5A4E]" : "bg-white light:bg-[#0A0A0A]"}`}
          style={{ width: `${Math.max(share * 100, used > 0 ? 1 : 0)}%` }}
        />
      </div>
      <p className={`mt-3 text-[14px] ${MUTED}`}>
        {over.hours > 0 ? (
          <span className="text-[#FF5A4E]">
            {hours(over.hours)} hours past your plan · ${over.dollars.toFixed(2)} so far, billed{" "}
            {account.usage ? day(account.usage.to) : "at renewal"}
          </span>
        ) : (
          `${hours(plan.hours - used)} hours left. Renews ${day(plan.renewsAt)}.`
        )}
      </p>
    </section>
  );
}

const AWAKE = new Set(["starting", "running", "stopping"]);

function Machines({ machines }: { machines: CloudAccount["machines"] }) {
  const awake = machines.filter((m) => AWAKE.has(m.state));
  const asleep = machines.length - awake.length;
  return (
    <section className="mt-14">
      <h2 className={LABEL}>Awake now</h2>
      {awake.length === 0 ? (
        <p className={`mt-4 text-[14px] ${MUTED}`}>
          No machine is awake. One wakes when its task works and sleeps {IDLE_MINUTES} minutes after.
        </p>
      ) : (
        <div className={`mt-4 ${ROWS}`}>
          {awake.map((m) => (
            <div key={m.id} className="flex items-center gap-3 px-4 py-3 text-[14px]">
              <span
                aria-hidden
                className={`size-2 shrink-0 rounded-full ${m.state === "running" ? "bg-[#3ECF8E]" : "bg-[#7C7C7C]"}`}
              />
              <span className="min-w-0 flex-1 truncate">{m.repo ?? "A task"}</span>
              <span className={`shrink-0 ${MUTED}`}>{m.state === "running" ? `awake ${since(m.since)}` : m.state}</span>
            </div>
          ))}
        </div>
      )}
      {asleep > 0 && (
        <p className={`mt-3 text-[14px] ${MUTED}`}>
          {asleep} more {asleep === 1 ? "task's machine is" : "tasks' machines are"} asleep, at no cost.
        </p>
      )}
    </section>
  );
}

/// "42 min", "3 h 5 min" since `iso`.
function since(iso: string): string {
  const min = Math.max(1, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
  return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${min % 60} min`;
}

function PlanRow({ plan }: { plan: NonNullable<CloudAccount["plan"]> }) {
  return (
    <section className="mt-14">
      <h2 className={LABEL}>Plan</h2>
      <div className={`mt-4 flex flex-wrap items-center gap-4 ${BOX} px-4 py-3`}>
        <div className="min-w-0 flex-1">
          <p className="text-[16px] leading-6">
            {plan.name} <span className={MUTED}>· ${plan.price} a month</span>
          </p>
          <p className={`text-[14px] ${MUTED}`}>
            {plan.hours} awake hours, {plan.machines} machines at once
          </p>
          {plan.status === "past_due" && (
            <p className={`mt-1 ${ERROR}`}>Your last payment didn&apos;t go through. Update your card in billing.</p>
          )}
        </div>
        <a href="/cloud" className={SECONDARY}>
          Change plan
        </a>
        <a href="/app/cloud/billing" className={SECONDARY}>
          Billing
        </a>
      </div>
    </section>
  );
}
