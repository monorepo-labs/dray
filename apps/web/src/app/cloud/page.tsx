import type { Metadata } from "next";

import { H1, LABEL, LEAD, MUTED } from "@/components/account/styles";
import { PlanCards } from "@/components/cloud/PlanCards";
import { Closing } from "@/components/home/Closing";
import { SiteNav } from "@/components/home/SiteNav";
import { OVERAGE_CENTS_PER_HOUR } from "@/lib/cloud/plans";

export const metadata: Metadata = {
  title: "Dray Cloud pricing - Dray",
  description: "A machine of its own for every task. Pay for the hours machines are awake.",
};

/// Every machine stops itself this long after its agent goes quiet (#857).
const IDLE_MINUTES = 15;
const OVERAGE = `$${(OVERAGE_CENTS_PER_HOUR / 100).toFixed(2)} an awake hour`;

const EVERY_PLAN: [string, string][] = [
  ["No token markup", "Dray bills the hours machines are awake. Model usage is never on your Dray bill."],
  ["A machine per task", "Each task gets its own machine with its own checkout. It's deleted when you settle the task."],
  ["Awake hours only", `A machine sleeps ${IDLE_MINUTES} minutes after its agent goes quiet. Sleeping time is free.`],
  ["Your repos, your pick", "Cloud reaches GitHub through the Dray GitHub App, on the repos you choose."],
];

const FAQ: [string, string][] = [
  [
    "What counts as an awake hour?",
    `Time a machine is running, counted by the minute. A task that works for 20 minutes and then waits for you uses about 35 minutes, since its machine stays up for ${IDLE_MINUTES} more.`,
  ],
  [
    "What happens past my plan's hours?",
    `Machines stop until your next month starts. Overage is off unless you turn it on in billing; then each hour past your plan's is ${OVERAGE}, up to a cap you can set.`,
  ],
  [
    "Which agents run on Cloud?",
    "Claude Code, once connecting a Claude login opens. Today Anthropic's terms don't let Dray run your Claude Pro or Max login on its machines. Codex on Cloud isn't built yet.",
  ],
  ["Can I cancel?", "Any time, from billing. Your plan runs to the end of the month you paid for."],
];

/// Dray Cloud's plans. Choosing one happens on the billing page, which signs
/// the reader in first, so this page needs no session.
export default function CloudPricingPage() {
  return (
    <div
      data-home
      className="min-h-screen overflow-x-clip bg-black font-inter text-white antialiased light:bg-white light:text-[#0A0A0A]"
    >
      <main className="px-5 pb-[120px] sm:px-8 light:bg-[#F4F4F2]">
        <div className="mx-auto w-full max-w-[960px]">
          <SiteNav bare />
          <div className="lg:ml-[102px] lg:max-w-[756px]">
            <h1 className={H1}>Dray Cloud.</h1>
            <p className={LEAD}>
              Send a task to the cloud and it gets a machine of its own. Close your laptop; it keeps working.
            </p>
          </div>
          <div className="mt-12">
            <PlanCards />
            <p className={`mt-4 text-[14px] ${MUTED}`}>
              Past your plan&apos;s hours, machines stop until the month turns over. Turn on overage to keep going at{" "}
              {OVERAGE}. Prices in US dollars.
            </p>
          </div>

          <section className="mt-20 grid gap-x-12 gap-y-8 sm:grid-cols-2 lg:ml-[102px] lg:max-w-[756px]">
            <h2 className={`${LABEL} sm:col-span-2`}>Every plan</h2>
            {EVERY_PLAN.map(([title, body]) => (
              <div key={title}>
                <p className="text-[16px] leading-6">{title}</p>
                <p className={`mt-1 text-[14px] leading-6 ${MUTED}`}>{body}</p>
              </div>
            ))}
          </section>

          <section className="mt-20 lg:ml-[102px] lg:max-w-[756px]">
            <h2 className={LABEL}>Questions</h2>
            <div className="mt-6 flex flex-col gap-8">
              {FAQ.map(([q, a]) => (
                <div key={q}>
                  <p className="text-[16px] leading-6">{q}</p>
                  <p className={`mt-1 text-[14px] leading-6 ${MUTED}`}>{a}</p>
                </div>
              ))}
            </div>
          </section>
        </div>
      </main>
      <Closing />
    </div>
  );
}
