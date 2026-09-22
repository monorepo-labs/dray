import { Cta } from "@/components/Cta";
import { ContributeButton } from "@/components/ContributeButton";
import { DownloadButton } from "@/components/DownloadButton";
import { Features } from "@/components/Features";
import { Footer } from "@/components/Footer";
import { Harnesses } from "@/components/Harnesses";
import { Nav } from "@/components/Nav";
import { Sponsors } from "@/components/Sponsors";
import { Testimonials } from "@/components/Testimonials";
import { Hero } from "@/components/illustrations/Hero";
import { ThemedHero } from "@/components/illustrations/ThemedHero";

/// Two widths, nested. The shell caps at 6xl and every drawn window uses
/// all of it — a window wants every pixel it can get. Everything that is
/// text sits in the 3xl column inside it, so a sentence never runs half a
/// screen from the window beside it.
const SHELL = "mx-auto w-full max-w-6xl px-3";
const COLUMN = "mx-auto w-full max-w-3xl";

export default function Home() {
  return (
    <main className={SHELL}>
      {/* Left-aligned and deliberately shallow: the windows below are what
          the page is actually for, and every line here is a line of them
          pushed off the first screen. The pitch is one sentence because a
          second one said nothing the windows do not show. */}
      <section className={`${COLUMN} pt-3 pb-6 sm:pb-8`}>
        <div className="mb-6 sm:mb-8">
          <Nav />
        </div>

        {/* Aeonik at medium — the file is that one weight, so `font-medium`
            is the only weight that renders as itself. Not "run coding agents
            in parallel" — true, and one feature of several. What the page
            below actually shows is every agent CLI in one window, and that
            is the claim. */}
        <h1 className="font-display text-3xl leading-[1.1] font-medium tracking-tight text-balance sm:text-4xl">
          Every coding agent, one window.
        </h1>

        {/* The sentence that does the explaining. Which agents is the strip
            under the button, not a list in here — it grows, and a sentence
            can only hold so many names. */}
        <p className="mt-3 text-lg leading-normal text-muted-foreground text-pretty sm:text-xl">
          Free and open source. Runs on the subscriptions you already have.
        </p>

        <div className="mt-5 flex flex-wrap items-center gap-3">
          <DownloadButton />
          <ContributeButton />
        </div>

        {/* Above the fold, since "does it run mine" is the first question
            and a strip under the window answered it a screen too late. */}
        <Harnesses className="mt-8" />
      </section>

      {/* The first thing after the pitch is the app itself, whole: a session
          beside its pull request, drawn rather than captured, so it is the
          first of the windows below rather than a banner over them. */}
      <ThemedHero className="mb-12 sm:mb-16">
        <Hero />
      </ThemedHero>

      {/* Straight after the window, in the slot a logo strip always takes —
          which here holds the two names actually backing the thing. */}
      <Sponsors className={`${COLUMN} mb-20 sm:mb-28`} />

      <Features />

      <Testimonials className="mb-16 sm:mb-24" />

      <Cta />

      <Footer className={COLUMN} />
    </main>
  );
}
