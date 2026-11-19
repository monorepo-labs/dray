import type { Metadata } from "next";

import { Closing } from "@/components/home/Closing";
import { SiteNav } from "@/components/home/SiteNav";
import { Support } from "@/components/home/Support";
import { fetchStars } from "@/lib/github";
import { DOWNLOAD } from "@/lib/links";

import { StartDownload, SupportLink } from "../client";
import { H1, LEDE, LINK } from "../styles";

export const metadata: Metadata = {
  title: "Thanks for downloading - Dray",
  description: "Download Dray for macOS.",
  robots: { index: false },
};

/// Where the Download for macOS buttons land: the dmg starts on its own, and
/// the wait is spent on the one ask the site makes and the free ways to help.
/// `/download` itself lists every platform and asks for nothing.
export default async function DownloadThanks() {
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
            <h1 className={H1}>Thanks for downloading Dray.</h1>
            <p className={`mt-4 ${LEDE}`}>
              The download starts on its own. If it didn&apos;t,{" "}
              <SupportLink href={DOWNLOAD} to="dmg" className={LINK}>
                click here
              </SupportLink>
              .
            </p>
            <p className={`mt-2 ${LEDE}`}>
              Not on a Mac?{" "}
              <a href="/download" className={LINK}>
                See every download
              </a>
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
