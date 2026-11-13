import { Check } from "lucide-react";

import { LABEL, MUTED, PRIMARY, SECONDARY } from "@/components/account/styles";
import { PLAN_IDS, PLANS, type PlanId } from "@/lib/cloud/plans";

const BLURBS: Record<PlanId, string> = {
  starter: "A few tasks a day off your laptop.",
  pro: "Agents working all day, in parallel.",
  max: "A fleet for every repo you own.",
};

/// The three plans side by side in the site's hairlines. Choosing happens on
/// the billing page (#1023), which signs the reader in first.
export function PlanCards({ current = null }: { current?: PlanId | null }) {
  return (
    <div className="grid border border-white/20 sm:grid-cols-3 light:border-black/15">
      {PLAN_IDS.map((id, i) => {
        const plan = PLANS[id];
        return (
          <div
            key={id}
            className={`flex flex-col gap-5 p-6 ${i > 0 ? "border-t border-white/20 sm:border-t-0 sm:border-l light:border-black/15" : ""}`}
          >
            <p className={LABEL}>{plan.name}</p>
            <p className="flex items-baseline gap-1.5">
              <span className="text-[36px] leading-[40px] tracking-[-0.03em]">${plan.dollars}</span>
              <span className={`text-[14px] ${MUTED}`}>a month</span>
            </p>
            <p className={`min-h-12 text-[14px] leading-6 ${MUTED}`}>{BLURBS[id]}</p>
            <p className="flex items-center gap-2 text-[14px] leading-5">
              <Check className="size-3.5 shrink-0 text-[#7C7C7C] light:text-[#8A8A8A]" />
              {plan.hours.toLocaleString("en-US")} awake hours
            </p>
            {id === current ? (
              <span className={`${SECONDARY} mt-auto cursor-default`}>Your plan</span>
            ) : (
              <a href="/app/account/billing" className={`${id === "pro" ? PRIMARY : SECONDARY} mt-auto`}>
                {current ? `Switch to ${plan.name}` : `Choose ${plan.name}`}
              </a>
            )}
          </div>
        );
      })}
    </div>
  );
}
