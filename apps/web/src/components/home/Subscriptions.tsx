import type { ReactNode } from "react";
import { ClaudeGlyph } from "@/components/ClaudeGlyph";
import { FxGlyph } from "@/components/FxGlyph";
import { GrokGlyph } from "@/components/GrokGlyph";
import { OpenAIGlyph } from "@/components/OpenAIGlyph";
import { PiGlyph } from "@/components/PiGlyph";
import { Section, Title } from "@/components/home/Section";

const AGENTS: [string, ReactNode][] = [
  ["Claude Code", <ClaudeGlyph key="claude" className="size-10" />],
  ["Codex", <OpenAIGlyph key="codex" className="size-10 opacity-80" />],
  ["pi", <PiGlyph key="pi" className="size-10" />],
  ["fx", <FxGlyph key="fx" className="size-10 opacity-80" />],
  ["Grok", <GrokGlyph key="grok" className="size-10 opacity-80" />],
];

/// The agents a reader already pays for: a title, one row of logo cards, and
/// the blue pixel field spilling off the row's corner.
export function Subscriptions() {
  return (
    <Section id="subscriptions" className="py-20">
      <PixelField />
      <Title lead="Bring your own agent subscription." />
      <div className="relative mt-12 grid grid-cols-2 gap-px sm:grid-cols-3 lg:mt-20 lg:grid-cols-5">
        {AGENTS.map(([name, glyph]) => (
          <div
            key={name}
            className="flex h-[132px] flex-col sm:h-[180px] justify-between bg-[#FFFFFF1A] p-6 text-white light:bg-[#F4F4F5] light:text-[#0A0A0A]"
          >
            {glyph}
            <span className="text-[17px] leading-6 tracking-[-0.01em]">{name}</span>
          </div>
        ))}
      </div>
    </Section>
  );
}

// [column, row, shade] on a 20px grid, drawn once in Paper and kept as drawn:
// a cluster rising from the cards' top-right corner, brightest nearest it.
const SHADES = ["#08066B", "#0B09A0", "#110ED0", "#1612F8", "#3B38FF"];
const PIXELS = [
  [6,0,1],[7,0,2],[8,0,2],[11,0,3],[17,0,1],[4,1,1],[5,1,1],[7,1,2],[9,1,2],[11,1,2],[15,1,1],[16,1,2],[18,1,1],[19,1,0],
  [8,2,2],[12,2,3],[14,2,3],[15,2,3],[16,2,2],[17,2,2],[20,2,1],[6,3,2],[7,3,3],[8,3,2],[9,3,4],[10,3,3],[11,3,3],[13,3,3],
  [15,3,2],[4,4,2],[5,4,2],[6,4,3],[9,4,4],[10,4,4],[11,4,3],[13,4,4],[14,4,4],[15,4,3],[17,4,3],[20,4,1],[21,4,0],[7,5,3],
  [11,5,4],[12,5,4],[13,5,4],[14,5,4],[15,5,3],[12,6,4],[13,6,4],[16,6,2],[18,6,1],[13,7,3],[15,7,3],[18,7,2],[19,7,1],
  [12,8,4],[13,8,4],[14,8,2],[12,9,3],[13,9,3],[14,9,2],[15,9,2],[12,10,3],[13,10,2],[14,10,2],[12,11,2],[12,13,2],[13,13,1],
];

/// Placed off the column's right edge on purpose: it bleeds toward the page
/// edge, and the cards sit over the part that would fall behind them.
function PixelField() {
  return (
    <svg
      aria-hidden
      width="480"
      height="300"
      viewBox="0 0 480 300"
      className="pointer-events-none absolute top-0 left-[720px] max-lg:hidden"
    >
      {PIXELS.map(([x, y, s]) => (
        <rect key={`${x}-${y}`} x={x * 20} y={y * 20} width="20" height="20" fill={SHADES[s]} />
      ))}
    </svg>
  );
}
