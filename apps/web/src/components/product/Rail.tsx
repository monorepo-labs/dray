"use client";

import { useRef } from "react";
import { ArrowLeft, ArrowRight } from "lucide-react";

import { GLASS_ICON_BUTTON } from "./buttons";

/// A row of cards that runs off the right edge of the page and scrolls. It
/// starts on the text column's left edge, so the first card lines up with
/// the heading above it, and the arrows are for a mouse, which has no
/// sideways scroll of its own.
///
/// `inset` is the column's own gutter: the row is full-bleed, and padding
/// it by the gap between the viewport and the column is what lines it up.
export function Rail({ children, label }: { children: React.ReactNode; label: string }) {
  const row = useRef<HTMLDivElement>(null);
  const step = (dir: 1 | -1) => {
    const el = row.current;
    const card = el?.firstElementChild as HTMLElement | null;
    if (el && card) el.scrollBy({ left: dir * (card.offsetWidth + 16), behavior: "smooth" });
  };
  const inset = "max(1rem, calc((100vw - 64rem) / 2 + 1.5rem))";

  return (
    <div>
      <div
        ref={row}
        role="region"
        aria-label={label}
        tabIndex={0}
        className="flex snap-x snap-mandatory gap-4 overflow-x-auto pb-2 outline-none [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        style={{ paddingInline: inset, scrollPaddingInline: inset }}
      >
        {children}
      </div>
      <div className="mx-auto mt-5 flex w-full max-w-5xl justify-end gap-2 px-4 sm:px-6">
        {([-1, 1] as const).map((dir) => (
          <button
            key={dir}
            type="button"
            aria-label={dir < 0 ? "Previous" : "Next"}
            onClick={() => step(dir)}
            className={GLASS_ICON_BUTTON}
          >
            {dir < 0 ? <ArrowLeft className="size-4" /> : <ArrowRight className="size-4" />}
          </button>
        ))}
      </div>
    </div>
  );
}
