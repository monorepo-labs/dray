import type { Metadata } from "next";

import { DownloadsShell } from "@/app/download/shell";
import { DOWNLOAD_TAKES, type DownloadTake } from "@/app/download/styles";

export const metadata: Metadata = {
  title: "Download page takes - Dray",
  robots: { index: false },
};

const NAMES: Record<DownloadTake, string> = {
  boxed: "B1 · Boxed",
  bleed: "B2 · Full width",
};

/// The downloads page in each take, with a bar to step between them. For
/// picking one; it goes once the pick ships.
export default async function DownloadsReview({ searchParams }: { searchParams: Promise<{ v?: string }> }) {
  const { v } = await searchParams;
  const take = DOWNLOAD_TAKES.find((x) => x === v) ?? "boxed";

  return (
    <>
      <DownloadsShell key={take} take={take} />
      <nav
        aria-label="Page takes"
        className="fixed bottom-6 left-1/2 z-50 flex -translate-x-1/2 gap-1 rounded-full border border-white/15 bg-[#111112]/95 p-1 shadow-[0_8px_30px_#00000080]"
      >
        {DOWNLOAD_TAKES.map((x) => (
          <a
            key={x}
            href={`?v=${x}`}
            className={`rounded-full px-3.5 py-1.5 text-[13px] font-medium transition-colors ${
              x === take ? "bg-white text-[#0B0B0F]" : "text-white/60 hover:text-white"
            }`}
          >
            {NAMES[x]}
          </a>
        ))}
      </nav>
    </>
  );
}
