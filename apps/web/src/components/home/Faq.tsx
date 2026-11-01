"use client";

import { posthog } from "@/lib/posthog";
import { Section } from "@/components/home/Section";

/// Six questions as native disclosures, all closed to start; the glide is CSS alone.
export function Faq() {
  return (
    <Section id="faq" className="py-20">
      <div className="flex flex-col gap-10 lg:flex-row lg:gap-24">
        <div className="flex shrink-0 flex-col gap-3 lg:w-72">
          <p className="font-mono text-[11px] leading-[14px] tracking-[0.06em] text-[#7C7C7C] uppercase">FAQ</p>
          <h2 className="font-inter text-[28px] leading-[32px] font-light tracking-[-0.03em] text-white sm:text-[36px] sm:leading-[40px] light:text-[#0A0A0A]">
            Questions, answered.
          </h2>
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-px">
          {FAQ.map(([q, a]) => (
            <Item key={q} question={q} answer={a} />
          ))}
        </div>
      </div>
    </Section>
  );
}

const FAQ: [string, string][] = [
  [
    "What is Dray?",
    "One app for every coding agent: Claude Code, Codex, Grok Build and more. Run them on any of your machines, a Mac mini or a Linux server, and use them all from your Mac.",
  ],
  [
    "Is it free?",
    "Yes. Dray is free and open source under the Apache 2.0 licence, and runs on the agent subscriptions you already have.",
  ],
  [
    "Which agents does it support?",
    "Claude Code, Codex, pi, fx and Grok Build. Dray runs the agent CLIs you already use, many sessions at once.",
  ],
  [
    "Do I need new accounts or API keys?",
    "No. Each agent keeps its own login, and Dray stores none of them. Sign in to an agent once and Dray uses it.",
  ],
  [
    "Does my code leave my machine?",
    "Not through Dray. Transcripts, settings and attachments stay in ~/.dray on your machine, and its anonymous usage analytics never carry prompts, code or file paths. Your agents talk to their own providers, as they always do.",
  ],
  [
    "Does it run on Linux?",
    "The app is Mac only. Connect a Linux server over SSH and your agents run there, driven from the Mac app.",
  ],
];

// Height animates through `::details-content` with `interpolate-size`; a
// browser lacking either just toggles, and reduced motion drops the transition.
function Item({ question, answer }: { question: string; answer: string }) {
  return (
    // A shared `name` makes the group exclusive: opening one closes the rest.
    <details
      name="faq"
      className="group bg-[#FFFFFF1A] px-6 py-5 not-open:hover:bg-[#FFFFFF24] light:bg-[#F4F4F5] light:not-open:hover:bg-[#EBEBEB] light:open:bg-[#1612F8] [interpolate-size:allow-keywords] open:bg-[#1612F8] details-content:h-0 details-content:overflow-clip open:details-content:h-auto motion-safe:transition-colors motion-safe:details-content:transition-[height,content-visibility] motion-safe:details-content:transition-discrete motion-safe:details-content:duration-300 motion-safe:details-content:ease-out"
    >
      {/* Counted on the click, not on toggle: opening one closes another, and
          that close is no reader's choice. */}
      <summary
        onClick={(e) =>
          posthog.capture("faq_toggle", { question, open: !e.currentTarget.parentElement?.hasAttribute("open") })
        }
        className="flex cursor-pointer list-none items-center justify-between gap-6 [&::-webkit-details-marker]:hidden">
        <span className="text-lg leading-6 tracking-[-0.02em] text-white light:text-[#0A0A0A] light:group-open:text-white">{question}</span>
        {/* A plus whose upright bar turns flat when open, leaving Paper's minus. */}
        <span aria-hidden className="relative size-[11px] shrink-0 text-[#8A8A8A] group-open:text-white">
          <span className="absolute inset-x-0 top-1/2 h-[1.5px] -translate-y-1/2 bg-current" />
          <span className="absolute inset-x-0 top-1/2 h-[1.5px] -translate-y-1/2 rotate-90 bg-current group-open:rotate-0 motion-safe:transition-transform motion-safe:duration-300" />
        </span>
      </summary>
      <p className="pt-2.5 text-[15px] leading-[22px] text-[#FFFFFFCC]">{answer}</p>
    </details>
  );
}
