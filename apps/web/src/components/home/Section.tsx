import type { ReactNode } from "react";

// The homepage's one type scale and card surface. Every section reads from
// these, so a section title, a card's title or a label looks the same wherever it sits.
export const TITLE_TYPE = "font-inter text-[28px] leading-[32px] font-light tracking-[-0.03em] sm:text-[36px] sm:leading-[40px]";
export const CARD_TITLE = "text-xl leading-[26px] tracking-[-0.02em] text-balance text-white light:text-[#0A0A0A]";
export const CARD_BODY = "text-[15px] leading-[22px] text-[#8A8A8A] light:text-[#6B6B6B]";
/// A small card's one line: a quote, an agent's name, a question.
export const CARD_TEXT = "text-[17px] leading-6 tracking-[-0.01em] text-white light:text-[#0A0A0A]";
export const LABEL = "font-mono text-[11px] leading-[14px] tracking-[0.06em] uppercase";
export const CARD = "bg-[#FFFFFF1A] light:bg-[#EFEFF1]";
/// Cards sit in grids 2px apart, under a title by the same gap in every section.
export const GRID = "mt-12 grid gap-[2px] lg:mt-20";

/// One band of the homepage: black (white in light), full width, content in a
/// 960 column with gutters on anything narrower.
export function Section({ id, className = "", children }: { id?: string; className?: string; children: ReactNode }) {
  return (
    <section id={id} className={`relative overflow-clip bg-black px-5 sm:px-8 ${className.includes("light:bg-") ? "" : "light:bg-white"} ${className}`}>
      <div className="relative mx-auto w-full max-w-[960px]">{children}</div>
    </section>
  );
}

/// The section headline: a white lead, then the rest in grey, inset to line up
/// with the hero's headline on wide screens.
export function Title({ lead, children, className = "" }: { lead: string; children?: ReactNode; className?: string }) {
  return (
    <h2 className={`max-w-[756px] text-balance text-[#7C7C7C] light:text-[#8A8A8A] lg:ml-[102px] ${TITLE_TYPE} ${className}`}>
      <span className="text-white light:text-[#0A0A0A]">{lead}</span>
      {children && <> {children}</>}
    </h2>
  );
}

/// The homepage's one feature card: a drawing, then a title and an optional
/// line under it. The drawing's height is fixed on wide screens so titles in a
/// row start level however many lines each wraps to.
export function Tile({
  title,
  body,
  children,
  className = "",
  artClassName = "lg:h-[360px]",
}: {
  title: ReactNode;
  body?: ReactNode;
  children: ReactNode;
  className?: string;
  artClassName?: string;
}) {
  return (
    <div className={`relative flex flex-col overflow-clip ${CARD} ${className}`}>
      <div aria-hidden className={`flex flex-1 shrink-0 flex-col justify-center px-6 py-12 sm:px-10 lg:flex-none lg:py-0 ${artClassName}`}>
        {children}
      </div>
      <div className="relative flex flex-col gap-2 px-6 pt-2 pb-6">
        <h3 className={CARD_TITLE}>{title}</h3>
        {body && <p className={`max-w-[431px] ${CARD_BODY}`}>{body}</p>}
      </div>
    </div>
  );
}
