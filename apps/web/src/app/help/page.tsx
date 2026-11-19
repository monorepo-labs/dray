import type { Metadata } from "next";
import type { ReactNode } from "react";

import { Closing } from "@/components/home/Closing";
import { CARD, CARD_BODY, CARD_TITLE, LABEL } from "@/components/home/Section";
import { SiteNav } from "@/components/home/SiteNav";
import { FEEDBACK, REPO } from "@/lib/links";

export const metadata: Metadata = {
  title: "Help - Dray",
  description: "Get help with Dray on Mac, Linux, iPhone and iPad: the docs, GitHub issues, and how to reach the person who builds it.",
};

const LINK =
  "underline decoration-current/30 underline-offset-4 transition-colors hover:decoration-current text-white light:text-[#0A0A0A]";
const BUTTON =
  "inline-flex h-10 items-center rounded-[6px] border border-white/30 px-4 text-[14px] leading-5 font-medium text-white transition-colors hover:bg-white/10 light:border-black/15 light:text-[#0A0A0A] light:hover:bg-black/5";

/// The App Store's Support URL: every way to get help, in one place. Sponsoring
/// keeps /support, which the nav's Support cell has always meant.
export default function HelpPage() {
  return (
    <div
      data-home
      className="min-h-screen overflow-x-clip bg-black font-inter text-white antialiased light:bg-white light:text-[#0A0A0A]"
    >
      <main className="px-5 pb-[120px] sm:px-8">
        <div className="mx-auto w-full max-w-[960px]">
          <SiteNav bare />
          <div className="lg:ml-[102px] lg:max-w-[756px]">
            <h1 className="pt-16 font-inter text-[28px] leading-[32px] font-normal tracking-[-0.03em] text-balance sm:pt-[101px] sm:text-[36px] sm:leading-[40px]">
              Get help with Dray.
            </h1>
            <p className="mt-4 text-[16px] leading-6 tracking-[-0.01em] text-[#7C7C7C] light:text-[#8A8A8A]">
              For the Mac and Linux apps, the server, and the app for iPhone and iPad.
            </p>
          </div>

          <div className="mt-12 grid gap-[2px] sm:grid-cols-2">
            <Card
              label="Docs"
              title="Look it up."
              body="How to install Dray, run your agents, connect your other machines, and fix common problems."
            >
              <a href="/docs" className={BUTTON}>
                Read the docs
              </a>
              <a href="/docs/reference/troubleshooting" className={BUTTON}>
                Troubleshooting
              </a>
            </Card>
            <Card
              label="GitHub issues"
              title="Report a bug or ask a question."
              body="Open an issue and we'll answer there. Say which app and version you use, and what you saw. Issues are public, so leave out tokens and private code."
            >
              <a href={`${REPO}/issues/new`} target="_blank" rel="noopener noreferrer" className={BUTTON}>
                Open an issue
              </a>
              <a href={`${REPO}/issues`} target="_blank" rel="noopener noreferrer" className={BUTTON}>
                See open issues
              </a>
            </Card>
            <Card
              label="Message"
              title="Write to Yogesh."
              body="Yogesh builds Dray. Send a message on X for anything you'd rather not post in public, such as deleting your account."
            >
              <a href={FEEDBACK} target="_blank" rel="noopener noreferrer" className={BUTTON}>
                @yogesharc on X
              </a>
            </Card>
            <Card
              label="Your account"
              title="Account and privacy."
              body={
                <>
                  Change your name and username in your{" "}
                  <a href="/app/account" className={LINK}>
                    account settings
                  </a>
                  . Read what Dray collects in the{" "}
                  <a href="/docs/reference/privacy" className={LINK}>
                    privacy policy
                  </a>
                  , and the rules in the{" "}
                  <a href="/docs/reference/terms" className={LINK}>
                    terms
                  </a>
                  .
                </>
              }
            />
          </div>

          <section className="mt-16 lg:ml-[102px] lg:max-w-[756px]">
            <h2 className={`${LABEL} mb-4`}>Connect the iPhone and iPad app</h2>
            <p className={CARD_BODY}>
              The app works with Dray on your Mac, or a Dray server on Linux. It needs no account.
            </p>
            <ol className={`mt-4 list-decimal space-y-2 pl-5 ${CARD_BODY}`}>
              <li>On your Mac, open Dray, then Settings → Servers.</li>
              <li>
                On the This Mac row, turn on{" "}
                <a href="/docs/reference/remote-access#remote-access" className={LINK}>
                  Remote access
                </a>
                .
              </li>
              <li>Press the QR code button on that row.</li>
              <li>Scan the code with your iPhone&apos;s Camera, or from Add server in the Dray app.</li>
            </ol>
          </section>
        </div>
      </main>
      <Closing />
    </div>
  );
}

/// One way to get help: a label, a line, what it covers, and where to go.
function Card({ label, title, body, children }: { label: string; title: string; body: ReactNode; children?: ReactNode }) {
  return (
    <section className={`flex min-h-[220px] flex-col justify-between gap-8 p-6 ${CARD}`}>
      <div className="flex flex-col gap-1.5">
        <p className={`${LABEL} text-[#7C7C7C] light:text-[#8A8A8A]`}>{label}</p>
        <h2 className={CARD_TITLE}>{title}</h2>
        <p className={`mt-1 ${CARD_BODY}`}>{body}</p>
      </div>
      {children && <div className="flex flex-wrap gap-3">{children}</div>}
    </section>
  );
}
