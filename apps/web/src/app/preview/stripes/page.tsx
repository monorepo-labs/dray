import type { Metadata } from "next";

import { SiteNav } from "@/components/home/SiteNav";

import { Variants } from "./Variants";

export const metadata: Metadata = { robots: { index: false, follow: false } };

/// Candidates for how the support picker's amount buttons draw their stripes
/// on hover and when picked. The nav's toggle switches light and dark.
export default function StripesPreview() {
  return (
    <div
      data-home
      className="min-h-screen bg-black px-5 pb-24 font-inter text-white antialiased sm:px-8 light:bg-[#F4F4F2] light:text-[#0A0A0A]"
    >
      <div className="mx-auto w-full max-w-[960px]">
        <SiteNav bare />
        <h1 className="pt-16 text-[36px] leading-[40px] tracking-[-0.03em]">Stripe hover</h1>
        <p className="mt-3 mb-10 text-[16px] text-[#7C7C7C] light:text-[#8A8A8A]">
          Hover the amounts, click one to pick it.
        </p>
        <Variants />
      </div>
    </div>
  );
}
