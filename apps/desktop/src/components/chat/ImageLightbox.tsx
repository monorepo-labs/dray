import { useState, type MouseEvent } from "react";
import { Dialog } from "radix-ui";
import { ArrowLeft, ArrowRight, ChevronLeft, ChevronRight, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import { cn } from "@/lib/utils";

type LightboxImage = { src: string; name: string };

/// The images of one message at full size, over the transcript rather than
/// inside it.
///
/// A thumbnail in a message row is capped by the row, which is capped by the
/// column — so a screenshot of a screen is unreadable at the only size the
/// transcript can give it. Opening it has to leave the layout entirely, which is
/// what makes this a dialog rather than an expanding row.
///
/// It takes the whole set and an index rather than one image, because a message
/// carrying three screenshots is one thing to look at: closing and reopening to
/// compare two of them is the work the arrows and the filmstrip exist to remove.
/// The index *is* the state, so opening at a picture and stepping to the next
/// are the same operation.
///
/// Radix's primitive directly rather than a `ui/dialog` wrapper: this needs an
/// overlay, a title for screen readers, and a close, and none of the header /
/// description / footer slots a general dialog carries.
export default function ImageLightbox({
  images,
  index,
  onIndex,
  onClose,
}: {
  images: LightboxImage[];
  /// `null` is closed.
  index: number | null;
  onIndex: (index: number) => void;
  onClose: () => void;
}) {
  // Held across the close, because Radix keeps `Content` mounted while it fades
  // out and `index` is already `null` by then — without this the picture swaps
  // to the first one on the way out, which is the frame the eye follows.
  const [lastAt, setLastAt] = useState(0);
  // Clamped rather than trusted: the caller opens on a thumbnail's position, and
  // an out-of-range index would render an empty frame with no way to tell it
  // from a failed load.
  const at = index === null ? lastAt : Math.min(index, Math.max(images.length - 1, 0));
  if (index !== null && at !== lastAt) setLastAt(at);

  const current = images[at];
  if (!current) return null;

  const step = (delta: number) => onIndex((at + delta + images.length) % images.length);
  const many = images.length > 1;

  // `Content` covers the viewport, so Radix's own outside-press never fires —
  // every click is inside it. Closing on the target being the element itself is
  // what tells the dark surround from the things drawn on it: a click that
  // reached the picture, a chevron or the filmstrip is reported against *that*,
  // and only one that landed on bare backdrop is reported against the box it
  // fell through to. Two boxes qualify, so both carry this: the padded frame,
  // and the column the picture is centred in — the space beside a portrait
  // screenshot is the most obvious place to click to get out.
  const closeOnBackdrop = (e: MouseEvent<HTMLElement>) => {
    if (e.target === e.currentTarget) onClose();
  };

  return (
    <Dialog.Root open={index !== null} onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/80 data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0" />

        <Dialog.Content
          // Handled here rather than on the window: the dialog holds focus while
          // it is open, so the keys are scoped to it without a listener that has
          // to be told when to stop caring. Escape is Radix's own.
          onKeyDown={(e) => {
            if (!many) return;
            if (e.key === "ArrowLeft") {
              e.preventDefault();
              step(-1);
            } else if (e.key === "ArrowRight") {
              e.preventDefault();
              step(1);
            }
          }}
          onClick={closeOnBackdrop}
          className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-4 p-10 focus:outline-none data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95"
        >
          {/* The filename, which the frame otherwise doesn't say. Visually
              hidden: it is the label a screen reader needs to announce the
              dialog, and on screen the image is its own title. */}
          <Dialog.Title className="sr-only">{current.name}</Dialog.Title>

          {/* The image is capped against *this* box rather than the viewport, so
              the filmstrip below can never be pushed off the bottom — the column
              hands back whatever is left and the percentage applies to that.
              `object-contain` because this is the view where the whole picture
              is the point; cropping is the thumbnail's job. */}
          <div
            onClick={closeOnBackdrop}
            className="flex min-h-0 w-full flex-1 items-center justify-center"
          >
            <img
              src={current.src}
              alt={current.name}
              className="max-h-[80%] max-w-[80%] rounded-lg object-contain"
            />
          </div>

          {many && (
            <>
              {/* Pinned to the viewport edges rather than the image's, which
                  moves with every picture's aspect ratio. */}
              <Button
                type="button"
                variant="secondary"
                size="icon"
                onClick={() => step(-1)}
                aria-label="Previous image"
                className="fixed top-1/2 left-4 -translate-y-1/2"
              >
                <ChevronLeft />
              </Button>

              <Button
                type="button"
                variant="secondary"
                size="icon"
                onClick={() => step(1)}
                aria-label="Next image"
                className="fixed top-1/2 right-4 -translate-y-1/2"
              >
                <ChevronRight />
              </Button>

              <div className="flex shrink-0 flex-col items-center gap-2">
                {/* Jumping straight to a picture, which the arrows can only
                    reach by stepping. It also answers "how many are there and
                    where am I", which nothing else in this view says. */}
                <div className="flex items-center gap-2 rounded-xl bg-black/40 p-2">
                  {images.map((image, i) => (
                    <button
                      key={i}
                      type="button"
                      onClick={() => onIndex(i)}
                      aria-label={`Show image ${i + 1}`}
                      aria-current={i === at}
                      className={cn(
                        "size-12 overflow-hidden rounded-md transition-opacity",
                        // The ring is the current marker. Opacity carries it
                        // too, so it survives for a reader who can't separate
                        // the ring from the picture behind it.
                        i === at
                          ? "opacity-100 ring-2 ring-white"
                          : "opacity-50 hover:opacity-80",
                      )}
                    >
                      <img src={image.src} alt="" className="size-full object-cover" />
                    </button>
                  ))}
                </div>

                {/* A sentence, not a control. Bare caps beside the strip read as
                    two more buttons on a row that is already all buttons; words
                    on either side are what make them a legend. It sits below
                    rather than beside for the same reason — the strip's row is
                    where the clickable things are. */}
                <p className="flex items-center gap-1.5 text-ui text-muted-foreground">
                  Arrow keys
                  <KbdGroup>
                    <Kbd>
                      <ArrowLeft />
                    </Kbd>
                    <Kbd>
                      <ArrowRight />
                    </Kbd>
                  </KbdGroup>
                  to switch
                </p>
              </div>
            </>
          )}

          {/* The key is stated rather than left to be guessed: this dialog
              covers the window, so the way out is the one thing it owes the
              reader. The cap is a label beside the button, not a second
              control. */}
          <div className="fixed top-4 right-4 flex items-center gap-2">
            <Kbd>Esc</Kbd>

            <Dialog.Close asChild>
              <Button type="button" variant="secondary" size="icon-sm" aria-label="Close">
                <X />
              </Button>
            </Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
