import type { Metadata } from "next";

import { Closing } from "@/components/home/Closing";
import { SiteNav } from "@/components/home/SiteNav";
import { Support } from "@/components/home/Support";

export const metadata: Metadata = {
  title: "Support - Dray",
  description: "Dray is free and open source. Support it once or monthly.",
};

/// Where the nav's and footer's Sponsor links go: the download page's ask,
/// without the download.
export default function SupportPage() {
  return (
    <div
      data-home
      className="min-h-screen overflow-x-clip bg-black font-inter text-white antialiased light:bg-white light:text-[#0A0A0A]"
    >
      <main className="px-5 pb-[120px] sm:px-8">
        <div className="mx-auto w-full max-w-[960px]">
          <SiteNav />
          <div>
            <div className="lg:ml-[102px] lg:max-w-[756px]">
              <h1 className="pt-16 font-inter text-[36px] leading-[40px] font-normal tracking-[-0.03em] text-balance sm:pt-[101px] sm:text-[46px] sm:leading-[46px]">
                Support Dray.
              </h1>
              <p className="mt-4 text-[16px] leading-6 tracking-[-0.01em] text-[#7C7C7C] light:text-[#8A8A8A]">
                Free and open source, kept going by the people who use it.
              </p>
            </div>
            <div className="mt-12">
              <Support from="support" />
            </div>
          </div>
        </div>
      </main>
      <Closing />
    </div>
  );
}
