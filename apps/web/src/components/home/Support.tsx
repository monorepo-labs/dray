"use client";

import { useState } from "react";

import { GitHubGlyph } from "@/components/GitHubGlyph";
import { GreptileGlyph } from "@/components/GreptileGlyph";
import { SponsorLink } from "@/components/SponsorLink";
import { XGlyph } from "@/components/XGlyph";
import { formatStars } from "@/lib/github";
import { posthog } from "@/lib/posthog";
import { FEEDBACK, GIVE_ONCE, MONTHLY, REPO, SPONSOR } from "@/lib/links";

const LABEL = "font-mono text-[11px] leading-[14px] tracking-[0.06em] uppercase";
const RULE = "border-[#FFFFFF26] light:border-black/15";
/// One credit line: a 28px mark, then grey text with the names lit.
const CREDIT = "flex items-center gap-2.5 text-[15px] leading-[22px] text-white light:text-[#0A0A0A]";
const NAME = "font-medium underline decoration-current/30 underline-offset-4 transition-colors hover:decoration-current";
const AMOUNTS = [5, 10, 25, 50];
/// Dodo raises anything lower to this at checkout, so the page says so first.
const MIN = 5;

/// The one ask the site makes: what it pays for and who backs it, then a one-time
/// amount or a monthly plan, each a Dodo checkout in a new tab.
export function Support({ from, stars = 0 }: { from: "download" | "support"; stars?: number }) {
  const [monthly, setMonthly] = useState(false);
  const [amount, setAmount] = useState(10);
  const [custom, setCustom] = useState("");
  const give = custom ? Math.round(Number(custom)) : amount;
  const valid = Number.isFinite(give) && give >= MIN;

  const tell = (to: "github" | "x") => posthog.capture("support_click", { to, from }, { transport: "sendBeacon" });
  const track = (plan: string, value?: number) =>
    posthog.capture("support_click", { to: "dodo", plan, amount: value, from }, { transport: "sendBeacon" });

  return (
    <>
      <section className={`grid border lg:grid-cols-2 ${RULE}`}>
        <div className={`border-b p-6 sm:p-8 lg:border-r lg:border-b-0 ${RULE}`}>
          <p className={CREDIT}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/avatars/yogesharc.webp" alt="" width={28} height={28} className="size-7 shrink-0 rounded-full" />
            <span>
              Built and maintained by{" "}
              <a
                href={FEEDBACK}
                target="_blank"
                rel="noopener noreferrer"
                className={NAME}
              >
                Yogesh
              </a>
              .
            </span>
          </p>
          <p className={`mt-3 ${CREDIT}`}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/avatars/rauchg.jpg" alt="" width={28} height={28} className="size-7 shrink-0 rounded-full object-cover" />
            <span>
              Sponsored by{" "}
              <SponsorLink href="https://x.com/rauchg" sponsor="guillermo_rauch" destination="support" className={NAME}>
                Guillermo Rauch
              </SponsorLink>, Vercel CEO,{" "}
              through{" "}
              <SponsorLink
                href="https://rauchg-oss-grants.vercel.app/"
                sponsor="guillermo_rauch"
                destination="oss_grants"
                className={NAME}
              >
                OSS Grants
              </SponsorLink>
              .
            </span>
          </p>
        </div>

        <div className="bg-[#141414] p-6 sm:p-8 light:bg-white">
          {/* /support carries the heading and this line as its page headline. */}
          {from === "download" && (
            <h2 className="mb-2 text-[20px] leading-[26px] tracking-[-0.02em] text-white light:text-[#0A0A0A]">Support Dray.</h2>
          )}
          {from === "download" && (
            <p className="mb-6 text-[16px] leading-6 tracking-[-0.01em] text-[#CFCFCF] light:text-[#3D3D3D]">
              Your support helps keep building new features and fixing bugs.
            </p>
          )}
          <div role="tablist" aria-label="How to support" className={`inline-flex border ${RULE}`}>
            {[false, true].map((m) => (
              <button
                key={String(m)}
                type="button"
                role="tab"
                aria-selected={monthly === m}
                onClick={() => setMonthly(m)}
                className={`${LABEL} h-9 px-4 font-medium transition-colors ${m ? `border-l ${RULE}` : ""} ${
                  monthly === m
                    ? "bg-[#1612F8] text-white"
                    : "text-[#A1A1A1] hover:bg-white/10 light:text-[#5C5C5C] light:hover:bg-black/5"
                }`}
              >
                {m ? "Monthly" : "One time"}
              </button>
            ))}
          </div>

          {monthly ? (
            <>
              <div className={`mt-6 border ${RULE} divide-y divide-[#FFFFFF26] light:divide-black/15`}>
                {MONTHLY.map((p) => (
                  <a
                    key={p.name}
                    href={p.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label={`Subscribe: ${p.name}, ${p.price} a month`}
                    onClick={() => track(p.name.toLowerCase())}
                    className="group relative isolate flex items-center justify-between gap-4 px-5 py-4"
                  >
                    <Stripes kind="slide" />
                    <span className="flex flex-col gap-1">
                      <span className={`${LABEL} text-[#7C7C7C] light:text-[#8A8A8A]`}>{p.name}</span>
                      <span className="text-[20px] leading-7 tracking-[-0.02em] text-white light:text-[#0A0A0A]">
                        {p.price}
                        <span className="text-[15px] text-[#7C7C7C] light:text-[#8A8A8A]">/mo</span>
                      </span>
                    </span>
                    <svg
                      aria-hidden
                      viewBox="0 0 20 20"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      className="size-5 shrink-0 text-[#7C7C7C] transition-[color,translate] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] group-hover:translate-x-2 group-hover:text-white light:text-[#8A8A8A] light:group-hover:text-[#0A0A0A]"
                    >
                      <path d="M3 10h13M11 5l5 5-5 5" strokeLinecap="square" />
                    </svg>
                  </a>
                ))}
              </div>
              <p className="mt-3 text-[15px] leading-[22px] text-[#7C7C7C] light:text-[#8A8A8A]">Cancel anytime.</p>
            </>
          ) : (
            <div className="mt-6 flex flex-col gap-4">
              <div className="grid grid-cols-4 gap-2">
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
                      className={`group relative isolate h-10 overflow-hidden border text-[15px] text-white tabular-nums transition-colors ${RULE} light:text-[#0A0A0A] ${on ? "bg-white/10 light:bg-black/[0.06]" : ""}`}
                    >
                      <Stripes on={on} />
                      ${a}
                    </button>
                  );
                })}
                <label
                  className={`col-span-4 flex h-10 min-w-0 items-center gap-1.5 border px-3 text-[15px] transition-colors focus-within:border-white light:focus-within:border-[#0A0A0A] ${
                    custom ? "border-white light:border-[#0A0A0A]" : RULE
                  }`}
                >
                  <span className="text-[#7C7C7C]">$</span>
                  <input
                    type="number"
                    inputMode="numeric"
                    min={MIN}
                    step={1}
                    placeholder="Custom amount"
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
              </div>
            </div>
          )}
          {/* Most people want to use it before they back it, so the download
              page says where the ask lives for later. */}
          {from === "download" && (
            <p className="mt-6 text-[15px] leading-[22px] text-[#7C7C7C] light:text-[#8A8A8A]">
              Support it later any time from the{" "}
              <a href={SPONSOR} className={NAME}>
                Support page
              </a>
              .
            </p>
          )}
        </div>
      </section>

      {from === "download" && (
        <section aria-label="Other ways to help" className="mt-4 text-[15px] leading-6 tracking-[-0.01em] text-[#A1A1A1] light:text-[#5C5C5C]">
          <div className={`grid border sm:grid-cols-2 ${RULE} divide-y divide-[#FFFFFF26] sm:divide-x sm:divide-y-0 light:divide-black/15`}>
            <Way href={REPO} onClick={() => tell("github")} icon={<GitHubGlyph className="size-4" />} title="Star it on GitHub">
              {formatStars(stars)} stars so far. Each one helps someone else find Dray.
            </Way>
            <Way href={FEEDBACK} onClick={() => tell("x")} icon={<XGlyph className="size-3.5" />} title="Follow on X">
              New releases and what comes next, as they happen.
            </Way>
          </div>
        </section>
      )}

      <p className={`mt-6 lg:ml-[102px] ${CREDIT}`}>
        <span className="grid size-7 shrink-0 place-items-center rounded-full bg-[#28E99F]">
          <GreptileGlyph className="h-3.5 w-auto text-[#0A0A0A]" />
        </span>
        <span>
          Every PR is reviewed by{" "}
          <SponsorLink
            href="https://www.greptile.com/open-source"
            sponsor="greptile"
            destination="open_source"
            className={NAME}
          >
            Greptile
          </SponsorLink>
          , free through their open source program.
        </span>
      </p>
    </>
  );
}

