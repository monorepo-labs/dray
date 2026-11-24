import React, { useState, type KeyboardEvent, type ReactNode } from "react";
import ReactDOM from "react-dom/client";

import { ArrowLeftIcon, ArrowRightIcon, SparklesIcon, XMarkIcon } from "@heroicons/react/16/solid";

import { changelogInline, changelogPlain } from "@/components/changelogText";
import WindowControls from "@/components/layout/WindowControls";
import { GateHeading } from "@/components/SignInGate";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { TooltipProvider } from "@/components/ui/tooltip";
import DemoThemeBar from "@/demo/ThemeBar";
import { NEXT_RELEASE, onWhite, PAGE_HIGHLIGHTS } from "@/demo/whatsNewData";
import { Stripes } from "@/components/Stripes";
import type { ChangelogMedia, Highlight } from "@/lib/changelog";
import { cn } from "@/lib/utils";
import "../App.css";

/// Full-window takes on What's New, for a release with highlights: the whole
/// window, the way an Apple release page reads, rather than a carousel in a
/// dialog. Every take reads the same highlights: the next release's own three by
/// default, or one to six samples as the page's switch or `?n=` picks. Each
/// leaves by Continue or Escape. Open raises a take
/// over the whole window, as the app would; an action is logged in its row
/// rather than run. `?takes=ACE` lists only those. F is the one picked.

type Backdrop = "black" | "blue" | "white";

const PAGE: Record<Backdrop, string> = { black: "bg-black", blue: "bg-[#1612F8]", white: "bg-white" };
type Cards = "dark" | "white";
type Layout = "gaps" | "small" | "borders";
type Exit = "card" | "bare" | "title";
type Order = "picture" | "title";
type TakeProps = {
  hl: Highlight[];
  onAction: (label: string) => void;
  onClose: () => void;
  backdrop?: Backdrop;
  cards?: Cards;
  layout?: Layout;
  exit?: Exit;
  order?: Order;
};

const title = (h: Highlight) => changelogPlain(h.item.title ?? h.item.body);

/// The whole window, through the shared dialog so Escape, focus and the
/// portal behave as every other dialog's do. Focus lands on the element
/// marked `data-autofocus`, the take's way forward, rather than on the cross,
/// and without scrolling to it: a take whose Continue sits at the end of a long
/// page must still open at its top.
function Shell({
  label,
  onClose,
  onKeyDown,
  onEscapeKeyDown,
  className,
  children,
}: {
  label: string;
  onClose: () => void;
  onKeyDown?: (e: KeyboardEvent<HTMLDivElement>) => void;
  onEscapeKeyDown?: (e: globalThis.KeyboardEvent) => void;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        showClose={false}
        aria-describedby={undefined}
        onOpenAutoFocus={(e) => {
          const target = (e.currentTarget as HTMLElement).querySelector<HTMLElement>("[data-autofocus]");
          if (!target) return;
          e.preventDefault();
          target.focus({ preventScroll: true });
        }}
        onKeyDown={onKeyDown}
        onEscapeKeyDown={onEscapeKeyDown}
        className={cn(
          "top-0 left-0 flex h-full w-full max-w-none translate-x-0 translate-y-0 flex-col gap-0 rounded-none border-0 bg-background p-0 text-foreground shadow-none backdrop-blur-none",
          className,
        )}
      >
        <DialogTitle className="sr-only">{label}</DialogTitle>
        {children}
      </DialogContent>
    </Dialog>
  );
}

function NewInDray({ className }: { className?: string }) {
  return (
    <span className={cn("flex items-center gap-1.5 text-ui font-medium", className)}>
      <SparklesIcon className="size-3.5 text-accent-add" aria-hidden />
      New in Dray
    </span>
  );
}

function Close({ onClose, className }: { onClose: () => void; className?: string }) {
  return (
    <Button variant="ghost" size="icon-sm" aria-label="Close" onClick={onClose} className={className}>
      <XMarkIcon className="size-4" />
    </Button>
  );
}

function TopBar({ onClose }: { onClose: () => void }) {
  return (
    <div className="flex h-12 shrink-0 items-center justify-between px-5">
      <NewInDray />
      <Close onClose={onClose} />
    </div>
  );
}

/// A highlight's picture or video; with none, a quiet tile carrying the mark,
/// so a layout built around media still has something in the slot.
function Media({ media, className }: { media: ChangelogMedia | undefined; className?: string }) {
  if (!media)
    return (
      <div className={cn("flex items-center justify-center bg-muted", className)}>
        <SparklesIcon className="size-10 text-accent-add" aria-hidden />
      </div>
    );
  return media.kind === "video" ? (
    <video
      src={media.url}
      aria-label={media.alt || undefined}
      autoPlay
      muted
      loop
      playsInline
      className={cn("bg-muted object-cover", className)}
    />
  ) : (
    <img src={media.url} alt={media.alt} className={cn("bg-muted object-cover", className)} />
  );
}

