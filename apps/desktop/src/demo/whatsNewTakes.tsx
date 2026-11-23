import React, { useState, type ReactNode } from "react";
import ReactDOM from "react-dom/client";

import { ArrowRightIcon, CheckIcon, ChevronLeftIcon, SparklesIcon } from "@heroicons/react/16/solid";

import { changelogInline, changelogPlain } from "@/components/changelogText";
import WhatsNewDialog from "@/components/WhatsNewDialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { TooltipProvider } from "@/components/ui/tooltip";
import DemoThemeBar from "@/demo/ThemeBar";
import { HIGHLIGHTS } from "@/demo/whatsNewData";
import type { ChangelogMedia, Highlight } from "@/lib/changelog";
import { cn } from "@/lib/utils";
import "../App.css";

/// Takes on the what's-new dialog, side by side over the same three pages: an
/// action on the first, a picture on the second (a video with `?video=<url>`),
/// none on the third. Each is drawn in place over a dimmed stage, so they can be
/// compared at once, and "Open as dialog" raises it full size as the app would;
/// every button works in both. B is the shipped layout, and its dialog is the
/// real one. `?takes=ACE` draws only those.

type TakeProps = { hl: Highlight[]; onAction: (label: string) => void; onClose: () => void };

function usePager(count: number) {
  const [page, setPage] = useState(0);
  const step = (by: number) => setPage((p) => Math.min(Math.max(p + by, 0), count - 1));
  return { page, setPage, step, last: page === count - 1 };
}

function Media({ media, className }: { media: ChangelogMedia; className?: string }) {
  return media.kind === "video" ? (
    <video src={media.url} autoPlay muted loop playsInline className={cn("object-cover", className)} />
  ) : (
    <img src={media.url} alt={media.alt} className={cn("object-cover", className)} />
  );
}

const Version = ({ v, className }: { v: string; className?: string }) => (
  <span className={cn("flex items-center gap-1.5 text-xs text-muted-foreground", className)}>
    <SparklesIcon className="size-3.5 text-accent-add" aria-hidden />
    New in Dray {v}
  </span>
);

function Dots({ count, page, onPick, tone = "default" }: { count: number; page: number; onPick: (p: number) => void; tone?: "default" | "light" }) {
  return (
    <div className="flex items-center gap-0.5">
      {Array.from({ length: count }, (_, i) => (
        <button
          key={i}
          type="button"
          aria-label={`Page ${i + 1}`}
          onClick={() => onPick(i)}
          className="flex size-4 cursor-pointer items-center justify-center"
        >
          <span
            className={cn(
              "size-1.5 rounded-full transition-colors",
              tone === "light"
                ? i === page ? "bg-white" : "bg-white/35"
                : i === page ? "bg-foreground" : "bg-muted-foreground/35",
            )}
          />
        </button>
      ))}
    </div>
  );
}

/// A — the first take, shipped before B was picked: inset media, text under
/// it, Skip · dots · Next.
function TakeA({ hl, onAction, onClose }: TakeProps) {
  const p = usePager(hl.length);
  const { version, item } = hl[p.page];
  const action = item.highlight?.action;
  return (
    <div className="w-[34rem] overflow-hidden rounded-xl border border-border bg-popover backdrop-blur-xl text-popover-foreground shadow-lg">
      <div key={p.page} className="animate-in fade-in-0 [animation-duration:200ms]">
        {item.media[0] && (
          <div className="px-1.5 pt-1.5">
            <Media media={item.media[0]} className="aspect-video w-full rounded-lg bg-muted" />
          </div>
        )}
        <div className="flex min-h-39 flex-col gap-1.5 px-5 pt-4">
          <Version v={version} />
          <p className="text-base font-medium text-foreground">{changelogPlain(item.title ?? item.body)}</p>
          <p className="text-chat leading-relaxed text-muted-foreground">{changelogInline(item.body)}</p>
          {action && (
            <Button variant="outline" size="sm" className="mt-1.5 self-start" onClick={() => onAction(action.label)}>
              {action.label}
            </Button>
          )}
        </div>
      </div>
      <footer className="grid grid-cols-[1fr_auto_1fr] items-center px-5 py-4">
        <div>{!p.last && <Button variant="ghost" size="sm" onClick={onClose}>Skip</Button>}</div>
        <Dots count={hl.length} page={p.page} onPick={p.setPage} />
        <div className="flex justify-end">
          <Button size="sm" className="min-w-16" onClick={p.last ? onClose : () => p.step(1)}>
            {p.last ? "Done" : "Next"}
          </Button>
        </div>
      </footer>
    </div>
  );
}

