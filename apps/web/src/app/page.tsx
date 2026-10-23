import { Cta } from "@/components/Cta";
import { InstallLine } from "@/components/InstallLine";
import { DownloadButton } from "@/components/DownloadButton";
import { Nav } from "@/components/Nav";
import { Sponsors } from "@/components/Sponsors";
import { Hero } from "@/components/illustrations/Hero";
import { RemoteServersStill } from "@/components/illustrations/RemoteServers";
import { AgentRoll } from "@/components/product/AgentRoll";
import { DARK_BUTTON, LIGHT_BUTTON, SMALL_LIGHT_BUTTON } from "@/components/product/buttons";
import { Cards } from "@/components/product/Cards";
import { CrewArt, CrewSteps } from "@/components/product/CrewArt";
import { IslandHero } from "@/components/product/IslandHero";
import { IslandMoments } from "@/components/product/IslandMoments";
import { Quotes } from "@/components/product/Quotes";
import { SiteFooter } from "@/components/product/SiteFooter";
import { StickyNav } from "@/components/product/StickyNav";
import { GRAPHITE_BG, HERO_BG, RIM_LIGHT } from "@/components/product/Stage";
import { FEATURES } from "@/lib/features";

/// One column for everything, text and pictures alike. 64rem: wide enough for
/// a window to read, narrow enough that the page is not all window.
const SHELL = "mx-auto w-full max-w-5xl px-4 sm:px-6";

/// A quiet scrollbar: the standard properties for Chromium and Firefox, the
/// WebKit pseudo-elements for Safari, which reads only those.
const THIN_SCROLLBAR =
  "[scrollbar-width:thin] [scrollbar-color:rgb(255_255_255/.2)_transparent] [&::-webkit-scrollbar]:h-1 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-white/20 [&::-webkit-scrollbar-track]:bg-transparent";