function ActionLink({ h, onAction, className }: { h: Highlight; onAction: (label: string) => void; className?: string }) {
  const action = h.item.highlight?.action;
  if (!action) return null;
  return (
    <button
      type="button"
      onClick={() => onAction(action.label)}
      className={cn(
        "inline-flex cursor-pointer items-center gap-1 font-medium text-foreground underline-offset-4 hover:underline",
        className,
      )}
    >
      {action.label}
      <ArrowRightIcon className="size-3.5" aria-hidden />
    </button>
  );
}

/// A — hero: the first highlight as a headline over a large video, the rest a
/// row beneath it, Continue pinned at the foot.
function TakeHero({ hl, onAction, onClose }: TakeProps) {
  const [hero, ...rest] = hl;
  return (
    <Shell label="What's new in Dray" onClose={onClose}>
      <TopBar onClose={onClose} />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-5xl flex-col items-center px-10 pb-16">
          <h1 className="mt-6 text-center text-5xl font-medium tracking-tight text-balance">{title(hero)}</h1>
          <p className="mt-4 max-w-2xl text-center text-lg leading-relaxed text-balance text-muted-foreground">
            {changelogInline(hero.item.body)}
          </p>
          <ActionLink h={hero} onAction={onAction} className="mt-4 text-chat" />
          <Media media={hero.item.media[0]} className="mt-10 aspect-[16/10] w-full rounded-2xl border border-border shadow-xl" />
          <div className="mt-16 grid w-full grid-cols-3 gap-8 border-t border-border pt-10">
            {rest.map((h, i) => (
              <div key={i} className="flex flex-col gap-2">
                <Media media={h.item.media[0]} className="mb-2 aspect-video w-full rounded-lg border border-border" />
                <p className="text-base font-medium">{title(h)}</p>
                <p className="text-ui leading-relaxed text-muted-foreground">{changelogInline(h.item.body)}</p>
                <ActionLink h={h} onAction={onAction} className="mt-1 self-start text-ui" />
              </div>
            ))}
          </div>
        </div>
      </div>
      <footer className="flex shrink-0 justify-center border-t border-border py-4">
        <Button data-autofocus className="h-9 min-w-32 px-6" onClick={onClose}>
          Continue
        </Button>
      </footer>
    </Shell>
  );
}

/// B — story: one large section a feature, media and text trading sides as
/// the page scrolls, Continue waiting at the end.
function TakeStory({ hl, onAction, onClose }: TakeProps) {
  return (
    <Shell label="What's new in Dray" onClose={onClose}>
      <TopBar onClose={onClose} />
      <div className="min-h-0 flex-1 snap-y snap-proximity overflow-y-auto">
        <header className="mx-auto flex max-w-6xl snap-start flex-col items-start px-12 pt-10 pb-6">
          <h1 className="text-6xl font-medium tracking-tight">
            {hl.length} new things
            <br />
            <span className="text-muted-foreground">in Dray.</span>
          </h1>
        </header>
        {hl.map((h, i) => (
          <section
            key={i}
            className="mx-auto grid min-h-[75vh] max-w-6xl snap-start grid-cols-2 items-center gap-16 border-t border-border px-12 py-16"
          >
            <Media
              media={h.item.media[0]}
              className={cn("aspect-[4/3] w-full rounded-2xl border border-border", i % 2 === 1 && "order-last")}
            />
            <div className="flex flex-col gap-4">
              <span className="font-mono text-xs text-muted-foreground tabular-nums">0{i + 1}</span>
              <h2 className="text-4xl font-medium tracking-tight">{title(h)}</h2>
              <p className="text-lg leading-relaxed text-muted-foreground">{changelogInline(h.item.body)}</p>
              <ActionLink h={h} onAction={onAction} className="mt-2 self-start text-chat" />
            </div>
          </section>
        ))}
        <footer className="flex flex-col items-center gap-4 border-t border-border py-20">
          <p className="text-muted-foreground">That's everything new.</p>
          <Button className="h-9 min-w-32 px-6" onClick={onClose}>
            Continue
          </Button>
        </footer>
      </div>
    </Shell>
  );
}