/// B — shipped, as `WhatsNewDialog` draws it: media edge to edge and rounded
/// below, "New in Dray" on it, a larger title, the action as a link in the
/// text, dots left and Skip · Back · Next right.
function TakeB({ hl, onAction, onClose }: TakeProps) {
  const p = usePager(hl.length);
  const { item } = hl[p.page];
  const action = item.highlight?.action;
  return (
    <div className="w-[40rem] overflow-hidden rounded-xl border border-border bg-popover backdrop-blur-xl text-popover-foreground shadow-lg">
      <div key={p.page} className="animate-in fade-in-0 [animation-duration:200ms]">
        <div className="relative aspect-video w-full overflow-hidden rounded-b-xl bg-muted">
          {item.media[0] ? (
            <Media media={item.media[0]} className="size-full" />
          ) : (
            <div className="flex size-full items-center justify-center">
              <SparklesIcon className="size-10 text-accent-add" aria-hidden />
            </div>
          )}
          <span className="absolute top-3 left-3 flex items-center gap-1.5 rounded-md bg-black/55 px-2 py-1 text-xs font-medium text-white backdrop-blur-md">
            <SparklesIcon className="size-3.5 text-[#3DD68C]" aria-hidden />
            New in Dray
          </span>
        </div>
        <div className="flex min-h-36 flex-col gap-2 px-7 pt-6">
          <p className="text-xl font-semibold tracking-tight text-foreground">{changelogPlain(item.title ?? item.body)}</p>
          <p className="text-chat leading-relaxed text-muted-foreground">
            {changelogInline(item.body)}
            {action && (
              <>
                {" "}
                <button
                  type="button"
                  onClick={() => onAction(action.label)}
                  className="inline-flex cursor-pointer items-center gap-1 font-medium text-foreground underline-offset-4 hover:underline"
                >
                  {action.label}
                  <ArrowRightIcon className="size-3.5" aria-hidden />
                </button>
              </>
            )}
          </p>
        </div>
      </div>
      <footer className="flex items-center gap-1.5 px-7 pt-5 pb-6">
        <Dots count={hl.length} page={p.page} onPick={p.setPage} />
        <div className="ml-auto flex items-center gap-1.5">
          {!p.last && (
            <Button variant="ghost" className="text-muted-foreground" onClick={onClose}>
              Skip
            </Button>
          )}
          {p.page > 0 && (
            <Button variant="outline" onClick={() => p.step(-1)}>
              Back
            </Button>
          )}
          <Button className="min-w-20" onClick={p.last ? onClose : () => p.step(1)}>
            {p.last ? "Done" : "Next"}
          </Button>
        </div>
      </footer>
    </div>
  );
}

/// C — side by side: media fills the left, text and buttons on the right, a
/// count instead of dots and a Back arrow.
function TakeC({ hl, onAction, onClose }: TakeProps) {
  const p = usePager(hl.length);
  const { version, item } = hl[p.page];
  const action = item.highlight?.action;
  return (
    <div className="grid h-[22rem] w-[50rem] grid-cols-[1.35fr_1fr] overflow-hidden rounded-xl border border-border bg-popover backdrop-blur-xl text-popover-foreground shadow-lg">
      <div key={`m${p.page}`} className="animate-in fade-in-0 [animation-duration:200ms] bg-muted">
        {item.media[0] ? (
          <Media media={item.media[0]} className="size-full" />
        ) : (
          <div className="flex size-full items-center justify-center">
            <SparklesIcon className="size-10 text-accent-add" aria-hidden />
          </div>
        )}
      </div>
      <div className="flex flex-col p-6">
        <div className="flex items-center justify-between">
          <Version v={version} />
          <span className="text-xs text-muted-foreground tabular-nums">
            {p.page + 1} of {hl.length}
          </span>
        </div>
        <div key={`t${p.page}`} className="mt-4 flex flex-col gap-2 animate-in fade-in-0 [animation-duration:200ms]">
          <p className="text-lg font-medium text-foreground">{changelogPlain(item.title ?? item.body)}</p>
          <p className="text-chat leading-relaxed text-muted-foreground">{changelogInline(item.body)}</p>
          {action && (
            <Button variant="outline" size="sm" className="mt-1 self-start" onClick={() => onAction(action.label)}>
              {action.label}
            </Button>
          )}
        </div>
        <footer className="mt-auto flex items-center gap-1.5">
          {p.page > 0 ? (
            <Button variant="ghost" size="icon-sm" aria-label="Back" onClick={() => p.step(-1)}>
              <ChevronLeftIcon className="size-4" />
            </Button>
          ) : (
            <Button variant="ghost" size="sm" onClick={onClose}>
              Skip
            </Button>
          )}
          <Button size="sm" className="ml-auto min-w-16" onClick={p.last ? onClose : () => p.step(1)}>
            {p.last ? "Done" : "Next"}
          </Button>
        </footer>
      </div>
    </div>
  );
}

