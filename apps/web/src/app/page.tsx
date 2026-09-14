import Image from "next/image";
import { ClaudeGlyph } from "@/components/ClaudeGlyph";
import { DownloadButton } from "@/components/DownloadButton";
import { Features } from "@/components/Features";
import { Footer } from "@/components/Footer";
import { Nav } from "@/components/Nav";
import { OpenAIGlyph } from "@/components/OpenAIGlyph";
import { PiGlyph } from "@/components/PiGlyph";
import { Sponsors } from "@/components/Sponsors";
import { UsedBy } from "@/components/UsedBy";
import { DOWNLOAD_SIZE } from "@/lib/links";
import hero from "../../public/hero-pr-dray.png";

/// Two widths, nested. The shell caps at 6xl and only the hero screenshot
/// uses all of it — a capture of a whole window wants every pixel it can
/// get. Everything that is text sits in the 3xl column inside it, so a
/// sentence never runs half a screen from the capture beside it.
const SHELL = "mx-auto w-full max-w-6xl px-3";
const COLUMN = "mx-auto w-full max-w-3xl";

export default function Home() {
  return (
    <main className={SHELL}>
      {/* Left-aligned and deliberately shallow: the captures below are what
          the page is actually for, and every line here is a line of them
          pushed off the first screen. The pitch is one sentence because a
          second one said nothing the captures do not show. The nav above it
          holds the wordmark and the repo link — the one thing worth reaching
          from anywhere on the page. Top inset is flat `pt-3`, matching the
          shell's own horizontal padding. */}
      <section className={`${COLUMN} pt-3 pb-6 sm:pb-8`}>
        <div className="mb-6 sm:mb-8">
          <Nav />
        </div>

        {/* The headline carries the pitch and the line under it carries the
            list, which is the way round they were not. Naming the three
            harnesses up here said what the app *runs*; running them at once
            is what it is for, and that was sitting in small grey text
            underneath.

            Aeonik at medium — the file is that one weight, so `font-medium`
            is the only weight that renders as itself. */}
        <h1 className="max-w-2xl font-display text-3xl leading-[1.1] font-medium tracking-tight text-balance sm:text-4xl">
          Run coding agents in parallel.
        </h1>

        {/* The marks come with the names, so the subtitle keeps the inline
            glyphs the headline had: they are what says "the thing you already
            pay for", which no amount of prose does as fast.

            Each mark-and-name pair holds together and nothing else does —
            nowrap on the whole line clipped on phones, and a logo that wrapped
            away from the word it stands for would read as decoration. Sized in
            `em` rather than a fixed step so they follow the text through its
            own breakpoint; the baseline nudge is eyeballed. */}
        <p className="mt-3 max-w-xl text-base text-muted-foreground text-pretty sm:text-lg">
          <span className="whitespace-nowrap">
            <ClaudeGlyph className="mr-1.5 inline-block size-[0.9em] align-[-0.12em]" />
            Claude Code
          </span>
          ,{" "}
          <span className="whitespace-nowrap">
            <OpenAIGlyph className="mr-1.5 inline-block size-[0.9em] align-[-0.12em]" />
            Codex
          </span>{" "}
          and{" "}
          <span className="whitespace-nowrap">
            <PiGlyph className="mr-1.5 inline-block size-[0.9em] align-[-0.12em]" />
            pi
          </span>{" "}
          — on your existing subscriptions. Fast, and it feels right.
        </p>

        <div className="mt-5 flex items-center gap-3">
          <DownloadButton />
          <span className="text-sm text-muted-foreground">{DOWNLOAD_SIZE}</span>
        </div>

        {/* One footnote to the button: the licence. Naming a CLI as a
            prerequisite used to sit here and moved into the app, which says
            which agent is missing and how to install it at the moment the
            reader picks one. "open source" carries no link — the nav's repo
            copy is the one route to GitHub, and a second one a line below it
            said the same thing twice. */}
        <p className="mt-4 text-xs text-muted-foreground sm:text-sm">
          Free and open source, Apache 2.0
        </p>
      </section>

      {/* The first thing after the pitch is the app itself, whole: a session
          beside its PR. A still, not a clip, so it is on screen from the
          first paint — `priority` for that — and it wears the feature tiles'
          radius and border so it reads as the first of them, not a banner. The
          capture keeps the desktop behind the window: the glass edge and the
          shadow are part of what the app looks like, and a tight crop of the
          window loses both. */}
      <Image
        src={hero}
        priority
        alt="Dray showing a session transcript beside its pull request's checks and comments"
        sizes="(max-width: 1152px) calc(100vw - 24px), 1128px"
        className="mb-12 block h-auto w-full rounded-lg border border-border sm:mb-16"
      />

      {/* Straight after the capture, in the slot a logo strip always takes —
          which here holds the two names actually backing the thing. */}
      <Sponsors className={`${COLUMN} mb-12 sm:mb-16`} />

      {/* What the app does, each beside the clip that shows it. A visitor
          who scrolls past four sections has read four features; one who
          scrolled past seven silent clips had read none.

          The quotes live inside here now, one under each feature's clip,
          rather than as a block of their own further down. */}
      <Features className={COLUMN} />

      {/* Last, and the only thing on the page that answers "who else" with a
          number rather than a name — so it wants every reason to be one of
          them already read. */}
      <UsedBy className={`${COLUMN} mb-12 sm:mb-16`} />

      <Footer className={COLUMN} />
    </main>
  );
}
