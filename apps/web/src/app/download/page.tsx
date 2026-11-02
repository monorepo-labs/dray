import type { Metadata } from "next";
import type { ReactNode } from "react";

import { GitHubGlyph } from "@/components/GitHubGlyph";
import { Closing } from "@/components/home/Closing";
import { SiteNav } from "@/components/home/SiteNav";
import { Support } from "@/components/home/Support";
import { XGlyph } from "@/components/XGlyph";
import { fetchStars, formatStars } from "@/lib/github";
import { DOWNLOAD, FEEDBACK, REPO } from "@/lib/links";

import { StartDownload, SupportLink } from "./client";

export const metadata: Metadata = {
  title: "Download - Dray",
  description: "Download Dray for macOS.",
};

const LABEL = "font-mono text-[11px] leading-[14px] tracking-[0.06em] uppercase text-[#7C7C7C] light:text-[#8A8A8A]";
const RULE = "border-white/20 light:border-black/15";
const STRONG = "font-medium text-white light:text-[#0A0A0A]";

const STEPS: ReactNode[] = [
  <>
    Open <b className={STRONG}>Dray_universal.dmg</b> from your Downloads folder.
  </>,
  <>
    Drag <b className={STRONG}>Dray</b> into <b className={STRONG}>Applications</b>.
  </>,
  <>Open Dray from Applications. Updates arrive inside the app from then on.</>,
];

/// Where every Download button lands: the dmg starts on its own, and the wait
/// is spent on the one ask the site makes, then install steps.
export default async function Download() {
  const stars = await fetchStars();

  return (
    <div
      data-home
      className="min-h-screen overflow-x-clip bg-black font-inter text-white antialiased light:bg-white light:text-[#0A0A0A]"
    >
      <StartDownload />
      <main className="px-5 pb-[120px] sm:px-8">
        <div className="mx-auto w-full max-w-[960px]">
          <SiteNav />

          <div className="text-[15px] leading-6 tracking-[-0.01em] text-[#A1A1A1] light:text-[#5C5C5C]">
            <div className="lg:ml-[102px] lg:max-w-[756px]">
              <h1 className="pt-16 font-inter text-[36px] leading-[40px] font-normal tracking-[-0.03em] text-balance text-white sm:pt-[101px] sm:text-[46px] sm:leading-[46px] light:text-[#0A0A0A]">
                Thanks for downloading Dray.
              </h1>
              <p className="mt-4 text-[16px] text-[#7C7C7C] light:text-[#8A8A8A]">
                The download starts on its own. If it didn't,{" "}
                <SupportLink
                  href={DOWNLOAD}
                  to="dmg"
                  className="text-white underline decoration-white/30 underline-offset-4 transition-colors hover:decoration-white light:text-[#0A0A0A] light:decoration-black/30 light:hover:decoration-black"
                >
                  download it again
                </SupportLink>
                .
              </p>
            </div>

            <div className="mt-12">
              <Support from="download" />
            </div>

            <section className="mt-16">
              <h2 className={LABEL}>Install</h2>
              <ol className={`mt-4 border-t ${RULE}`}>
                {STEPS.map((step, i) => (
                  <li key={i} className={`flex gap-6 border-b py-5 ${RULE}`}>
                    <span className={`${LABEL} pt-[5px]`}>{String(i + 1).padStart(2, "0")}</span>
                    <p>{step}</p>
                  </li>
                ))}
              </ol>
            </section>


            <section className="mt-16">
              <h2 className={LABEL}>Other ways to help</h2>
              <div className={`mt-4 grid border sm:grid-cols-2 ${RULE} divide-y divide-white/20 sm:divide-x sm:divide-y-0 light:divide-black/15`}>
                <Way href={REPO} to="github" icon={<GitHubGlyph className="size-4" />} title="Star it on GitHub">
                  {formatStars(stars)} stars so far. Each one helps someone else find Dray.
                </Way>
                <Way href={FEEDBACK} to="x" icon={<XGlyph className="size-3.5" />} title="Follow on X">
                  New releases and what comes next, as they happen.
                </Way>
              </div>
            </section>
          </div>
        </div>
      </main>
      <Closing />
    </div>
  );
}

/// One of the free ways to help: a whole cell that links out.
function Way({
  href,
  to,
  icon,
  title,
  children,
}: {
  href: string;
  to: "github" | "x";
  icon: ReactNode;
  title: string;
  children: ReactNode;
}) {
  return (
    <SupportLink
      href={href}
      to={to}
      className="flex flex-col gap-2 p-6 transition-colors hover:bg-white/[0.04] light:hover:bg-black/[0.03]"
    >
      <span className="flex items-center gap-2 text-white light:text-[#0A0A0A]">
        {icon}
        {title}
      </span>
      <span>{children}</span>
    </SupportLink>
  );
}