/// D — centred sheet: dots on top, centred text, media under it, one wide
/// Next with Skip as a quiet line beneath.
function TakeD({ hl, onAction, onClose }: TakeProps) {
  const p = usePager(hl.length);
  const { version, item } = hl[p.page];
  const action = item.highlight?.action;
  return (
    <div className="flex w-[30rem] flex-col items-center rounded-xl border border-border bg-popover backdrop-blur-xl p-7 text-center text-popover-foreground shadow-lg">
      <Dots count={hl.length} page={p.page} onPick={p.setPage} />
      <div key={p.page} className="flex w-full flex-col items-center animate-in fade-in-0 [animation-duration:200ms]">
        <Version v={version} className="mt-4" />
        <p className="mt-2 text-xl font-semibold tracking-tight text-foreground">{changelogPlain(item.title ?? item.body)}</p>
        <p className="mt-2 max-w-[24rem] text-chat leading-relaxed text-pretty text-muted-foreground">{changelogInline(item.body)}</p>
        {action && (
          <button
            type="button"
            onClick={() => onAction(action.label)}
            className="mt-2 inline-flex cursor-pointer items-center gap-1 text-ui font-medium text-accent-add underline-offset-4 hover:underline"
          >
            {action.label}
            <ArrowRightIcon className="size-3.5" aria-hidden />
          </button>
        )}
        <div className="mt-5 aspect-video w-full overflow-hidden rounded-lg bg-muted">
          {item.media[0] ? (
            <Media media={item.media[0]} className="size-full" />
          ) : (
            <div className="flex size-full items-center justify-center">
              <SparklesIcon className="size-8 text-accent-add" aria-hidden />
            </div>
          )}
        </div>
      </div>
      <Button className="mt-6 w-full" onClick={p.last ? onClose : () => p.step(1)}>
        {p.last ? "Done" : "Next"}
      </Button>
      <button
        type="button"
        onClick={onClose}
        className={cn("mt-2 cursor-pointer text-ui text-muted-foreground hover:text-foreground", p.last && "invisible")}
      >
        Skip
      </button>
    </div>
  );
}

