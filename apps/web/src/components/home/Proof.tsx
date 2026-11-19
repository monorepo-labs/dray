import { CARD, LABEL, Section } from "@/components/home/Section";

/// Yogesh's own numbers: the quote on one blue card, then the week before
/// Dray Bot beside the two days with it, one square per merged PR.
export function Proof() {
  return (
    <Section id="proof" className="py-20">
      <figure className="grid gap-[2px]">
        <div className="bg-[#1612F8] p-6 sm:p-8">
          <blockquote className="max-w-[760px] text-[26px] leading-8 font-light tracking-[-0.03em] text-balance text-white sm:text-4xl sm:leading-11">
            “84 PRs merged in 2 days with Dray Bot and sandboxes. My old average was 50 a week.”
          </blockquote>
          <figcaption className="mt-8 flex items-center gap-3">
            <img src="/avatars/yogesharc.webp" alt="" width={40} height={40} loading="lazy" className="size-10 shrink-0 rounded-full object-cover" />
            <span className="flex flex-col gap-0.5">
              <span className="text-[15px] leading-5 text-white">Yogesh</span>
              <span className={`text-white/70 ${LABEL}`}>Founder of Dray</span>
            </span>
          </figcaption>
        </div>
        <div className="grid gap-[2px] sm:grid-cols-2">
          <Stat count={50} caption="PRs a week, before Dray Bot." old />
          <Stat count={84} caption="PRs in 2 days, with Dray Bot." />
        </div>
      </figure>
    </Section>
  );
}

const COLUMNS = 15;

function Stat({ count, caption, old = false }: { count: number; caption: string; old?: boolean }) {
  const rows = Math.ceil(count / COLUMNS);
  const squares = Array.from({ length: count }, (_, i) => `M${(i % COLUMNS) * 20} ${Math.floor(i / COLUMNS) * 20}h16v16h-16z`).join("");
  return (
    <div className={`flex flex-col justify-between gap-10 p-6 ${CARD}`}>
      <svg aria-hidden viewBox={`0 0 296 ${rows * 20 - 4}`} className="w-full max-w-[296px]">
        <path d={squares} className={old ? "fill-white/25 light:fill-black/20" : "fill-[#39D353]"} />
      </svg>
      <p className="flex flex-col gap-1">
        <span
          className={`text-8xl leading-24 font-light tracking-[-0.04em] ${old ? "text-white/60 light:text-black/45" : "text-white light:text-[#0A0A0A]"}`}
        >
          {count}
        </span>
        <span className="text-[15px] leading-[22px] text-white/80 light:text-black/70">{caption}</span>
      </p>
    </div>
  );
}
