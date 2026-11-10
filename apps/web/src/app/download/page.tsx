import type { Metadata } from "next";

import { Closing } from "@/components/home/Closing";
import { SiteNav } from "@/components/home/SiteNav";
import { Support } from "@/components/home/Support";
import { fetchStars } from "@/lib/github";
import { DOWNLOAD } from "@/lib/links";

import { StartDownload, SupportLink } from "./client";

export const metadata: Metadata = {
  title: "Download - Dray",
  description: "Download Dray for macOS.",
};

/// Where every Download button lands: the dmg starts on its own, and the wait
/// is spent on the one ask the site makes and the free ways to help.
export default async function Download() {
  const stars = await fetchStars();

  return (
    <div
      data-home
      className="min-h-screen overflow-x-clip bg-black font-inter text-white antialiased light:bg-white light:text-[#0A0A0A]"
    >
      <StartDownload />
      <header className="px-5 pb-[120px] sm:px-8 light:bg-[#F4F4F2]">
        <div className="mx-auto w-full max-w-[960px]">
          <SiteNav bare />
          <div className="lg:ml-[102px] lg:max-w-[756px]">
            <h1 className="pt-16 font-inter text-[28px] leading-[32px] font-normal tracking-[-0.03em] text-balance text-white sm:pt-[101px] sm:text-[36px] sm:leading-[40px] light:text-[#0A0A0A]">
              Thanks for downloading Dray.
            </h1>
            <p className="mt-4 text-[16px] text-[#7C7C7C] light:text-[#8A8A8A]">
              The download starts on its own. If it didn't,{" "}
              <SupportLink
                href={DOWNLOAD}
                to="dmg"
                className="text-white underline decoration-white/30 underline-offset-4 transition-colors hover:decoration-white light:text-[#0A0A0A] light:decoration-black/30 light:hover:decoration-black"
              >
                click here
              </SupportLink>
              .
            </p>
          </div>

          <div className="mt-12">
            <Support from="download" stars={stars} />
          </div>
        </div>
      </header>

      <Closing />
    </div>
  );
}
