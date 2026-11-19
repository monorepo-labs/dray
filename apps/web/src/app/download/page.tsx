import type { Metadata } from "next";

import { Closing } from "@/components/home/Closing";
import { SiteNav } from "@/components/home/SiteNav";

import { DownloadCards } from "./cards";
import { H1, LEDE } from "./styles";

export const metadata: Metadata = {
  title: "Download - Dray",
  description:
    "Download Dray for Mac, Linux (beta) and iPhone (TestFlight), or install it on a server. Free and open source.",
};

/// Every way to get Dray, and nothing else: no ask, no auto-start. The
/// Download for macOS buttons elsewhere go by way of `/thank-you`, which
/// starts the dmg and asks for support.
export default function Downloads() {
  return (
    <div
      data-home
      className="min-h-screen overflow-x-clip bg-black font-inter text-white antialiased light:bg-white light:text-[#0A0A0A]"
    >
      <header className="px-5 pb-[120px] sm:px-8 light:bg-[#F4F4F2]">
        <div className="mx-auto w-full max-w-[960px]">
          <SiteNav bare current="download" />
          <div className="lg:ml-[102px] lg:max-w-[756px]">
            <h1 className={H1}>Download Dray</h1>
            <p className={`mt-4 leading-6 tracking-[-0.01em] ${LEDE}`}>For Mac, Linux, servers and iPhone.</p>
          </div>
          <div className="mt-16">
            <DownloadCards />
          </div>
        </div>
      </header>

      <Closing />
    </div>
  );
}