const PATTERN = "repeating-linear-gradient(90deg, currentColor 0 1px, transparent 1px 6px)";
const INK = "pointer-events-none absolute inset-0 -z-10 text-white/[0.04] light:text-black/[0.06]";

/// The site's 6px stripes under a button, shown on hover; `on` holds them,
/// which is how a picked amount shows it is picked. `fade` brings the pattern
/// in whole; `slide` drifts it two lines sideways into place as it fades.
function Stripes({ kind = "fade", on = false }: { kind?: "fade" | "slide"; on?: boolean }) {
  return (
    <span
      aria-hidden
      style={{ backgroundImage: PATTERN }}
      className={`${INK} motion-reduce:transition-none ${
        kind === "slide"
          ? `transition-[opacity,background-position] duration-500 ease-[cubic-bezier(0.22,1,0.36,1)] ${
              on
                ? "[background-position-x:0px] opacity-100"
                : "[background-position-x:-12px] opacity-0 group-hover:[background-position-x:0px] group-hover:opacity-100"
            }`
          : `transition-opacity duration-200 ease-out ${on ? "opacity-100" : "opacity-0 group-hover:opacity-100"}`
      }`}
    />
  );
}

/// One of the free ways to help: a whole cell that links out.
function Way({
  href,
  onClick,
  icon,
  title,
  children,
}: {
  href: string;
  onClick: () => void;
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={onClick}
      className="flex flex-col gap-2 p-6 transition-colors hover:bg-white/[0.04] light:hover:bg-black/[0.03]"
    >
      <span className="flex items-center gap-2 text-white light:text-[#0A0A0A]">
        {icon}
        {title}
      </span>
      <span>{children}</span>
    </a>
  );
}