/// C — split: every feature listed on the left, the picked one large on the
/// right; ↑ ↓ walk the list.
function TakeSplit({ hl, onAction, onClose }: TakeProps) {
  const [pick, setPick] = useState(0);
  const h = hl[pick];
  return (
    <Shell
      label="What's new in Dray"
      onClose={onClose}
      onKeyDown={(e) => {
        const by = e.key === "ArrowDown" ? 1 : e.key === "ArrowUp" ? -1 : 0;
        if (!by) return;
        e.preventDefault();
        setPick((p) => Math.min(Math.max(p + by, 0), hl.length - 1));
      }}
      className="grid grid-cols-[22rem_1fr]"
    >
      <aside className="flex min-h-0 flex-col border-r border-border bg-muted/40 p-4">
        <NewInDray className="px-2 pt-1" />
        <h1 className="mt-3 px-2 text-3xl font-medium tracking-tight">What's new</h1>
        <nav className="mt-6 flex flex-col gap-1">
          {hl.map((x, i) => (
            <button
              key={i}
              type="button"
              onClick={() => setPick(i)}
              className={cn(
                "flex cursor-pointer gap-3 rounded-lg px-3 py-2.5 text-left transition-colors",
                i === pick ? "bg-background shadow-sm" : "hover:bg-background/60",
              )}
            >
              <span className="mt-0.5 font-mono text-xs text-muted-foreground tabular-nums">0{i + 1}</span>
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className={cn("text-ui font-medium", i !== pick && "text-muted-foreground")}>{title(x)}</span>
                <span className="line-clamp-2 text-xs leading-relaxed text-muted-foreground">
                  {changelogPlain(x.item.body)}
                </span>
              </span>
            </button>
          ))}
        </nav>
        <div className="mt-auto flex flex-col gap-2 px-2">
          <Button data-autofocus className="h-9 w-full" onClick={onClose}>
            Continue
          </Button>
          <span className="text-center text-xs text-muted-foreground">↑ ↓ to move · Esc to close</span>
        </div>
      </aside>
      <main className="relative flex min-h-0 flex-col items-center justify-center overflow-y-auto px-16 py-12">
        <Close onClose={onClose} className="absolute top-3 right-4" />
        <div key={pick} className="flex w-full max-w-4xl flex-col animate-in fade-in-0 [animation-duration:200ms]">
          <Media media={h.item.media[0]} className="aspect-video w-full rounded-2xl border border-border shadow-lg" />
          <h2 className="mt-8 text-3xl font-medium tracking-tight">{title(h)}</h2>
          <p className="mt-3 max-w-2xl text-lg leading-relaxed text-muted-foreground">{changelogInline(h.item.body)}</p>
          <ActionLink h={h} onAction={onAction} className="mt-4 self-start text-chat" />
        </div>
      </main>
    </Shell>
  );
}