export default function Home() {
  return (
    <div className="min-h-screen overflow-x-clip bg-[oklch(0.115_0_0)]">
      <StickyNav after="hero">
        {/* On a phone the links don't fit beside the button; the button wins. */}
        <div className={`${SHELL} max-sm:[&_nav>div>a:not(:last-child)]:hidden`}>
          <Nav sponsor action={<DownloadButton className={SMALL_LIGHT_BUTTON} label="Download" />} />
        </div>
      </StickyNav>
      {/* Outside the hero's gradient so it can sit outside <main>: the
          gradient opens on the page's own colour, so no seam shows. */}
      <header className={`relative ${SHELL} pt-4`}>
        <Nav sponsor />
      </header>

      <main>
      <div id="hero" className="relative" style={HERO_BG}>
      <section className={`relative ${SHELL} pt-8 pb-12 sm:pt-8 sm:pb-16`}>
        <div className="relative z-10 flex flex-col items-start text-left">
          <h1 className="max-w-3xl font-display text-[2.25rem] leading-[1.05] font-medium tracking-[-0.03em] text-balance sm:text-[2.75rem]">
            Every coding agent <AgentRoll /><br /> in one window.
          </h1>
          <p className="mt-3 max-w-xl text-base leading-snug text-muted-foreground text-pretty sm:text-lg lg:max-w-none lg:whitespace-nowrap">
            One Mac app for all of them, on the subscriptions you already pay for.
          </p>
          <div className="mt-6 flex flex-wrap items-center gap-x-4 gap-y-3">
            <DownloadButton className={LIGHT_BUTTON} />
            <p className="text-[13px] text-muted-foreground">
              Free and open source ·{" "}
              <a href="#remote-servers" className="text-foreground underline underline-offset-4">
                Also runs on a Linux server
              </a>
            </p>
          </div>
        </div>

        <div className="relative mt-8">
          <div className="relative">
            {/* On a phone the window scrolls sideways; it opens on the sidebar,
                under a thin scrollbar rather than the platform's grey one. No
                shadow there, so none of the room kept for it below either. */}
            <Hero startX={0} className={`${THIN_SCROLLBAR} max-sm:mb-0! max-sm:pb-0! max-sm:[&_.app-frame]:shadow-none`} />
            <div aria-hidden className="pointer-events-none absolute top-0 right-[22%] left-[6%] z-10 h-[1.5px] rounded-full" style={RIM_LIGHT} />
          </div>
        </div>

        <Sponsors row className="mt-16 sm:mt-20" />
      </section>
      </div>

      {/* Full width, so the graphite band runs edge to edge. */}
      <div className="py-20 sm:py-28" style={GRAPHITE_BG}>
        {/* A row of two: the words and the steps on one side, the picture
            telling those steps on the other, with no frame around it. */}
        <section id="orchestration" className={`${SHELL} grid items-center gap-10 lg:grid-cols-[5fr_6fr] lg:gap-16`}>
          <div>
            <Heading
              eyebrow="Orchestration"
              title="Run a swarm of agents in parallel."
              line="Ask one agent to split the work. It starts a session per task, each in its own worktree."
            />
            <CrewSteps className="mt-8 text-base" />
          </div>
          <CrewArt className="mx-auto max-w-[480px]" />
        </section>
      </div>

      <section id="island" className="mt-28 sm:mt-36">
        <div className={SHELL}>
          <Heading
            eyebrow="Dray Island"
            title="Never leave the app you're in."
            line="Island lives in the notch, over every app. Talk, draw over what you mean, and send it to a session."
          />
          <IslandHero className="mt-10 sm:mt-12" />
        </div>
        <IslandMoments className="mt-14 sm:mt-16" />
      </section>

      {/* Full width, on the same graphite band as the crew. */}
      <div className="mt-28 py-20 sm:mt-36 sm:py-28" style={GRAPHITE_BG}>
        {/* A row of two, like the crew: the words and the install on one side,
            the machines on the other with no frame around them. The server is
            a later step, so its install lives here, not in the hero. */}
        <section id="remote-servers" className={`${SHELL} grid items-center gap-10 lg:grid-cols-[5fr_7fr] lg:gap-12`}>
          <div className="min-w-0">
            <Heading
              eyebrow="Remote servers"
              title="It keeps going while your laptop sleeps."
              line="Run Dray on a Mac mini or a VPS. Your sessions keep working there, and you pick them up from your laptop."
            />
            <InstallLine className="mt-8 w-full bg-black/30 text-[13px]" />
            <p className="mt-3 text-sm leading-relaxed text-muted-foreground text-pretty">
              Or skip the command and paste your SSH line into Settings → Servers.{" "}
              <a href="/docs/server" className="text-foreground underline underline-offset-4">
                How it works
              </a>
            </p>
          </div>
          {/* The scene draws its machines in the middle half of its box, so the
              box runs wider than its column for them to read at size. */}
          <div className="min-w-0">
            <RemoteServersStill className="-mx-[10%] w-[120%] lg:-mx-[22%] lg:w-[144%]" />
          </div>
        </section>
      </div>

      <div className={SHELL}>
        <Section id="more" eyebrow="And around the work" title="Everything else, in the same window.">
          <Cards features={FEATURES.filter((f) => f.card && !f.hidden)} />
        </Section>
      </div>

      <section className="mt-28 sm:mt-36">
        <div className={SHELL}>
          <Heading eyebrow="What people say" title="Loved by people who run agents all day." />
        </div>
        <Quotes className="mt-10" />
      </section>

      {/* The hero's gradient again, so the page ends where it began. */}
      <div className="mt-16" style={HERO_BG}>
        <div className={SHELL}>
          <Cta light={LIGHT_BUTTON} dark={DARK_BUTTON} className="max-sm:[&>div]:w-full max-sm:[&>div]:max-w-xs max-sm:[&>div]:items-stretch max-sm:[&>div>a]:justify-center [&>p]:max-w-2xl [&>p]:text-xl sm:[&>p]:text-[1.75rem] [&>svg]:size-9" />
        </div>
      </div>
      </main>
      <div className={SHELL}>
        <SiteFooter />
      </div>
    </div>
  );
}

/// A feature: the term small, the headline, one line, then the picture.
function Section({
  id,
  eyebrow,
  title,
  line,
  children,
}: {
  id: string;
  eyebrow: string;
  title: string;
  line?: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="mt-28 sm:mt-36">
      <Heading eyebrow={eyebrow} title={title} line={line} />
      <div className="mt-10 sm:mt-12">{children}</div>
    </section>
  );
}

function Heading({ eyebrow, title, line }: { eyebrow: string; title: string; line?: string }) {
  return (
    <>
      <p className="mb-3 text-sm font-medium text-muted-foreground">{eyebrow}</p>
      <h2 className="max-w-2xl font-display text-3xl leading-[1.08] font-medium tracking-[-0.025em] text-balance sm:text-[2.5rem]">
        {title}
      </h2>
      {line && <p className="mt-3 max-w-xl text-base text-muted-foreground text-pretty sm:text-lg">{line}</p>}
    </>
  );
}
