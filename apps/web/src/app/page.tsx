import Image from "next/image";
import { AppleGlyph } from "@/components/AppleGlyph";
// import { Board } from "@/components/Board";
import { Features } from "@/components/Features";
import { Footer } from "@/components/Footer";
import { Nav } from "@/components/Nav";
// import { Tweets } from "@/components/Tweets";
import { DOWNLOAD, DOWNLOAD_SIZE } from "@/lib/links";
import hero from "../../public/hero-pr-dray.png";

/// Two widths, nested. The shell caps at 6xl and only the hero screenshot
/// uses all of it — a capture of a whole window wants every pixel it can
/// get. Everything that is text sits in the 3xl column inside it, so a
/// sentence never runs half a screen from the capture beside it. Padding is
/// flat, not responsive: it has to match the board's own gap exactly, and a
/// value that grew with the viewport would drift out of step with one that
/// doesn't.
const SHELL = "mx-auto w-full max-w-6xl px-3";
const COLUMN = "mx-auto w-full max-w-3xl";

export default function Home() {
  return (
    <main className={SHELL}>
      {/* Left-aligned and deliberately shallow: the board below is what the
          page is actually for, and every line here is a line of it pushed
          off the first screen. The pitch is one sentence because a second
          one said nothing the captures do not show. The nav above it holds
          the wordmark and the repo link — the one thing worth reaching from
          anywhere on the page. Top inset is flat `pt-3`, matching the
          shell's own horizontal padding; the bottom one lives on the spacer
          past the board, for the same reason. */}
      <section className={`${COLUMN} pt-3 pb-6 sm:pb-8`}>
        <div className="mb-6 sm:mb-8">
          <Nav />
        </div>

        {/* Headline-sized now that the page is a home page and not a caption
            over a board. Aeonik at medium — the file is that one weight, so
            `font-medium` is the only weight that renders as itself. Wraps
            freely — nowrap at this size clipped on phones. */}
        <h1 className="max-w-2xl font-display text-3xl leading-[1.1] font-medium tracking-tight text-balance sm:text-4xl">
          Run Claude Code and Codex in one app.
        </h1>
        <p className="mt-3 text-base text-muted-foreground text-pretty sm:text-lg">
          Fast, feels right, runs agents in parallel — on your existing
          subscriptions.
        </p>

        <div className="mt-5 flex items-center gap-3">
          <a
            href={DOWNLOAD}
            className="inline-flex items-center gap-2 rounded-full bg-foreground px-5 py-2.5 text-sm font-medium text-background transition-opacity hover:opacity-90"
          >
            <AppleGlyph className="size-4" />
            Download for macOS
          </a>
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
          first paint — `priority` for that — and it wears the board's own
          radius and border so it reads as the first tile, not a banner. The
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

      {/* What the app does, before the board shows what it looks like. A
          visitor who scrolls past four sections has read four features; one
          who scrolled past seven silent clips had read none. */}
      <Features className={COLUMN} />

      {/* Parked with the tweets: four sections say what four clips could
          not, and a board of leftovers under them read as the page running
          on. `MEDIA` and `Board` stay for when a capture earns a slot. */}
      {/* <Board /> */}

      {/* Parked, not dropped — two cards under a full-width board read as
          a different site starting. See src/components/Tweets.tsx. */}
      {/* <Tweets className="mx-auto mt-12 max-w-4xl px-6" /> */}

      <Footer className={COLUMN} />
    </main>
  );
}