/// E — cinematic: the media is the card, text and buttons sit on a dark scrim
/// at its foot, progress runs as segments across the top. Same in both modes.
function TakeE({ hl, onAction, onClose }: TakeProps) {
  const p = usePager(hl.length);
  const { version, item } = hl[p.page];
  const action = item.highlight?.action;
  return (
    <div className="relative aspect-[16/10] w-[44rem] overflow-hidden rounded-xl bg-neutral-900 text-white shadow-lg ring-1 ring-white/10">
      <div key={p.page} className="absolute inset-0 animate-in fade-in-0 [animation-duration:300ms]">
        {item.media[0] ? (
          <Media media={item.media[0]} className="size-full" />
        ) : (
          <div className="size-full bg-[radial-gradient(circle_at_30%_20%,oklch(0.45_0.15_160),transparent_60%),radial-gradient(circle_at_80%_70%,oklch(0.4_0.18_265),transparent_55%)]" />
        )}
      </div>
      <div className="absolute inset-0 bg-linear-to-t from-black via-black/75 via-35% to-transparent to-75%" />
      <div className="absolute inset-x-4 top-4 flex gap-1">
        {hl.map((_, i) => (
          <button
            key={i}
            type="button"
            aria-label={`Page ${i + 1}`}
            onClick={() => p.setPage(i)}
            className={cn("h-1 flex-1 cursor-pointer rounded-full transition-colors", i <= p.page ? "bg-white" : "bg-white/30")}
          />
        ))}
      </div>
      <div key={`t${p.page}`} className="absolute inset-x-0 bottom-0 flex items-end gap-6 p-6 animate-in fade-in-0 slide-in-from-bottom-1 [animation-duration:300ms]">
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <span className="flex items-center gap-1.5 text-xs text-white/70">
            <SparklesIcon className="size-3.5 text-[#3DD68C]" aria-hidden />
            New in Dray {version}
          </span>
          <p className="text-2xl font-semibold tracking-tight">{changelogPlain(item.title ?? item.body)}</p>
          <p className="text-chat leading-relaxed text-white/75">{changelogPlain(item.body)}</p>
          {action && (
            <button
              type="button"
              onClick={() => onAction(action.label)}
              className="mt-1.5 self-start cursor-pointer rounded-lg bg-white/15 px-2.5 py-1 text-ui font-medium backdrop-blur-md transition-colors hover:bg-white/25"
            >
              {action.label}
            </button>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {!p.last && (
            <button type="button" onClick={onClose} className="cursor-pointer px-2.5 py-1 text-ui text-white/70 hover:text-white">
              Skip
            </button>
          )}
          <button
            type="button"
            onClick={p.last ? onClose : () => p.step(1)}
            className="min-w-16 cursor-pointer rounded-lg bg-white px-3 py-1.5 text-ui font-medium text-black transition-colors hover:bg-white/90"
          >
            {p.last ? "Done" : "Next"}
          </button>
        </div>
      </div>
    </div>
  );
}

/// F — index and page: every highlight listed on the left, so how many there
/// are and which is next is read at a glance; the list is the dots.
function TakeF({ hl, onAction, onClose }: TakeProps) {
  const p = usePager(hl.length);
  const [seen, setSeen] = useState<Set<number>>(() => new Set([0]));
  const go = (i: number) => {
    p.setPage(i);
    setSeen((s) => new Set(s).add(i));
  };
  const { item } = hl[p.page];
  const action = item.highlight?.action;
  return (
    <div className="grid w-[50rem] grid-cols-[13rem_1fr] overflow-hidden rounded-xl border border-border bg-popover backdrop-blur-xl text-popover-foreground shadow-lg">
      <aside className="flex flex-col gap-0.5 border-r border-border bg-muted/40 p-2.5">
        <p className="flex items-center gap-1.5 px-2 pt-1 pb-2.5 text-ui font-medium text-foreground">
          <SparklesIcon className="size-3.5 text-accent-add" aria-hidden />
          What's new
        </p>
        {hl.map((h, i) => (
          <button
            key={i}
            type="button"
            onClick={() => go(i)}
            className={cn(
              "flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-ui transition-colors",
              i === p.page ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
            )}
          >
            <span className="flex size-4 shrink-0 items-center justify-center">
              {seen.has(i) && i !== p.page ? (
                <CheckIcon className="size-3.5 text-accent-add" aria-hidden />
              ) : (
                <span className="text-xs tabular-nums">{i + 1}</span>
              )}
            </span>
            <span className="min-w-0 truncate">{changelogPlain(h.item.title ?? h.item.body)}</span>
          </button>
        ))}
        <span className="mt-auto px-2 pt-4 text-xs text-muted-foreground">Dray {hl[0].version}</span>
      </aside>
      <div className="flex flex-col">
        <div key={p.page} className="animate-in fade-in-0 [animation-duration:200ms]">
          <div className="px-2 pt-2">
            {item.media[0] ? (
              <Media media={item.media[0]} className="aspect-video w-full rounded-lg bg-muted" />
            ) : (
              <div className="flex aspect-video w-full items-center justify-center rounded-lg bg-muted">
                <SparklesIcon className="size-8 text-accent-add" aria-hidden />
              </div>
            )}
          </div>
          <div className="flex min-h-32 flex-col gap-1.5 px-5 pt-4">
            <p className="text-base font-medium text-foreground">{changelogPlain(item.title ?? item.body)}</p>
            <p className="text-chat leading-relaxed text-muted-foreground">{changelogInline(item.body)}</p>
            {action && (
              <Button variant="outline" size="sm" className="mt-1.5 self-start" onClick={() => onAction(action.label)}>
                {action.label}
              </Button>
            )}
          </div>
        </div>
        <footer className="mt-auto flex items-center px-5 py-4">
          {!p.last && <Button variant="ghost" size="sm" onClick={onClose}>Skip</Button>}
          <Button size="sm" className="ml-auto min-w-16" onClick={p.last ? onClose : () => go(p.page + 1)}>
            {p.last ? "Done" : "Next"}
          </Button>
        </footer>
      </div>
    </div>
  );
}

const TAKES: { id: string; name: string; Take: (props: TakeProps) => ReactNode }[] = [
  { id: "A", name: "First take: inset media, Skip · dots · Next", Take: TakeA },
  { id: "B", name: "Shipped: full bleed, label on the picture, Back", Take: TakeB },
  { id: "C", name: "Side by side, count and Back", Take: TakeC },
  { id: "D", name: "Centred sheet, wide Next", Take: TakeD },
  { id: "E", name: "Cinematic: media is the card", Take: TakeE },
  { id: "F", name: "Index of highlights beside the page", Take: TakeF },
];

/// A take raised full size the way the real one is: the shared `DialogContent`
/// for its overlay, blur, placement and Escape, stripped of its own frame so
/// the take's card is the only one drawn.
function TakeDialog({ id, Take, onDone }: { id: string; Take: (props: TakeProps) => ReactNode; onDone: (said: string) => void }) {
  return (
    <Dialog open onOpenChange={(open) => !open && onDone("closed, seen")}>
      <DialogContent
        showClose={false}
        dismissible={false}
        onEscapeKeyDown={() => onDone("escape, seen")}
        aria-describedby={undefined}
        className="w-auto max-w-none gap-0 rounded-none border-0 bg-transparent p-0 shadow-none backdrop-blur-none"
      >
        <DialogTitle className="sr-only">What's new, take {id}</DialogTitle>
        <Take hl={HIGHLIGHTS} onAction={(label) => onDone(`action: ${label}`)} onClose={() => onDone("closed, seen")} />
      </DialogContent>
    </Dialog>
  );
}

/// The app dimmed behind, as the overlay draws it, with the take over it.
function Stage({ id, name, Take }: (typeof TAKES)[number]) {
  const [open, setOpen] = useState(true);
  const [modal, setModal] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  const done = (line: string) => {
    setSaid(line);
    setModal(false);
  };
  return (
    <section className="flex flex-col gap-2">
      <h2 className="flex items-center gap-2 text-ui">
        <span className="font-medium text-foreground">{id}</span>
        <span className="text-muted-foreground">{name}</span>
        <span className="ml-auto flex items-center gap-3">
          {said && <span className="font-mono text-xs text-muted-foreground">{said}</span>}
          <Button size="sm" variant="outline" onClick={() => setModal(true)}>
            Open as dialog
          </Button>
        </span>
      </h2>
      {modal &&
        (id === "B" ? (
          <WhatsNewDialog
            highlights={HIGHLIGHTS}
            actionFor={(target) => () => setSaid(`action: ${target}`)}
            onClose={() => done("closed, seen")}
          />
        ) : (
          <TakeDialog id={id} Take={Take} onDone={done} />
        ))}
      <div className="relative flex min-h-[34rem] items-center justify-center overflow-hidden rounded-xl border border-border bg-background p-8">
        <div className="absolute inset-0 bg-black/50" />
        <div className="relative">
          {open ? (
            <Take
              hl={HIGHLIGHTS}
              onAction={(label) => {
                setSaid(`action: ${label}`);
                setOpen(false);
              }}
              onClose={() => {
                setSaid("closed, seen");
                setOpen(false);
              }}
            />
          ) : (
            <Button variant="outline" onClick={() => setOpen(true)}>
              Show again
            </Button>
          )}
        </div>
      </div>
    </section>
  );
}

function Demo() {
  const only = new URLSearchParams(location.search).get("takes");
  return (
    <TooltipProvider>
      <div className="mx-auto flex max-w-[60rem] flex-col gap-10 p-10">
        <header className="flex flex-col gap-2">
          <h1 className="text-lg font-medium">What's new: takes</h1>
          <p className="text-ui text-muted-foreground">
            Three pages each: an action, a picture, no media. Every button works; Show again resets a take.
            Open as dialog raises a take full size over the page, as the app would; B's is the real dialog.
          </p>
        </header>
        {TAKES.filter((t) => !only || only.includes(t.id)).map((t) => (
          <Stage key={t.id} {...t} />
        ))}
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
