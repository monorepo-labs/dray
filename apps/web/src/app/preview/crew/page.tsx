import type { Metadata } from "next";

import { CrewArt, CrewSteps } from "@/components/product/CrewArt";

export const metadata: Metadata = { robots: { index: false, follow: false } };

/// The "crew of agents" picture on its own, to judge before it goes on the page.
export default function Crew() {
  return (
    <div className="min-h-screen bg-[oklch(0.115_0_0)] px-4 py-12 sm:px-8">
      <div className="mx-auto max-w-5xl">
        <h1 className="font-display text-2xl font-medium">Crew of agents</h1>
        <section className="mt-8 grid items-center gap-10 lg:grid-cols-[5fr_6fr]">
          <CrewSteps />
          <CrewArt className="mx-auto max-w-[480px]" />
        </section>
      </div>
    </div>
  );
}
