import { preload } from "react-dom";
import { DownloadButton } from "@/components/DownloadButton";
import { Hero as AppWindow } from "@/components/illustrations/Hero";
import { SponsorLink } from "@/components/SponsorLink";
import h from "./hero.module.css";
import { HeroBackdrop } from "./HeroBackdrop";
import { SiteNav } from "./SiteNav";

/// The top of the page: nav, headline, the live app window and the sponsor line,
/// over the pixel-blue backdrop.
export function Hero() {
  // The phone still is the page's LCP, and lazy loading started it only after
  // layout. A preload in <head> starts it at once for the system's scheme; a
  // saved pick that disagrees falls back to the lazy <img> below.
  preload("/hero-mobile.webp", { as: "image", fetchPriority: "high", media: "(max-width: 639px) and (prefers-color-scheme: dark)" });
  preload("/hero-mobile-light.webp", { as: "image", fetchPriority: "high", media: "(max-width: 639px) and (prefers-color-scheme: light)" });

  return (
    <>
    <header id="hero" className="relative overflow-clip bg-black px-5 pb-14 sm:px-8 sm:pb-10 light:bg-[linear-gradient(#FFFFFF_900px,#F4F4F2_900px)]">
      <HeroBackdrop />

      <div className="relative mx-auto w-full max-w-[960px]">
        <SiteNav />

        <div className="pt-16 sm:pt-[101px] lg:ml-[102px] lg:max-w-[756px]">
          <h1 className="font-inter text-[36px] leading-[40px] font-normal tracking-[-0.03em] text-balance text-white sm:text-[46px] light:text-[#0A0A0A] sm:leading-[46px]">
            Run every agent harness in one app.
          </h1>
          <div className="mt-8 flex flex-wrap items-start justify-between gap-4 pr-5">
            <DownloadButton from="hero" className="inline-flex h-10 items-center gap-2 rounded-[6px] bg-white px-4 text-[14px] leading-5 font-medium text-[#0B0B0F] shadow-[inset_0_-1px_0_#4D4C4C,0_1px_2px_#00000040,0_10px_28px_-10px_#00000099] transition-opacity hover:opacity-90 [&>svg]:-mt-0.5 light:bg-[#0A0A0A] light:text-white light:shadow-[inset_0_-1px_0_#000,0_1px_2px_#00000040]" />
            <p className="text-[14px] leading-5 tracking-[-0.01em] text-white/30 light:text-black/40">Free and open source</p>
          </div>
        </div>

        <div className="relative mt-20 lg:rounded-[12px] lg:shadow-[0_2px_50px_12px_#0000004D] light:lg:shadow-[0_20px_60px_-20px_#00000040]">
          {/* The live window wants a desktop's width; a phone gets a still of
              it instead of a sideways-scrolling miniature. */}
          <div className={`relative max-sm:hidden ${h.liveCursor}`}>
            <AppWindow />
          </div>
          {/* One per scheme, since the toggle can disagree with the system a
              <picture> media query would follow. Lazy, so the hidden one costs
              nothing. */}
          <img
            src="/hero-mobile.webp"
            alt="The Dray window: sessions in the sidebar, an agent's report in the chat, and its pull request's checks in the side panel."
            width={1200}
            height={786}
            loading="lazy"
            className="h-auto w-full rounded-[6px] sm:hidden light:hidden"
          />
          <img
            src="/hero-mobile-light.webp"
            alt="The Dray window: sessions in the sidebar, an agent's report in the chat, and its pull request's checks in the side panel."
            width={1440}
            height={920}
            loading="lazy"
            className="hidden h-auto w-full rounded-[6px] shadow-[0_0_0_1px_#00000014] light:block light:sm:hidden"
          />
        </div>

        <Sponsor className="mt-10 max-sm:hidden" />
      </div>
    </header>
    {/* A phone's hero is shorter than the blue field, so the credit would land
        on the blue; it sits under the hero instead, on the next band's fill. */}
    <div className="bg-black px-5 pt-10 sm:hidden light:bg-[#F4F4F2]">
      <Sponsor />
    </div>
    </>
  );
}

/// The grant, credited under the window. Hovering or focusing it turns the
/// avatar into Vercel's mark, since that is where most readers know him from.
function Sponsor({ className = "" }: { className?: string }) {
  return (
    <div className={`group flex flex-col items-center gap-3 ${className}`}>
      <p className="text-[11px] leading-4 font-medium tracking-[0.14em] text-[#A1A1A1] uppercase">Sponsored by</p>
      <div className="flex items-center gap-2.5 text-[14px] leading-5">
        <span className="relative size-7 shrink-0">
          <img
            src="/avatars/rauchg.jpg"
            alt=""
            width={28}
            height={28}
            className="size-7 rounded-full object-cover transition-opacity duration-200 group-focus-within:opacity-0 group-hover:opacity-0 motion-reduce:transition-none"
          />
          <span
            aria-hidden
            className="absolute inset-0 grid place-items-center rounded-full bg-white/10 light:bg-black opacity-0 transition-opacity duration-200 group-focus-within:opacity-100 group-hover:opacity-100 motion-reduce:transition-none"
          >
            <svg viewBox="0 0 76 65" className="-mt-px h-[11px] w-auto">
              <path d="M37.5274 0L75.0548 65H0L37.5274 0Z" fill="#fff" />
            </svg>
          </span>
        </span>
        <SponsorLink
          href="https://x.com/rauchg"
          sponsor="guillermo_rauch"
          destination="profile"
          className="text-white transition-opacity hover:opacity-70 light:text-[#0A0A0A]"
        >
          Guillermo Rauch
        </SponsorLink>
        <span aria-hidden className="text-[#A1A1A1]">
          ·
        </span>
        <SponsorLink
          href="https://rauchg-oss-grants.vercel.app/"
          sponsor="guillermo_rauch"
          destination="oss_grants"
          className="text-[#A1A1A1] transition-colors hover:text-white light:text-[#6B6B6B] light:hover:text-[#0A0A0A]"
        >
          OSS Grants
        </SponsorLink>
      </div>
    </div>
  );
}
