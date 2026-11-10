import type { ReactNode } from "react";

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
    <h2
      className={`max-w-[756px] font-inter text-[28px] leading-[32px] font-light tracking-[-0.03em] text-balance text-[#7C7C7C] sm:text-[36px] light:text-[#8A8A8A] sm:leading-[40px] lg:ml-[102px] ${className}`}
    >
      <span className="text-white light:text-[#0A0A0A]">{lead}</span>
      {children && <> {children}</>}
    </h2>
  );
}
