import Link from "next/link";
import { DownloadButton } from "@/components/DownloadButton";
import { GitHubGlyph } from "@/components/GitHubGlyph";
import { Wordmark } from "@/components/Wordmark";
import { fetchStars, formatStars } from "@/lib/github";
import { REPO, SPONSOR } from "@/lib/links";
import { SchemeToggle } from "./SchemeToggle";

const NAV_CELL =
  "h-full shrink-0 items-center justify-center gap-1.5 border-l border-white/20 font-mono text-[11px] leading-[14px] tracking-[0.06em] text-white uppercase transition-colors hover:bg-white/10 light:border-black/15 light:text-[#0A0A0A] light:hover:bg-black/5";

/// The site's bar of cells: wordmark left, scheme, links, stars and Download
/// right. A server component so the star count arrives in the HTML.
export async function SiteNav() {
  const stars = await fetchStars();

  return (
    <nav aria-label="Main" className="flex h-10 items-start justify-between">
      <Link href="/" aria-label="Dray home" className="flex h-10 w-[120px] items-center bg-black pl-4 light:bg-white">
        <Wordmark className="h-[11px] w-auto text-white light:text-[#0A0A0A]" />
      </Link>
      {/* The box draws its right and bottom edges; every cell draws its own
          left, so hiding Docs and Sponsor on a phone, and the stars on the
          narrowest, leaves no doubled line. */}
      <div className="flex h-10 border-r border-b border-white/20 light:border-black/15">
        <SchemeToggle className={`${NAV_CELL} flex w-10 cursor-pointer`} />
        {/* A plain anchor: /docs is another deployment behind a rewrite, so
            client-side routing has nothing to route to. */}
        <a href="/docs" className={`${NAV_CELL} hidden w-[72px] sm:flex`}>
          Docs
        </a>
        <a href={SPONSOR} target="_blank" rel="noopener noreferrer" className={`${NAV_CELL} hidden w-24 sm:flex`}>
          Sponsor
        </a>
        <a
          href={REPO}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`Dray on GitHub, ${formatStars(stars)} stars`}
          className={`${NAV_CELL} flex w-20 max-[359px]:hidden`}
        >
          <GitHubGlyph className="size-3" />
          {formatStars(stars)}
        </a>
        <DownloadButton
          from="nav"
          label="Download"
          className={`${NAV_CELL} flex w-[115px] [&>svg]:-mt-0.5 [&>svg]:size-[11px]`}
        />
      </div>
    </nav>
  );
}
