import { Closing } from "@/components/home/Closing";
import { SiteNav } from "@/components/home/SiteNav";

import { H1, LEDE, type DownloadTake } from "./styles";
import { DownloadTakeBody } from "./takes";

/// Every way to get Dray, and nothing else: no ask, no auto-start. The
/// Download for macOS buttons elsewhere go by way of `/thank-you`, which
/// starts the dmg and asks for support.
export function DownloadsShell({ take }: { take: DownloadTake }) {
  return (
    <div
      data-home
      className="min-h-screen overflow-x-clip bg-black font-inter text-white antialiased light:bg-white light:text-[#0A0A0A]"
    >
      <header className="px-5 pb-[120px] sm:px-8 light:bg-[#F4F4F2]">
        <div className="mx-auto w-full max-w-[960px]">
          <SiteNav bare />
          <div className="lg:ml-[102px] lg:max-w-[756px]">
            <h1 className={H1}>Download Dray</h1>
            <p className={`mt-4 ${LEDE}`}>Free and open source, on your computer or your servers.</p>
          </div>
          <div className="mt-12">
            <DownloadTakeBody take={take} />
          </div>
        </div>
      </header>

      <Closing />
    </div>
  );
}
