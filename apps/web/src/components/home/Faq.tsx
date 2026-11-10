"use client";

import { posthog } from "@/lib/posthog";
import { Section } from "@/components/home/Section";

/// Six questions as native disclosures, all closed to start; the glide is CSS alone.
export function Faq() {
  return (
    <Section id="faq" className="py-20">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: FAQ_SCHEMA }} />
      <div className="flex flex-col gap-10 lg:flex-row lg:gap-24">
        <div className="flex shrink-0 flex-col gap-3 lg:w-72">
          <h2 className="font-inter text-[28px] leading-[32px] font-light tracking-[-0.03em] text-white sm:text-[36px] sm:leading-[40px] light:text-[#0A0A0A]">
            Frequently Asked Questions
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
    "Dray is one Mac app for every coding agent. Run them on your Mac or on your other machines.",
  ],
  [
    "Is Dray free?",
    "Yes. Dray is free and open source under Apache 2.0.",
  ],
  [
    "Which agents does Dray support?",
    "Dray supports Claude Code, Codex, pi, fx and Grok Build.",
  ],
  [
    "Is Dray safe to use with my Claude subscription?",
    "Yes. Dray runs Anthropic's own Claude Code CLI so it works within their terms.",
  ],
  [
    "Does Dray send my code off my machine?",
    "No. Dray keeps your data on your machine. Your agents talk to their own providers, as usual.",
  ],
  [
    "Does Dray run on Linux?",
    "Yes, as a server. Your agents run on Linux, and you drive them from the Dray app on your Mac.",
  ],
];

// Google's FAQ rich result; `<` escaped so no answer can close the script tag.
const FAQ_SCHEMA = JSON.stringify({
  "@context": "https://schema.org",
  "@type": "FAQPage",
  mainEntity: FAQ.map(([name, text]) => ({
    "@type": "Question",
    name,
    acceptedAnswer: { "@type": "Answer", text },
  })),
}).replace(/</g, "\\u003c");

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
