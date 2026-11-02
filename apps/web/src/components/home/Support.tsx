"use client";

import { useState } from "react";

import { posthog } from "@/lib/posthog";
import { GIVE_ONCE, MONTHLY } from "@/lib/links";

const LABEL = "font-mono text-[11px] leading-[14px] tracking-[0.06em] uppercase";
const RULE = "border-white/20 light:border-black/15";
const AMOUNTS = [5, 10, 25, 50];
/// Dodo raises anything lower to this at checkout, so the page says so first.
const MIN = 5;

/// The one ask the site makes: a note, then a one-time amount or a monthly
/// plan, each a Dodo checkout in a new tab.
export function Support({ from }: { from: "download" | "support" }) {
  const [monthly, setMonthly] = useState(false);
  const [amount, setAmount] = useState(10);
  const [custom, setCustom] = useState("");
  const give = custom ? Math.round(Number(custom)) : amount;
  const valid = Number.isFinite(give) && give >= MIN;

  const track = (plan: string, value?: number) =>
    posthog.capture("support_click", { to: "dodo", plan, amount: value, from }, { transport: "sendBeacon" });

  return (
    <section className={`border ${RULE} bg-white/[0.04] light:bg-[#F4F4F5]`}>
      <div className="p-6 sm:p-8">
        <h2 className={`${LABEL} text-[#7C7C7C] light:text-[#8A8A8A]`}>A note from Yogesh</h2>
        <div className="mt-4 max-w-[560px] space-y-4 text-[16px] leading-[26px] tracking-[-0.01em] text-[#CFCFCF] light:text-[#3D3D3D]">
          <p>
            Dray is free and open source, and I build it on my own. Every harness, every release and every fix comes
            from one person.
          </p>
          <p>If it saves you time, supporting it is what keeps it going. Any amount helps.</p>
        </div>
      </div>

      <div className={`border-t p-6 sm:p-8 ${RULE}`}>
        <div role="tablist" aria-label="How to support" className={`inline-flex border ${RULE}`}>
          {[false, true].map((m) => (
            <button
              key={String(m)}
              type="button"
              role="tab"
              aria-selected={monthly === m}
              onClick={() => setMonthly(m)}
              className={`${LABEL} h-9 px-4 transition-colors ${m ? `border-l ${RULE}` : ""} ${
                monthly === m
                  ? "bg-white text-[#0A0A0A] light:bg-[#0A0A0A] light:text-white"
                  : "text-[#A1A1A1] hover:bg-white/10 light:text-[#5C5C5C] light:hover:bg-black/5"
              }`}
            >
              {m ? "Monthly" : "One time"}
            </button>
          ))}
        </div>

        {monthly ? (
          <div className={`mt-6 grid border sm:grid-cols-3 ${RULE} divide-y divide-white/20 sm:divide-x sm:divide-y-0 light:divide-black/15`}>
            {MONTHLY.map((p) => (
              <a
                key={p.name}
                href={p.href}
                target="_blank"
                rel="noopener noreferrer"
                onClick={() => track(p.name.toLowerCase())}
                className="group flex flex-col gap-1 p-5 transition-colors hover:bg-white/[0.06] light:hover:bg-black/[0.04]"
              >
                <span className={`${LABEL} text-[#7C7C7C] light:text-[#8A8A8A]`}>{p.name}</span>
                <span className="text-[24px] leading-8 tracking-[-0.02em] text-white light:text-[#0A0A0A]">
                  {p.price}
                  <span className="text-[14px] text-[#7C7C7C] light:text-[#8A8A8A]">/mo</span>
                </span>
                <span className="mt-3 text-[14px] text-[#A1A1A1] transition-colors group-hover:text-white light:text-[#5C5C5C] light:group-hover:text-[#0A0A0A]">
                  Subscribe →
                </span>
              </a>
            ))}
          </div>
        ) : (
          <div className="mt-6 flex flex-col gap-4">
            <div className="flex flex-wrap gap-2">
              {AMOUNTS.map((a) => {
                const on = !custom && amount === a;
                return (
                  <button
                    key={a}
                    type="button"
                    aria-pressed={on}
                    onClick={() => {
                      setAmount(a);
                      setCustom("");
                    }}
                    className={`h-10 min-w-16 border px-4 text-[15px] tabular-nums transition-colors ${
                      on
                        ? "border-white bg-white text-[#0A0A0A] light:border-[#0A0A0A] light:bg-[#0A0A0A] light:text-white"
                        : `${RULE} text-white hover:bg-white/10 light:text-[#0A0A0A] light:hover:bg-black/5`
                    }`}
                  >
                    ${a}
                  </button>
                );
              })}
              <label
                className={`flex h-10 w-32 items-center gap-1 border px-3 text-[15px] transition-colors focus-within:border-white light:focus-within:border-[#0A0A0A] ${
                  custom ? "border-white light:border-[#0A0A0A]" : RULE
                }`}
              >
                <span className="text-[#7C7C7C]">$</span>
                <input
                  type="number"
                  inputMode="numeric"
                  min={MIN}
                  step={1}
                  placeholder="Other"
                  aria-label="Custom amount in dollars"
                  value={custom}
                  onChange={(e) => setCustom(e.target.value)}
                  className="w-full min-w-0 bg-transparent tabular-nums text-white outline-none placeholder:text-[#7C7C7C] [appearance:textfield] light:text-[#0A0A0A] [&::-webkit-inner-spin-button]:appearance-none"
                />
              </label>
            </div>
            <div className="flex flex-wrap items-center gap-4">
              <a
                href={valid ? `${GIVE_ONCE}&paymentAmount=${give}` : undefined}
                target="_blank"
                rel="noopener noreferrer"
                aria-disabled={!valid}
                onClick={() => valid && track("once", give)}
                className="inline-flex h-10 items-center rounded-[6px] bg-white px-4 text-[14px] leading-5 font-medium text-[#0B0B0F] shadow-[inset_0_-1px_0_#4D4C4C,0_1px_2px_#00000040] transition-opacity hover:opacity-90 aria-disabled:pointer-events-none aria-disabled:opacity-40 light:bg-[#0A0A0A] light:text-white light:shadow-[inset_0_-1px_0_#000,0_1px_2px_#00000040]"
              >
                {valid ? `Support with $${give}` : `$${MIN} minimum`}
              </a>
              <p className="text-[13px] text-[#7C7C7C] light:text-[#8A8A8A]">Paid securely through Dodo Payments.</p>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
