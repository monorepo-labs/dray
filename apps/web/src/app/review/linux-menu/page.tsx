import type { Metadata } from "next";

import { Hero } from "@/components/home/Hero";
import { BETA_SPOTS, type BetaSpot } from "@/lib/linux";

export const metadata: Metadata = {
  title: "Linux menu Beta tag - Dray",
  robots: { index: false },
};

const NAMES: Record<BetaSpot, string> = {
  footer: "1 · Footer line",
  edge: "2 · On the edge",
  centre: "3 · Tag under cards",
};

/// The real hero with the Linux menu open, its Beta tag in each spot, and a
/// bar to step between them. For picking one; it goes once the pick ships.
export default async function LinuxMenuReview({ searchParams }: { searchParams: Promise<{ beta?: string }> }) {
  const { beta } = await searchParams;
  const spot = BETA_SPOTS.find((x) => x === beta) ?? "footer";

  return (
    <div
      data-home
      className="min-h-screen overflow-x-clip bg-black font-inter text-white antialiased light:bg-white light:text-[#0A0A0A]"
    >
      <Hero key={spot} beta={spot} menuOpen />
      <nav
        aria-label="Beta spots"
        className="fixed bottom-6 left-1/2 z-50 flex -translate-x-1/2 gap-1 rounded-full border border-white/15 bg-[#111112]/95 p-1 shadow-[0_8px_30px_#00000080]"
      >
        {BETA_SPOTS.map((x) => (
          <a
            key={x}
            href={`?beta=${x}`}
            className={`rounded-full px-3.5 py-1.5 text-[13px] font-medium transition-colors ${
              x === spot ? "bg-white text-[#0B0B0F]" : "text-white/60 hover:text-white"
            }`}
          >
            {NAMES[x]}
          </a>
        ))}
      </nav>
    </div>
  );
}
