import { BrowserChrome } from "@/components/app/Browser";
import s from "./Cards.module.css";

/// The browser pane: the agent opens the dev server in a tab of its own,
/// the page loads, and the element picker outlines the button it was asked
/// about.
export function BrowserCard() {
  return (
    <BrowserChrome
      className={s.scene}
      tab={
        <span className="grid">
          <span className={`col-start-1 row-start-1 ${s.newTab}`}>New tab</span>
          <span className={`col-start-1 row-start-1 ${s.pageTab}`}>Dray — Every coding agent, one window</span>
        </span>
      }
      url={
        <span className="grid">
          <span className={`col-start-1 row-start-1 text-muted-foreground ${s.blank}`}>Search or enter a URL</span>
          <span className={`col-start-1 row-start-1 ${s.url}`}>localhost:3000</span>
        </span>
      }
    >
      {/* The page as a page draws itself: white-on-dark is the site's own. */}
      <div className={`absolute inset-0 flex flex-col gap-3 px-8 pt-6 ${s.skeleton}`} aria-hidden>
        <span className="h-3 w-20 rounded bg-muted-foreground/15" />
        <span className="mt-6 h-6 w-3/5 rounded bg-muted-foreground/15" />
        <span className="h-3 w-4/5 rounded bg-muted-foreground/10" />
        <span className="h-3 w-2/5 rounded bg-muted-foreground/10" />
      </div>
      <div className={`absolute inset-0 flex flex-col px-8 pt-5 ${s.page}`}>
        <div className="flex items-center gap-5 text-ui text-muted-foreground">
          <span className="font-display text-base font-medium text-foreground">Dray</span>
          <span>Features</span>
          <span>Changelog</span>
          <span>GitHub</span>
        </div>
        <h1 className="mt-7 font-display text-[1.6rem] leading-[1.1] font-medium tracking-tight text-foreground">
          Every coding agent, one window.
        </h1>
        <p className="mt-2 max-w-sm text-ui text-muted-foreground">
          Claude Code, Codex, pi and fx — on your existing subscriptions.
        </p>
        <div className="relative mt-4 self-start">
          <span className="inline-flex h-8 items-center rounded-full bg-primary px-4 text-ui font-medium text-primary-foreground">
            Download for Mac
          </span>
          {/* The picker's outline and its label, as the pane draws them over
              the element under the cursor. The label sits beside the button
              rather than above it, where it would cover the line before. */}
          <span className={`pointer-events-none absolute -inset-1 rounded-full border border-accent-mention bg-accent-mention/15 ${s.pick}`}>
            <span className="absolute top-1/2 left-full ml-2 -translate-y-1/2 rounded-sm bg-accent-mention px-1.5 py-0.5 font-mono text-[11px] leading-tight whitespace-nowrap text-background">
              a.download · 148×32
            </span>
          </span>
        </div>
      </div>
    </BrowserChrome>
  );
}
