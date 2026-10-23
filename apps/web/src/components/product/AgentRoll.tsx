import { HARNESSES } from "@/lib/harnesses";

import s from "./hero.module.css";

/// The agents Dray runs, one mark at a time in the headline, each rising in
/// from below to take the last one's place. The first rides again at the end
/// of the column so the loop closes with no jump; under reduced motion only
/// the first shows. The names are read out once, as a list.
export function AgentRoll({ className = "" }: { className?: string }) {
  const marks = [...HARNESSES, HARNESSES[0]];
  return (
    // Each mark rides in a cell taller than itself, so the fade at the slot's
    // top and bottom touches only a mark on the move, never one at rest.
    <span
      className={`relative -my-[0.2em] inline-block h-[1.2em] w-[0.8em] overflow-hidden align-[-0.06em] [mask-image:linear-gradient(transparent,#000_22%,#000_78%,transparent)] ${className}`}
    >
      <span aria-hidden className={`flex flex-col ${s.roll}`}>
        {marks.map(({ name, Glyph }, i) => (
          <span key={`${name}${i}`} className="grid h-[1.2em] shrink-0 place-items-center">
            <Glyph className="block size-[0.8em]" />
          </span>
        ))}
      </span>
      <span className="sr-only">{HARNESSES.map((h) => h.name).join(", ")}</span>
    </span>
  );
}