/// D — grid: a card a feature, each opening into its own detail with a way
/// back to all of them.
function TakeGrid({ hl, onAction, onClose }: TakeProps) {
  const [open, setOpen] = useState<number | null>(null);
  const h = open === null ? null : hl[open];
  return (
    <Shell
      label="What's new in Dray"
      onClose={onClose}
      // Escape steps out of a detail before it closes the page.
      onEscapeKeyDown={(e) => {
        if (open === null) return;
        e.preventDefault();
        setOpen(null);
      }}
    >
      <TopBar onClose={onClose} />
      <div className="min-h-0 flex-1 overflow-y-auto">
        {h ? (
          <div key={open} className="mx-auto flex max-w-4xl flex-col px-10 pt-2 pb-16 animate-in fade-in-0 [animation-duration:200ms]">
            <Button variant="ghost" size="sm" className="-ml-2.5 self-start" onClick={() => setOpen(null)}>
              <ArrowLeftIcon className="size-3.5" />
              All features
            </Button>
            <Media media={h.item.media[0]} className="mt-4 aspect-video w-full rounded-2xl border border-border shadow-lg" />
            <h2 className="mt-8 text-4xl font-medium tracking-tight">{title(h)}</h2>
            <p className="mt-3 max-w-2xl text-lg leading-relaxed text-muted-foreground">{changelogInline(h.item.body)}</p>
            <ActionLink h={h} onAction={onAction} className="mt-4 self-start text-chat" />
          </div>
        ) : (
          <div className="mx-auto flex max-w-5xl flex-col px-10 pt-4 pb-16 animate-in fade-in-0 [animation-duration:200ms]">
            <h1 className="text-5xl font-medium tracking-tight">What's new</h1>
            <p className="mt-3 text-lg text-muted-foreground">{hl.length} new things. Pick one to see more.</p>
            <div className="mt-10 grid grid-cols-2 gap-5">
              {hl.map((x, i) => (
                <button
                  key={i}
                  type="button"
                  onClick={() => setOpen(i)}
                  className="group flex cursor-pointer flex-col overflow-hidden rounded-2xl border border-border bg-muted/30 text-left transition-colors hover:border-foreground/20 hover:bg-muted/60"
                >
                  <Media media={x.item.media[0]} className="aspect-video w-full" />
                  <span className="flex flex-col gap-1.5 p-5">
                    <span className="flex items-center justify-between gap-2 text-lg font-medium">
                      {title(x)}
                      <ArrowRightIcon className="size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5" aria-hidden />
                    </span>
                    <span className="line-clamp-2 text-ui leading-relaxed text-muted-foreground">{changelogPlain(x.item.body)}</span>
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
      <footer className="flex shrink-0 justify-center border-t border-border py-4">
        <Button data-autofocus className="h-9 min-w-32 px-6" onClick={onClose}>
          Continue
        </Button>
      </footer>
    </Shell>
  );
}

/// E — spotlight: one feature fills the window at a time, the picture large in
/// the middle over a blurred wash of itself, a filmstrip to jump between them.
/// Dark in both modes, as a stage is. ← → move.
function TakeSpotlight({ hl, onAction, onClose }: TakeProps) {
  const [pick, setPick] = useState(0);
  const h = hl[pick];
  const media = h.item.media[0];
  const last = pick === hl.length - 1;
  const step = (by: number) => setPick((p) => Math.min(Math.max(p + by, 0), hl.length - 1));
  return (
    <Shell
      label="What's new in Dray"
      onClose={onClose}
      onKeyDown={(e) => {
        const by = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
        if (!by) return;
        e.preventDefault();
        step(by);
      }}
      className="dark overflow-hidden bg-neutral-950 text-white"
    >
      {/* The wash: the same picture, blown up and blurred, so the stage takes
          its colour from whatever is on it. */}
      <div key={`wash${pick}`} className="absolute inset-0 animate-in fade-in-0 [animation-duration:500ms]">
        {media?.kind === "image" ? (
          <img src={media.url} alt="" className="size-full scale-125 object-cover opacity-40 blur-3xl" />
        ) : (
          <div className="size-full bg-[radial-gradient(circle_at_30%_20%,oklch(0.45_0.15_160/0.6),transparent_55%),radial-gradient(circle_at_75%_70%,oklch(0.42_0.2_265/0.6),transparent_55%)]" />
        )}
        <div className="absolute inset-0 bg-linear-to-t from-black/80 via-black/20 to-black/50" />
      </div>
      <div className="relative flex h-12 shrink-0 items-center justify-between px-5">
        <NewInDray className="text-white" />
        <Close onClose={onClose} className="text-white/80 hover:bg-white/10 hover:text-white" />
      </div>
      <div key={pick} className="relative flex min-h-0 flex-1 items-center justify-center px-16 animate-in fade-in-0 zoom-in-[0.98] [animation-duration:400ms]">
        {media ? (
          <Media media={media} className="max-h-full w-auto max-w-5xl rounded-xl shadow-2xl ring-1 ring-white/10" />
        ) : (
          <Media media={undefined} className="aspect-video h-full max-h-[28rem] rounded-xl bg-white/10 ring-1 ring-white/10" />
        )}
      </div>
      <div className="relative flex shrink-0 items-end gap-10 px-12 pt-8 pb-10">
        <div key={`t${pick}`} className="flex max-w-xl min-w-0 flex-1 flex-col gap-3 animate-in fade-in-0 slide-in-from-bottom-1 [animation-duration:400ms]">
          <span className="font-mono text-xs text-white/50 tabular-nums">
            0{pick + 1} / 0{hl.length}
          </span>
          <h2 className="text-5xl font-medium tracking-tight">{title(h)}</h2>
          <p className="text-lg leading-relaxed text-white/70">{changelogPlain(h.item.body)}</p>
          <ActionLink h={h} onAction={onAction} className="mt-1 self-start text-chat text-white" />
        </div>
        <div className="flex shrink-0 flex-col items-end gap-4">
          <div className="flex gap-2">
            {hl.map((x, i) => (
              <button
                key={i}
                type="button"
                aria-label={title(x)}
                onClick={() => setPick(i)}
                className={cn(
                  "w-24 cursor-pointer overflow-hidden rounded-md ring-2 transition-all",
                  i === pick ? "opacity-100 ring-white" : "opacity-50 ring-transparent hover:opacity-80",
                )}
              >
                <Media media={x.item.media[0]} className="pointer-events-none aspect-video w-full bg-white/10 [&_svg]:size-5" />
              </button>
            ))}
          </div>
          <div className="flex gap-2">
            {pick > 0 && (
              <button
                type="button"
                aria-label="Back"
                onClick={() => step(-1)}
                className="flex size-9 cursor-pointer items-center justify-center rounded-lg bg-white/10 transition-colors hover:bg-white/20"
              >
                <ArrowLeftIcon className="size-4" />
              </button>
            )}
            <button
              type="button"
              data-autofocus
              onClick={last ? onClose : () => step(1)}
              className="flex h-9 min-w-24 cursor-pointer items-center justify-center gap-1.5 rounded-lg bg-white px-4 text-ui font-medium text-black transition-colors hover:bg-white/90"
            >
              {last ? "Continue" : "Next"}
              {!last && <ArrowRightIcon className="size-4" aria-hidden />}
            </button>
          </div>
        </div>
      </div>
    </Shell>
  );
}

function ActionMono({ h, onAction, white }: { h: Highlight; onAction: (label: string) => void; white?: boolean }) {
  const action = h.item.highlight?.action;
  if (!action) return null;
  return (
    <button
      type="button"
      onClick={() => onAction(action.label)}
      className={cn(
        "inline-flex cursor-pointer items-center gap-1.5 self-start font-mono text-[11px] leading-[14px] tracking-[0.06em] uppercase outline-none",
        white ? "text-[#0A0A0A]/70 hover:text-[#0A0A0A] focus-visible:text-[#0A0A0A]" : "text-white/75 hover:text-white focus-visible:text-white",
      )}
    >
      {action.label}
      <svg width="12" height="12" viewBox="0 0 24 24" aria-hidden>
        <path d="M7 17 17 7M7 7h10v10" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </button>
  );
}

/// One feature, as the sign-in gate draws a way in: a square card, the
/// picture or video on top, the title under it and any action as a small
/// link. No description: the title is a sentence that says the whole thing,
/// two lines at most.
///
/// A highlight with no picture or video is text alone: the title at the top
/// of a card the grid stretches to its neighbour's height, the action at its
/// foot, rather than an empty box where a picture would be.
///
/// `wide` is the odd count's last card, across the whole row: the picture
/// keeps a column's width on the left and the title sits beside it, so the
/// row is as tall as the others and the grid has no hole.
///
/// `white` is the white card, dark title, tried on the blue backdrop; its
/// pictures are the `-white` captures, drawn on a white tile to match.
///
/// `edged` draws a hairline round the card, for white cards on a white page.
///
/// `titleFirst` puts the title above the picture (left of it on a wide card),
/// the picture held to the card's foot so a row's pictures line up.
function LandingCard({
  h,
  onAction,
  white,
  wide,
  titleFirst,
  edged,
}: {
  h: Highlight;
  onAction: (label: string) => void;
  white?: boolean;
  wide?: boolean;
  titleFirst?: boolean;
  edged?: boolean;
}) {
  const media = h.item.media[0];
  const fill = cn(white ? "bg-white" : "bg-[#1C1C1C]", edged && "shadow-[0_0_0_1px_#0000001F]");
  const heading = (
    <h2
      className={cn(
        "line-clamp-2 text-[20px] leading-7 tracking-[-0.01em] text-balance",
        white ? "text-[#0A0A0A]" : "text-white",
      )}
    >
      {title(h)}
    </h2>
  );
  if (!media)
    return (
      <article className={cn("flex flex-col justify-between gap-8 p-6", fill, wide && "col-span-2")}>
        {heading}
        <ActionMono h={h} onAction={onAction} white={white} />
      </article>
    );
  return (
    <article className={cn(fill, wide ? "col-span-2 grid grid-cols-2" : "flex flex-col")}>
      <Media
        media={media}
        className={cn("aspect-video w-full", white ? "bg-white" : "bg-[#1C1C1C]", titleFirst && "order-last mt-auto")}
      />
      <div className="flex flex-col gap-3 p-6">
        {heading}
        <ActionMono h={h} onAction={onAction} white={white} />
      </div>
    </article>
  );
}

/// The page's way on, as a card of its own in the grid: a step lighter than
/// the feature cards (#242424, the gate cards' own hover tone) with the label
/// in full white. Solid white was tried and glared on the black. `row` lays it
/// across both columns.
/// On white cards it is a step darker, #EDEDEF with dark type.
/// `bare` has no fill: white type and arrow straight on the page in the
/// card's slot, a faint tint on hover. On its own row it has no border
/// either; beside a card (an odd count) a white hairline keeps it reading as
/// that row's second card. In the Borders layout the
/// grid's own fill is the line, so a bare card there takes the page's colour
/// (`page`) instead of showing it.
function ContinueCard({
  row,
  onClose,
  white,
  bare,
  page,
  onLight,
}: {
  row: boolean;
  onClose: () => void;
  white?: boolean;
  bare?: boolean;
  page?: string;
  onLight?: boolean;
}) {
  const arrow = (
    <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden>
      <path d="M4 12h14M12 5l7 7-7 7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="square" />
    </svg>
  );
  return (
    <button
      type="button"
      data-autofocus
      onClick={onClose}
      className={cn(
        "flex cursor-pointer text-left outline-none transition-colors focus-visible:ring-1",
        bare
          ? cn(
              onLight
                ? "text-[#0A0A0A] hover:bg-black/5 focus-visible:ring-black/40"
                : "text-white hover:bg-white/10 focus-visible:ring-white/50",
              !row && !page && (onLight ? "border border-black/20" : "border border-white/40"),
              page,
            )
          : white
            ? "bg-[#EDEDEF] text-[#0A0A0A] hover:bg-[#E2E2E5] focus-visible:ring-black/40"
            : "bg-[#242424] text-white hover:bg-[#2C2C2C] focus-visible:ring-white/40",
        row ? "col-span-2 h-24 items-center justify-between px-8" : "min-h-48 flex-col justify-between p-8",
        // Bare on its own row, nothing marks the card's edge, so the label
        // lines up with the heading's ink instead: GateHeading's 102px indent,
        // 2px more for the "C"'s side bearing against the heading's digit, less
        // the Borders grid's 1px pad. Measured off the pixels.
        bare && row && (page ? "pl-[103px] max-lg:pl-0" : "pl-[104px] max-lg:pl-0"),
      )}
    >
      {row ? (
        <>
          <span className="text-[24px] leading-8 tracking-[-0.01em]">Continue</span>
          {arrow}
        </>
      ) : (
        <>
          <span className="self-end">{arrow}</span>
          <span className="text-[28px] leading-9 tracking-[-0.02em]">Continue</span>
        </>
      )}
    </button>
  );
}

/// The way out, a ghost button at the far end of the heading's line, lined
/// up with its 40px line box. It takes focus on open, so Enter leaves at once.
function ContinueButton({ onClose, onLight }: { onClose: () => void; onLight?: boolean }) {
  return (
    <button
      type="button"
      data-autofocus
      onClick={onClose}
      className={cn(
        "mt-3.5 flex h-10 shrink-0 cursor-pointer items-center rounded-md px-4 text-[15px] outline-none transition-colors focus-visible:ring-1",
        onLight
          ? "text-[#0A0A0A]/75 hover:bg-black/5 hover:text-[#0A0A0A] focus-visible:ring-black/40"
          : "text-white/80 hover:bg-white/10 hover:text-white focus-visible:ring-white/50",
      )}
    >
      Continue
    </button>
  );
}

/// F — landing, in the sign-in gate's own frame (#1277): the site's long
/// stripes from its closing band behind it, rippling where the pointer
/// crosses them as they do there, the light heading counting what is new
/// with Continue at the far end of its line, and the features as cards. Nothing
/// opens and nothing is picked: the reader scans the cards and leaves by
/// Continue or Escape.
///
/// White cards on the site's blue band are the default; black and dark cards
/// stay behind switches. `exit` "card" puts Continue back in the grid as its
/// last card instead of the title's line. Two columns throughout: with the
/// title button an odd count's last card spans the row, and the Continue
/// card fills the odd slot or takes its own row, so no count leaves a hole.
function TakeLanding({
  hl,
  onAction,
  onClose,
  backdrop = "blue",
  cards = "white",
  layout = "gaps",
  exit = "title",
  order = "picture",
}: TakeProps) {
  const one = hl.length === 1;
  const onLight = backdrop === "white";
  const white = cards === "white";
  const asCard = exit !== "title";
  return (
    <Shell
      label="New in Dray"
      onClose={onClose}
      className={cn("overflow-hidden select-none", PAGE[backdrop], onLight ? "text-[#0A0A0A]" : "text-white")}
    >
      {/* Blue is the site's closing band: its own black stripes at 12%.
          White takes them at 7%, just enough to show. */}
      <Stripes ink={{ black: "#FFFFFF14", blue: "#0000001F", white: "#00000012" }[backdrop]} />
      <header data-tauri-drag-region="deep" className="relative flex h-(--titlebar-h,40px) shrink-0 items-center justify-end">
        <WindowControls />
      </header>
      <main className="relative min-h-0 flex-1 overflow-y-auto px-10 pb-12">
        <div className="mx-auto flex w-full max-w-[1120px] flex-col pt-6">
          {/* GateHeading draws white; a white page needs it dark. */}
          <div className={cn("flex items-start justify-between gap-6", onLight && "[&_h1]:text-[#0A0A0A]")}>
            <GateHeading>{one ? "New in Dray." : `${hl.length} new things in Dray.`}</GateHeading>
            {!asCard && <ContinueButton onClose={onClose} onLight={onLight} />}
          </div>
          {/* Gaps and small gaps: 16px or 6px of the page between cards,
              stripes and all. Borders: cards edge to edge, a hairline
              between and around them, as the site's "Ticket to merge" grid
              draws its columns; the line is the grid's own fill showing
              through 1px gaps and a 1px pad. */}
          <div
            className={cn(
              "grid grid-cols-2",
              layout === "gaps" && "gap-4",
              layout === "small" && "gap-1.5",
              layout === "borders" && cn("gap-px p-px", white ? "bg-[#D4D4D8]" : "bg-[#3A3A3A]"),
            )}
          >
            {hl.map((h, i) => (
              <LandingCard
                key={i}
                h={white ? onWhite(h) : h}
                onAction={onAction}
                white={white}
                wide={!asCard && hl.length % 2 === 1 && i === hl.length - 1}
                titleFirst={order === "title"}
                edged={white && onLight && layout !== "borders"}
              />
            ))}
            {asCard && (
              <ContinueCard
                row={hl.length % 2 === 0}
                onClose={onClose}
                white={white}
                bare={exit === "bare"}
                page={layout === "borders" ? PAGE[backdrop] : undefined}
                onLight={onLight}
              />
            )}
          </div>
        </div>
      </main>
    </Shell>
  );
}

const TAKES: { id: string; name: string; what: string; Take: (props: TakeProps) => ReactNode }[] = [
  {
    id: "F",
    name: "Landing (picked)",
    what: "A landing page's feature section in the sign-in gate's own frame: the count as the title, every highlight a large card its title alone explains, Continue, a ghost button at the end of the title's line. Escape leaves too.",
    Take: TakeLanding,
  },
  {
    id: "A",
    name: "Hero",
    what: "The first highlight as a headline over a large video, the rest in a row beneath, Continue pinned at the foot.",
    Take: TakeHero,
  },
  {
    id: "B",
    name: "Story",
    what: "One large section a feature, media and text trading sides as you scroll, Continue at the end.",
    Take: TakeStory,
  },
  {
    id: "C",
    name: "Split",
    what: "Every feature listed on the left, the picked one large on the right. ↑ ↓ walk the list.",
    Take: TakeSplit,
  },
  {
    id: "D",
    name: "Grid",
    what: "A card a feature; each opens into its own detail with a way back to all of them.",
    Take: TakeGrid,
  },
  {
    id: "E",
    name: "Spotlight",
    what: "One feature fills the window at a time over a blurred wash of its own picture, a filmstrip to jump. ← → move.",
    Take: TakeSpotlight,
  },
];

function Row({
  id,
  name,
  what,
  Take,
  hl,
  backdrop,
  cards,
  layout,
  exit,
  order,
}: (typeof TAKES)[number] & {
  hl: Highlight[];
  backdrop: Backdrop;
  cards: Cards;
  layout: Layout;
  exit: Exit;
  order: Order;
}) {
  const [open, setOpen] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  const done = (line: string) => {
    setSaid(line);
    setOpen(false);
  };
  return (
    <li className="flex items-center gap-4 border-b border-border py-4">
      <span className="w-5 font-medium">{id}</span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-ui font-medium">{name}</span>
        <span className="text-ui text-muted-foreground">{what}</span>
      </span>
      {said && <span className="font-mono text-xs text-muted-foreground">{said}</span>}
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        Open
      </Button>
      {open && (
        <Take
          hl={hl}
          backdrop={backdrop}
          cards={cards}
          layout={layout}
          exit={exit}
          order={order}
          onAction={(label) => done(`action: ${label}`)}
          onClose={() => done("closed, seen")}
        />
      )}
    </li>
  );
}

function Demo() {
  const params = new URLSearchParams(location.search);
  const only = params.get("takes");
  // 0 is the next release's own highlights; 1 to 6 are samples.
  const [count, setCount] = useState(() => Math.min(Math.max(Number(params.get("n")) || 0, 0), PAGE_HIGHLIGHTS.length));
  const hl = count === 0 ? NEXT_RELEASE : PAGE_HIGHLIGHTS.slice(0, count);
  const [backdrop, setBackdrop] = useState<Backdrop>(() => {
    const b = params.get("bg");
    return b === "black" || b === "white" ? b : "blue";
  });
  const [cards, setCards] = useState<Cards>(() => (params.get("cards") === "dark" ? "dark" : "white"));
  const [layout, setLayout] = useState<Layout>(() => {
    const l = params.get("layout");
    return l === "small" || l === "borders" ? l : "gaps";
  });
  const [exit, setExit] = useState<Exit>(() => {
    const e = params.get("exit");
    return e === "card" || e === "bare" ? e : "title";
  });
  const [order, setOrder] = useState<Order>(() => (params.get("order") === "title" ? "title" : "picture"));
  return (
    <TooltipProvider>
      <div className="mx-auto flex max-w-3xl flex-col gap-6 p-10">
        <header className="flex flex-col gap-2">
          <h1 className="text-lg font-medium">What's new: full-page takes</h1>
          <p className="text-ui text-muted-foreground">
            Ways to give a release's highlights the whole window; F is the one picked. Open covers the window as the app
            would. Each leaves by Continue or Escape.
          </p>
          <div className="mt-2 flex items-center gap-3 text-ui">
            <span className="text-muted-foreground">Highlights</span>
            <div role="radiogroup" aria-label="Highlights" className="flex gap-1">
              <Button
                role="radio"
                aria-checked={count === 0}
                size="sm"
                variant={count === 0 ? "default" : "outline"}
                onClick={() => setCount(0)}
              >
                Next release
              </Button>
              {PAGE_HIGHLIGHTS.map((_, i) => (
                <Button
                  key={i}
                  role="radio"
                  aria-checked={count === i + 1}
                  size="icon-sm"
                  variant={count === i + 1 ? "default" : "outline"}
                  onClick={() => setCount(i + 1)}
                >
                  {i + 1}
                </Button>
              ))}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-ui">
            <span className="text-muted-foreground">F backdrop</span>
            <div role="radiogroup" aria-label="F backdrop" className="flex gap-1">
              {(["black", "blue", "white"] as const).map((b) => (
                <Button
                  key={b}
                  role="radio"
                  aria-checked={backdrop === b}
                  size="sm"
                  variant={backdrop === b ? "default" : "outline"}
                  onClick={() => setBackdrop(b)}
                >
                  {{ black: "Black", blue: "Blue", white: "White" }[b]}
                </Button>
              ))}
            </div>
            <span className="ml-3 text-muted-foreground">Cards</span>
            <div role="radiogroup" aria-label="F cards" className="flex gap-1">
              {(["dark", "white"] as const).map((c) => (
                <Button
                  key={c}
                  role="radio"
                  aria-checked={cards === c}
                  size="sm"
                  variant={cards === c ? "default" : "outline"}
                  onClick={() => setCards(c)}
                >
                  {c === "dark" ? "Dark" : "White"}
                </Button>
              ))}
            </div>
            <span className="ml-3 text-muted-foreground">Layout</span>
            <div role="radiogroup" aria-label="F layout" className="flex gap-1">
              {(["gaps", "small", "borders"] as const).map((l) => (
                <Button
                  key={l}
                  role="radio"
                  aria-checked={layout === l}
                  size="sm"
                  variant={layout === l ? "default" : "outline"}
                  onClick={() => setLayout(l)}
                >
                  {{ gaps: "Gaps", small: "Small gaps", borders: "Borders" }[l]}
                </Button>
              ))}
            </div>
            <span className="ml-3 text-muted-foreground">Exit</span>
            <div role="radiogroup" aria-label="F exit" className="flex gap-1">
              {(["card", "bare", "title"] as const).map((e) => (
                <Button
                  key={e}
                  role="radio"
                  aria-checked={exit === e}
                  size="sm"
                  variant={exit === e ? "default" : "outline"}
                  onClick={() => setExit(e)}
                >
                  {{ card: "Card", bare: "Card, no fill", title: "Title button" }[e]}
                </Button>
              ))}
            </div>
            <span className="ml-3 text-muted-foreground">Order</span>
            <div role="radiogroup" aria-label="F card order" className="flex gap-1">
              {(["picture", "title"] as const).map((o) => (
                <Button
                  key={o}
                  role="radio"
                  aria-checked={order === o}
                  size="sm"
                  variant={order === o ? "default" : "outline"}
                  onClick={() => setOrder(o)}
                >
                  {o === "picture" ? "Picture first" : "Title first"}
                </Button>
              ))}
            </div>
          </div>
        </header>
        <ul className="flex flex-col border-t border-border">
          {TAKES.filter((t) => !only || only.includes(t.id)).map((t) => (
            <Row key={t.id} {...t} hl={hl} backdrop={backdrop} cards={cards} layout={layout} exit={exit} order={order} />
          ))}
        </ul>
      </div>
      <DemoThemeBar />
    </TooltipProvider>
  );
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <Demo />
  </React.StrictMode>,
);
