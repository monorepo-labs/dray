"use client";

import { posthog } from "@/lib/posthog";
import type { FaqEntry } from "@/lib/faq";

/// One question as a native disclosure, drawn like the homepage FAQ's rows.
/// A copy rather than an import, so the homepage can be rebuilt without this
/// page moving with it.
// Height animates through `::details-content` with `interpolate-size`; a
// browser lacking either just toggles, and reduced motion drops the transition.
export function FaqItem({ entry: { q, a, link } }: { entry: FaqEntry }) {
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
          posthog.capture("faq_toggle", { question: q, page: "faq", open: !e.currentTarget.parentElement?.hasAttribute("open") })
        }
        className="flex cursor-pointer list-none items-center justify-between gap-6 [&::-webkit-details-marker]:hidden"
      >
        <span className="text-lg leading-6 tracking-[-0.02em] text-white light:text-[#0A0A0A] light:group-open:text-white">{q}</span>
        {/* A plus whose upright bar turns flat when open, leaving a minus. */}
        <span aria-hidden className="relative size-[11px] shrink-0 text-[#8A8A8A] group-open:text-white">
          <span className="absolute inset-x-0 top-1/2 h-[1.5px] -translate-y-1/2 bg-current" />
          <span className="absolute inset-x-0 top-1/2 h-[1.5px] -translate-y-1/2 rotate-90 bg-current group-open:rotate-0 motion-safe:transition-transform motion-safe:duration-300" />
        </span>
      </summary>
      <p className="pt-2.5 text-[15px] leading-[22px] text-pretty text-[#FFFFFFCC]">{a}</p>
      {link && (
        <a
          href={link.href}
          className="mt-3 inline-block text-[15px] leading-[22px] text-white underline decoration-white/40 underline-offset-4 transition-colors hover:decoration-white"
        >
          {link.label}
        </a>
      )}
    </details>
  );
}
