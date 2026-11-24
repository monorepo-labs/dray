import { useRef, useState } from "react";

import { ArrowLeftIcon, ArrowRightIcon, SparklesIcon } from "@heroicons/react/16/solid";

import { changelogInline, changelogPlain } from "@/components/changelogText";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import type { ChangelogMedia, Highlight } from "@/lib/changelog";
import { cn } from "@/lib/utils";

/// The paged dialog What's New first shipped as, take B in
/// [whatsNewTakes.tsx](whatsNewTakes.tsx), kept for those takes once the
/// full-window [WhatsNewPage](../components/WhatsNewPage.tsx) replaced it.
///
/// A release's bigger features after an update, a page each: the item's first
/// image or video, its title and its text, and a link where the highlight
/// names an action this build knows.
///
/// The app raised it rather than the reader, so it is answered by its own
/// buttons and carries no close cross. Escape skips it too, and every way out
/// is the same answer: seen, all of it. An action ends it as well, since the
/// reader just chose to go somewhere.
export default function WhatsNewDialog({
  highlights,
  actionFor,
  onClose,
}: {
  highlights: Highlight[];
  /// What a target does here, or null for one this build does not know, which
  /// then draws no button.
  actionFor: (target: string) => (() => void) | null;
  onClose: () => void;
}) {
  const [page, setPage] = useState(0);
  const next = useRef<HTMLButtonElement>(null);
  const count = highlights.length;
  const last = page === count - 1;
  const { item } = highlights[page];
  const media = item.media[0];
  const action = item.highlight?.action ?? null;
  const run = action && actionFor(action.target);
  const described = Boolean(item.title && item.body);
  const step = (by: number) => setPage((p) => Math.min(Math.max(p + by, 0), count - 1));

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        showClose={false}
        // A stray click beside it would skip every page unread, so the overlay
        // does nothing; Escape still skips.
        dismissible={false}
        onEscapeKeyDown={onClose}
        // Radix links a description itself; a one-line item has none, and
        // saying so is what keeps it from warning.
        {...(!described && { "aria-describedby": undefined })}
        className="max-w-[40rem] gap-0 overflow-hidden p-0"
        // Next, not Skip, takes focus: Enter walks the pages, and Done ends
        // on the same button, so focus never has to move.
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          next.current?.focus();
        }}
        onKeyDown={(e) => {
          if (e.target instanceof HTMLInputElement) return;
          if (e.key === "ArrowRight") step(1);
          else if (e.key === "ArrowLeft") step(-1);
          else return;
          e.preventDefault();
        }}
      >
        {/* Keyed on the page, so each one fades in rather than swapping. */}
        <div key={page} className="flex flex-col animate-in fade-in-0 [animation-duration:200ms]">
          <Media media={media} />
          {/* Tall enough for a title, two lines and the action, so Next stays
              under the pointer from page to page. */}
          <div className="flex min-h-42 flex-col gap-2 px-7 pt-6">
            <DialogTitle className="text-xl font-medium tracking-tight text-foreground">
              {changelogPlain(item.title ?? item.body)}
            </DialogTitle>
            {described && (
              <DialogDescription className="text-chat leading-relaxed text-muted-foreground">
                {changelogInline(item.body)}
              </DialogDescription>
            )}
            {/* Its own line, apart from the text, so it reads as something to
                do rather than the sentence's last words. */}
            {action && run && (
              <button
                type="button"
                onClick={() => {
                  onClose();
                  run();
                }}
                className="mt-2 inline-flex cursor-pointer items-center gap-1 self-start rounded-sm text-chat font-medium text-foreground underline-offset-4 hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
              >
                {action.label}
                <ArrowRightIcon className="size-3.5" aria-hidden />
              </button>
            )}
          </div>
        </div>
        {/* Over the picture, outside the page's fade so neither blinks when the
            page turns. Dark pills of their own rather than theme tokens: they
            sit on the picture, whatever it is, not on the dialog. */}
        <div className="pointer-events-none absolute inset-x-3 top-3 flex items-start justify-between">
          <span className={cn(PILL, "flex items-center gap-1.5")}>
            <SparklesIcon className="size-3.5 text-[#3DD68C]" aria-hidden />
            New in Dray
          </span>
          {!last && (
            <button
              type="button"
              onClick={onClose}
              className={cn(
                PILL,
                "pointer-events-auto cursor-pointer transition-colors hover:bg-black/75 focus-visible:ring-[3px] focus-visible:ring-white/50 focus-visible:outline-none",
              )}
            >
              Skip
            </button>
          )}
        </div>
        <footer className="flex items-center gap-1.5 px-7 pt-5 pb-6">
          {count > 1 && <Dots count={count} page={page} onPick={setPage} />}
          {/* Next is the rightmost and never moves; Back comes and goes to its
              left. Next and Done are one button, so focus and Enter carry on
              through the last page. */}
          <div className="ml-auto flex items-center gap-1.5">
            {page > 0 && (
              <Button variant="outline" size="icon" aria-label="Back" onClick={() => step(-1)}>
                <ArrowLeftIcon className="size-4" aria-hidden />
              </Button>
            )}
            <Button
              ref={next}
              size={last ? "default" : "icon"}
              aria-label={last ? undefined : "Next"}
              className={cn(last && "min-w-16")}
              onClick={last ? onClose : () => step(1)}
            >
              {last ? "Done" : <ArrowRightIcon className="size-4" aria-hidden />}
            </Button>
          </div>
        </footer>
      </DialogContent>
    </Dialog>
  );
}

const PILL = "rounded-md bg-black/55 px-2 py-1 text-xs font-medium text-white backdrop-blur-md";

/// Edge to edge across the top, the dialog's own corners clipping it there,
/// and rounded off below. A page with no media keeps the same box, so the
/// dialog's height and Next hold still from page to page.
function Media({ media }: { media: ChangelogMedia | undefined }) {
  const box = "size-full object-cover";
  return (
    <div className="relative aspect-video w-full overflow-hidden rounded-b-xl bg-muted">
      {media?.kind === "video" ? (
        <video src={media.url} aria-label={media.alt || undefined} autoPlay muted loop playsInline className={box} />
      ) : media ? (
        <img src={media.url} alt={media.alt} className={box} />
      ) : (
        <div className="flex size-full items-center justify-center">
          <SparklesIcon className="size-10 text-accent-add" aria-hidden />
        </div>
      )}
    </div>
  );
}

/// One dot a page, each a way straight to it.
function Dots({ count, page, onPick }: { count: number; page: number; onPick: (page: number) => void }) {
  return (
    <div className="flex items-center gap-0.5">
      {Array.from({ length: count }, (_, i) => (
        <button
          key={i}
          type="button"
          tabIndex={-1}
          aria-label={`Page ${i + 1} of ${count}`}
          aria-current={i === page ? "step" : undefined}
          // Focus stays on Next, so Enter still walks on after a pick.
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onPick(i)}
          className="group flex size-4 cursor-pointer items-center justify-center"
        >
          <span
            className={cn(
              "size-1.5 rounded-full transition-colors",
              i === page ? "bg-foreground" : "bg-muted-foreground/35 group-hover:bg-muted-foreground/70",
            )}
          />
        </button>
      ))}
    </div>
  );
}
