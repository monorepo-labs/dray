/// The download pages' type, shared by `/download` and `/thank-you`.
export const H1 =
  "pt-16 font-inter text-[28px] leading-[32px] font-normal tracking-[-0.03em] text-balance text-white sm:pt-[101px] sm:text-[36px] sm:leading-[40px] light:text-[#0A0A0A]";
export const LEDE = "text-[16px] text-[#7C7C7C] light:text-[#8A8A8A]";
export const LINK =
  "text-white underline decoration-white/30 underline-offset-4 transition-colors hover:decoration-white light:text-[#0A0A0A] light:decoration-black/30 light:hover:decoration-black";

/// The downloads page's takes, stepped through on `/review/downloads` while
/// one is picked. `/download` draws `tiles`.
export const DOWNLOAD_TAKES = ["tiles", "panels"] as const;
export type DownloadTake = (typeof DOWNLOAD_TAKES)[number];
