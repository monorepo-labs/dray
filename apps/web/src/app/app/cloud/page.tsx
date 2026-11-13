import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { AppShell } from "@/components/account/AppShell";
import { BOX, ERROR, LABEL, LEAD, MUTED, ROWS, SECONDARY, TITLE } from "@/components/account/styles";
import { PlanCards } from "@/components/cloud/PlanCards";
import { SetupRows } from "@/components/cloud/SetupRows";
import { cloudAccount, originOf, toUser, type CloudAccount } from "@/lib/cloud/account";
import { listOrgs, requireSession } from "@/lib/session";

export const metadata: Metadata = { title: "Dray Cloud - Dray" };

/// Every machine stops itself this long after its agent goes quiet (#857).
const IDLE_MINUTES = 15;

/// The reader's Dray Cloud: this period's hours, the machines awake now, the
/// plan with billing (#1023) behind it, and what setup still wants.
export default async function CloudDashboard() {
  const { user, session } = await requireSession("/app/cloud");
  const orgs = await listOrgs();
  const org = orgs.find((o) => o.id === session.activeOrganizationId) ?? orgs[0];
  if (!org) redirect("/app");
  const account = await cloudAccount(toUser(user), originOf(await headers(), "https://www.drayhq.com"));

  return (
    <AppShell org={org} orgs={orgs} user={user}>
      <h1 className={TITLE}>Dray Cloud</h1>
      {account.plan ? (
        <>
          <Usage account={account} plan={account.plan} />
          <Machines machines={account.machines} />
          <PlanRow plan={account.plan} billing={account.links.billing} />
        </>
      ) : (
        <section className="mt-8">
          <p className={LEAD}>Pick a plan to run tasks in the cloud. You pay for the hours machines are awake.</p>
          <div className="mt-8">
            <PlanCards />
          </div>
        </section>
      )}
      <section className="mt-14">
        <h2 className={LABEL}>Setup</h2>
        <p className={`mt-2 text-[14px] ${MUTED}`}>Cloud needs GitHub and an agent login.</p>
        <div className="mt-4">
          <SetupRows github={account.github} agents={account.agents} />
        </div>
      </section>
    </AppShell>
  );
}

const day = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

const hours = (n: number) => (Number.isInteger(n) ? n.toLocaleString("en-US") : n.toFixed(1));

const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`;

/// What the line under the meter says, and whether it is bad news.
function usageLine(used: number, plan: NonNullable<CloudAccount["plan"]>): [string, boolean] {
  const renews = day(plan.renewsAt);
  if (used < plan.hours) {
    const on = plan.overage.on ? " Overage is on." : "";
    return [`${hours(plan.hours - used)} hours left. Renews ${renews}.${on}`, false];
  }
  if (!plan.overage.on) {
    return [`This period's hours are used up. Machines stay stopped until ${renews}, or turn on overage in billing.`, true];
  }
  const over = used - plan.hours;
  const cents = Math.round(over * plan.overage.centsPerHour);
  const cap = plan.overage.capCents;
  if (cap !== null && cents >= cap) {
    return [`Your ${dollars(cap)} overage cap is reached. Machines stay stopped until ${renews}.`, true];
  }
  const spent = cap === null ? `${dollars(cents)} so far` : `${dollars(cents)} of your ${dollars(cap)} cap`;
  return [`${hours(over)} hours past your plan · ${spent}, billed ${renews}.`, true];
}

function Usage({ account, plan }: { account: CloudAccount; plan: NonNullable<CloudAccount["plan"]> }) {
  const used = account.usage?.hours ?? 0;
  const share = Math.min(1, used / plan.hours);
  const [line, bad] = usageLine(used, plan);
  return (
    <section className="mt-8">
      <h2 className={LABEL}>
        This period{account.usage && ` · ${day(account.usage.from)} – ${day(account.usage.to)}`}
      </h2>
      <p className="mt-4 flex items-baseline gap-2">
        <span className="text-[36px] leading-[40px] tracking-[-0.03em]">{hours(used)}</span>
        <span className={`text-[16px] ${MUTED}`}>of {hours(plan.hours)} awake hours</span>
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
          className={`h-full rounded-full ${bad ? "bg-[#FF5A4E]" : "bg-white light:bg-[#0A0A0A]"}`}
          style={{ width: `${Math.max(share * 100, used > 0 ? 1 : 0)}%` }}
        />
      </div>
      <p className={`mt-3 text-[14px] ${bad ? "text-[#FF5A4E]" : MUTED}`}>{line}</p>
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

function PlanRow({ plan, billing }: { plan: NonNullable<CloudAccount["plan"]>; billing: string }) {
  return (
    <section className="mt-14">
      <h2 className={LABEL}>Plan</h2>
      <div className={`mt-4 flex flex-wrap items-center gap-4 ${BOX} px-4 py-3`}>
        <div className="min-w-0 flex-1">
          <p className="text-[16px] leading-6">
            {plan.name} <span className={MUTED}>· ${plan.dollars} a month</span>
          </p>
          <p className={`text-[14px] ${MUTED}`}>
            {hours(plan.hours)} awake hours · overage {plan.overage.on ? "on" : "off"}
          </p>
          {plan.status === "past_due" && (
            <p className={`mt-1 ${ERROR}`}>Your last payment didn&apos;t go through. Update your card in billing.</p>
          )}
        </div>
        <a href={billing} className={SECONDARY}>
          Billing
        </a>
      </div>
    </section>
  );
}
