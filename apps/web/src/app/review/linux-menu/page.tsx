import type { Metadata } from "next";

import { VARIANTS, type Variant } from "@/lib/linux";
import { Hero } from "@/components/home/Hero";

export const metadata: Metadata = {
  title: "Linux menu takes - Dray",
  robots: { index: false },
};

const NAMES: Record<Variant, string> = {
  A: "List",
  B: "Cards",
  C: "Arch toggle",
  D: "Rows",
  E: "Grid",
};

/// The real hero with each take on the Linux menu, opened, and a bar to step
/// between them. For picking one; it goes once the pick ships.
export default async function LinuxMenuReview({ searchParams }: { searchParams: Promise<{ v?: string }> }) {
  const { v } = await searchParams;
  const variant = VARIANTS.find((x) => x === v) ?? "A";

  return (
    <div
      data-home
      className="min-h-screen overflow-x-clip bg-black font-inter text-white antialiased light:bg-white light:text-[#0A0A0A]"
    >
      <Hero key={variant} menu={variant} menuOpen />
      <nav
        aria-label="Menu takes"
        className="fixed bottom-6 left-1/2 z-50 flex -translate-x-1/2 gap-1 rounded-full border border-white/15 bg-[#111112]/95 p-1 shadow-[0_8px_30px_#00000080]"
      >
        {VARIANTS.map((x) => (
          <a
            key={x}
            href={`?v=${x}`}
            className={`rounded-full px-3.5 py-1.5 text-[13px] font-medium transition-colors ${
              x === variant ? "bg-white text-[#0B0B0F]" : "text-white/60 hover:text-white"
            }`}
          >
            {x} · {NAMES[x]}
          </a>
        ))}
      </nav>
    </div>
  );
}
