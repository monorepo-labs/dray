import { GitHubGlyph } from "@/components/GitHubGlyph";
import { Wordmark } from "@/components/Wordmark";
import { XGlyph } from "@/components/XGlyph";
import { COMPANY, DOWNLOAD, FEEDBACK, REPO, SPONSOR } from "@/lib/links";

/// Every link here goes somewhere real: a route on this site, the docs, or
/// the same addresses the nav and the CTA already use.
const COLUMNS: { title: string; links: { label: string; href: string; out?: boolean }[] }[] = [
  {
    title: "Product",
    links: [
      { label: "Download for macOS", href: DOWNLOAD, out: true },
      { label: "Run it on Linux", href: "/docs/server" },
      { label: "What's new", href: "/changelog" },
    ],
  },
  {
    title: "Learn",
    links: [
      { label: "Docs", href: "/docs" },
      { label: "Install", href: "/docs/get-started/install" },
    ],
  },
  {
    title: "Community",
    links: [
      { label: "GitHub", href: REPO, out: true },
      { label: "Follow on X", href: FEEDBACK, out: true },
      { label: "Sponsor", href: SPONSOR, out: true },
    ],
  },
];

export function SiteFooter({ className = "" }: { className?: string }) {
  return (
    <footer className={`border-t border-white/[0.08] pt-12 pb-10 ${className}`}>
      <div className="grid grid-cols-3 gap-x-6 gap-y-10 sm:grid-cols-[1.4fr_repeat(3,1fr)]">
        <div className="col-span-3 sm:col-span-1">
          <a href="/" aria-label="Dray home">
            <Wordmark className="h-3.5 w-auto" />
          </a>
          <p className="mt-4 max-w-56 text-sm text-muted-foreground">
            Every coding agent, one window. Free and open source under Apache 2.0.
          </p>
          <div className="mt-5 flex gap-3 text-muted-foreground">
            <a href={REPO} target="_blank" rel="noopener noreferrer" aria-label="Dray on GitHub" className="hover:text-foreground">
              <GitHubGlyph className="size-4" />
            </a>
            <a href={FEEDBACK} target="_blank" rel="noopener noreferrer" aria-label="Yogesh on X" className="hover:text-foreground">
              <XGlyph className="size-3.5" />
            </a>
          </div>
        </div>
        {COLUMNS.map((c) => (
          <nav key={c.title} aria-label={c.title}>
            <h3 className="text-sm font-medium">{c.title}</h3>
            <ul className="mt-3 flex flex-col gap-2 text-sm text-muted-foreground">
              {c.links.map((l) => (
                <li key={l.label}>
                  <a
                    href={l.href}
                    {...(l.out ? { target: "_blank", rel: "noopener noreferrer" } : {})}
                    className="transition-colors hover:text-foreground"
                  >
                    {l.label}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
        ))}
      </div>
      <p className="mt-12 text-xs text-muted-foreground/70">
        © {new Date().getFullYear()} {COMPANY}
      </p>
    </footer>
  );
}
