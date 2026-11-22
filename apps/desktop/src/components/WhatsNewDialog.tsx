import { useRef, useState } from "react";

import { SparklesIcon } from "@heroicons/react/16/solid";

import { changelogInline, changelogPlain } from "@/components/changelogText";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import type { ChangelogMedia, Highlight } from "@/lib/changelog";
import { cn } from "@/lib/utils";

/// A release's bigger features after an update, a page each: the item's first
/// image or video, its title and its text, and a button where the highlight
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
  const { version, item } = highlights[page];
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
        className="max-w-[34rem] gap-0 overflow-hidden p-0"
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
          {media && <Media media={media} />}
          {/* Tall enough for a title, two lines and an action, so Next stays
              under the pointer from page to page. */}
          <div className="flex min-h-39 flex-col gap-1.5 px-5 pt-4">
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <SparklesIcon className="size-3.5 text-accent-add" aria-hidden />
              New in Dray {version}
            </span>
            <DialogTitle className="text-base font-medium text-foreground">
              {changelogPlain(item.title ?? item.body)}
            </DialogTitle>
            {described && (
              <DialogDescription className="text-chat leading-relaxed text-muted-foreground">
                {changelogInline(item.body)}
              </DialogDescription>
            )}
            {action && run && (
              <Button
                variant="outline"
                size="sm"
                className="mt-1.5 self-start"
                onClick={() => {
                  onClose();
                  run();
                }}
              >
                {action.label}
              </Button>
            )}
          </div>
        </div>
        <footer className="grid grid-cols-[1fr_auto_1fr] items-center px-5 pt-4 pb-4">
          <div>
            {!last && (
              <Button variant="ghost" size="sm" onClick={onClose}>
                Skip
              </Button>
            )}
          </div>
          {count > 1 ? <Dots count={count} page={page} onPick={setPage} /> : <span />}
          <div className="flex justify-end">
            <Button ref={next} size="sm" className="min-w-16" onClick={last ? onClose : () => step(1)}>
              {last ? "Done" : "Next"}
            </Button>
          </div>
        </footer>
      </DialogContent>
    </Dialog>
  );
}

/// Inset from the dialog's edge: 6px in, 8px corners sit concentric with its
/// 14px.
function Media({ media }: { media: ChangelogMedia }) {
  const box = "aspect-video w-full rounded-lg bg-muted object-cover";
  return (
    <div className="px-1.5 pt-1.5">
      {media.kind === "video" ? (
        <video
          src={media.url}
          aria-label={media.alt || undefined}
          autoPlay
          muted
          loop
          playsInline
          className={box}
        />
      ) : (
        <img src={media.url} alt={media.alt} className={box} />
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
