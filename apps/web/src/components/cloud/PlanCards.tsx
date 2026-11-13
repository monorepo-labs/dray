import { Check } from "lucide-react";

import { LABEL, MUTED, PRIMARY, SECONDARY } from "@/components/account/styles";
import { PLANS, type PlanId } from "@/lib/cloud/plans";

/// The three plans side by side in the site's hairlines. Choose goes through
/// sign-in to Checkout; the reader's own plan reads as current instead.
export function PlanCards({ current = null }: { current?: PlanId | null }) {
  return (
    <div className="grid border border-white/20 sm:grid-cols-3 light:border-black/15">
      {PLANS.map((plan, i) => {
        const here = plan.id === current;
        return (
          <div
            key={plan.id}
            className={`flex flex-col gap-5 p-6 ${i > 0 ? "border-t border-white/20 sm:border-t-0 sm:border-l light:border-black/15" : ""}`}
          >
            <p className={LABEL}>{plan.name}</p>
            <p className="flex items-baseline gap-1.5">
              <span className="text-[36px] leading-[40px] tracking-[-0.03em]">${plan.price}</span>
              <span className={`text-[14px] ${MUTED}`}>a month</span>
            </p>
            <p className={`min-h-12 text-[14px] leading-6 ${MUTED}`}>{plan.blurb}</p>
            <ul className="flex flex-col gap-2 text-[14px] leading-5">
              <Item>{plan.hours} awake hours</Item>
              <Item>{plan.machines} machines at once</Item>
            </ul>
            {here ? (
              <span className={`${SECONDARY} mt-auto cursor-default`}>Your plan</span>
            ) : (
              <a href={`/app/cloud/checkout?plan=${plan.id}`} className={`${plan.id === "pro" ? PRIMARY : SECONDARY} mt-auto`}>
                {current ? `Switch to ${plan.name}` : `Choose ${plan.name}`}
              </a>
            )}
          </div>
        );
      })}
    </div>
  );
}

function Item({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex items-center gap-2">
      <Check className="size-3.5 shrink-0 text-[#7C7C7C] light:text-[#8A8A8A]" />
      {children}
    </li>
  );
}
