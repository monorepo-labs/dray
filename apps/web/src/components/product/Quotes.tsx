import { XGlyph } from "@/components/XGlyph";
import { TESTIMONIALS, type Testimonial } from "@/lib/testimonials";
import s from "./hero.module.css";

/// What people said, as two rows drifting in opposite directions. The posts
/// are short reactions, so a wall of boxes left most of each box empty; a
/// moving row reads them at the length they are.
export function Quotes({ className = "" }: { className?: string }) {
  const half = Math.ceil(TESTIMONIALS.length / 2);
  const rows = [TESTIMONIALS.slice(0, half), TESTIMONIALS.slice(half)];
  return (
    <div
      className={`flex flex-col gap-3 overflow-hidden ${s.quotes} ${className}`}
      style={{
        maskImage: "linear-gradient(to right, transparent, black 8%, black 92%, transparent)",
        WebkitMaskImage: "linear-gradient(to right, transparent, black 8%, black 92%, transparent)",
      }}
    >
      {rows.map((row, r) => (
        <div key={r} className={`flex w-max gap-3 ${s.marquee}`} data-reverse={r ? "" : undefined}>
          {[...row, ...row].map((t, i) => (
            <Quote key={i} t={t} hidden={i >= row.length} />
          ))}
        </div>
      ))}
    </div>
  );
}

/// One post: the words first, then who said them. The second copy of each
/// row is for the loop alone, so it is hidden from screen readers and tab.
function Quote({ t, hidden }: { t: Testimonial; hidden: boolean }) {
  return (
    <a
      href={t.url}
      target="_blank"
      rel="noopener noreferrer"
      aria-hidden={hidden || undefined}
      tabIndex={hidden ? -1 : undefined}
      // A border, not a ring: a ring is drawn outside the box, where the row's
      // overflow clipping cut its top and bottom edges off.
      className="flex w-[300px] shrink-0 flex-col justify-between gap-5 rounded-2xl border-[0.5px] border-white/[0.03] bg-white/[0.1] p-5 transition-colors hover:bg-white/[0.13]"
    >
      <blockquote className="text-[15px] leading-snug font-medium text-white/90 text-pretty whitespace-pre-line">{t.text}</blockquote>
      <span className="flex items-center gap-2.5">
        {t.avatar ? (
          <img src={t.avatar} alt="" width={28} height={28} className="size-7 rounded-full object-cover" />
        ) : (
          <span className="grid size-7 place-items-center rounded-full bg-white/10 text-xs">{t.name.charAt(0)}</span>
        )}
        <span className="min-w-0 text-sm leading-tight">
          <span className="block truncate font-semibold">{t.name}</span>
          <span className="block truncate text-muted-foreground">@{t.handle}</span>
        </span>
        <XGlyph className="ml-auto size-3.5 shrink-0 text-muted-foreground/60" />
      </span>
    </a>
  );
}
