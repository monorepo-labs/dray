import Image from "next/image";
import { AppleGlyph } from "@/components/AppleGlyph";
import { ClaudeGlyph } from "@/components/ClaudeGlyph";
import { Tweets } from "@/components/Tweets";
import { Wordmark } from "@/components/Wordmark";
import { CLAUDE_SETUP, DOWNLOAD, REPO } from "@/lib/links";
import screenshot from "../../public/screenshot.png";

export default function Home() {
  return (
    <>
      <div className="mx-auto max-w-2xl px-6">
        <nav className="flex h-14 items-center justify-between">
          <div className="flex items-center gap-3">
            <Wordmark className="h-4 w-auto" />
            <span className="rounded-md border border-border px-1.5 py-0.5 font-mono text-[10px] tracking-wider text-muted-foreground uppercase">
              Experimental
            </span>
          </div>
          <a
            href={REPO}
            className="text-sm text-muted-foreground transition-colors hover:text-foreground"
          >
            GitHub
          </a>
        </nav>
      </div>

      {/* Two centred containers rather than one: the pitch is set to a reading
          measure, and the tweets are cards, which want the width the measure
          denies them. Both are `mx-auto`, so they share a centre line and read
          as one column that widens rather than as two blocks. */}
      <main>
        <div className="mx-auto max-w-2xl px-6">
          <section className="pt-6 pb-8 sm:pt-8">
            <h1 className="font-mono text-lg leading-[1.15] font-medium tracking-tight text-balance sm:text-2xl">
              Run every coding agent from one app.
            </h1>
            <p className="mt-2 max-w-xl text-base leading-relaxed text-pretty text-muted-foreground">
              Dray drives the coding-agent CLIs you already have, on the
              subscription you already pay for. Claude Code today, with more
              harnesses coming.
            </p>

            <a
              href={DOWNLOAD}
              className="mt-6 inline-flex items-center gap-2 rounded-lg bg-foreground px-5 py-2.5 text-sm font-medium text-background transition-opacity hover:opacity-90"
            >
              <AppleGlyph className="size-4" />
              Download for macOS
            </a>

            <p className="mt-5 flex items-center gap-2 text-sm text-muted-foreground">
              <ClaudeGlyph className="size-4 shrink-0" />
              <span>
                Requires{" "}
                <a
                  href={CLAUDE_SETUP}
                  className="text-foreground underline decoration-border underline-offset-4 transition-colors hover:decoration-current"
                >
                  Claude Code
                </a>{" "}
                installed and signed in.
              </span>
            </p>

            <p className="mt-2 pl-6 text-sm text-muted-foreground">
              Free and open source under the Apache 2.0 license.
            </p>
          </section>

          {/* No window chrome around this: the capture is of a real desktop and
          carries its own titlebar, so a drawn one frames a frame. The height
          cap keeps the pitch and the download button inside the first screen:
          everything above it is ~330px, so the image yielding on short windows
          is what stops the button falling below the fold. The tweets below
          are what the page scrolls for, and they start under this. */}
          <Image
            src={screenshot}
            alt="Dray showing a session transcript beside a per-turn diff of the files that turn changed"
            priority
            sizes="(max-width: 672px) 100vw, 672px"
            className="h-auto max-h-[50vh] w-auto rounded-xl border border-border"
          />
        </div>

        <Tweets className="mx-auto mt-12 max-w-4xl px-6 pb-12" />
      </main>
    </>
  );
}
