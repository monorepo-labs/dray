import { useRef, useState } from "react";

import { ArrowRightIcon, SparklesIcon } from "@heroicons/react/16/solid";

import { changelogInline, changelogPlain } from "@/components/changelogText";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import type { ChangelogMedia, Highlight } from "@/lib/changelog";
import { cn } from "@/lib/utils";

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
  const hasText = described || Boolean(run);
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
        {...(!hasText && { "aria-describedby": undefined })}
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
          <div className="flex min-h-36 flex-col gap-2 px-7 pt-6">
            <DialogTitle className="text-xl font-semibold tracking-tight text-foreground">
              {changelogPlain(item.title ?? item.body)}
            </DialogTitle>
            {hasText && (
              <DialogDescription className="text-chat leading-relaxed text-muted-foreground">
                {described && changelogInline(item.body)}
                {action && run && (
                  <>
                    {described && " "}
                    <button
                      type="button"
                      onClick={() => {
                        onClose();
                        run();
                      }}
                      className="inline-flex cursor-pointer items-center gap-1 rounded-sm font-medium text-foreground underline-offset-4 hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
                    >
                      {action.label}
                      <ArrowRightIcon className="size-3.5" aria-hidden />
                    </button>
                  </>
                )}
              </DialogDescription>
            )}
          </div>
        </div>
        <footer className="flex items-center gap-1.5 px-7 pt-5 pb-6">
          {count > 1 && <Dots count={count} page={page} onPick={setPage} />}
          {/* Next is the rightmost and never moves; Back and Skip come and go
              to its left. */}
          <div className="ml-auto flex items-center gap-1.5">
            {!last && (
              <Button variant="ghost" className="text-muted-foreground" onClick={onClose}>
                Skip
              </Button>
            )}
            {page > 0 && (
              <Button variant="outline" onClick={() => step(-1)}>
                Back
              </Button>
            )}
            <Button ref={next} className="min-w-20" onClick={last ? onClose : () => step(1)}>
              {last ? "Done" : "Next"}
            </Button>
          </div>
        </footer>
      </DialogContent>
    </Dialog>
  );
}

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
      {/* Its own dark pill, not a theme token: it sits on the picture, not on
          the dialog. */}
      <span className="absolute top-3 left-3 flex items-center gap-1.5 rounded-md bg-black/55 px-2 py-1 text-xs font-medium text-white backdrop-blur-md">
        <SparklesIcon className="size-3.5 text-[#3DD68C]" aria-hidden />
        New in Dray
      </span>
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
