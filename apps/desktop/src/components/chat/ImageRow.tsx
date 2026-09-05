import { useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";

import ImageLightbox from "@/components/chat/ImageLightbox";
import { basename } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { ImageRef } from "@/types/events";

/// How many pictures the row draws before it stops counting. Three is what fits
/// beside a bubble without the pictures outweighing the sentence they were sent
/// with; past that the row is a gallery, and a gallery belongs in the viewer.
const MAX_SHOWN = 3;

/// Two presentations, and which one is right turns on whether the reader has
/// already seen the picture.
///
/// `sent` is a **receipt**: the reader picked these seconds ago and knows what is
/// in them, so a square crop that says "this went with the message" is the whole
/// job, and anything larger outweighs the sentence it was attached to.
///
/// `returned` is the opposite — a screenshot the agent took and read is one the
/// reader has *not* seen, and a cropped 80px square of it says nothing. So it is
/// drawn at its own aspect ratio and tall enough to read: cropping a screenshot
/// throws away the part that was worth looking at, and which part that is cannot
/// be guessed.
type Variant = "sent" | "returned";

/// A row of pictures with the viewer wired to it.
///
/// Shared rather than written twice: the two callers differ in the variant above
/// and the edge the row grows from, and the parts that are easy to get wrong —
/// the index meaning the same picture in the row and in the lightbox, the
/// overflow control opening on the first picture it stands for — are the parts a
/// second copy would drift on.
///
/// An image resolves through its `path` — the copy the backend archived under
/// `~/.dray/attachments`, so a screenshot taken in `/tmp` and swept away still
/// draws — and falls back to the `url` an unarchived one carries. One that
/// resolves to neither is dropped here; a caller that can say something useful
/// about a missing picture says it itself.
export default function ImageRow({
  images,
  variant = "returned",
  align = "start",
}: {
  images: ImageRef[];
  variant?: Variant;
  align?: "start" | "end";
}) {
  // Resolved once here rather than per picture, because the viewer needs the
  // same list in the same order — an index that means one picture in the row and
  // another in the lightbox is the bug this shape rules out.
  const viewable = images
    .map((image) => ({
      src: image.path ? convertFileSrc(image.path) : image.url,
      name: image.path ? basename(image.path) : "image",
    }))
    .filter((image): image is { src: string; name: string } => Boolean(image.src));

  // `null` is closed. The index is the viewer's whole state, so opening at a
  // given picture and stepping to the next are the same operation.
  const [openIndex, setOpenIndex] = useState<number | null>(null);

  if (viewable.length === 0) return null;

  const shown = viewable.slice(0, MAX_SHOWN);
  const hidden = viewable.length - shown.length;
  const sent = variant === "sent";

  return (
    <div
      className={cn(
        "flex max-w-full flex-col gap-1.5",
        align === "end" ? "items-end" : "items-start",
      )}
    >
      {/* A row that wraps, not a stack. Two screenshots are usually two views of
          one thing and read as a set; stacked, each pushes the next off the
          screen and the message becomes a scroll. */}
      <div
        className={cn(
          "flex max-w-full flex-wrap gap-1.5",
          align === "end" ? "justify-end" : "justify-start",
        )}
      >
        {shown.map((image, i) => (
          <button
            key={i}
            type="button"
            onClick={() => setOpenIndex(i)}
            className="min-w-0 cursor-zoom-in"
          >
            {/* Lazy, or every screenshot in the transcript decodes on mount at
                full resolution — 10–20MB each as a bitmap, kept by WebKit's
                image cache until memory pressure — for a row drawn 320px tall.
                Switching between two screenshot-heavy sessions was measured at
                ~800MB in 90s; only what nears the viewport should decode. */}
            <img
              src={image.src}
              alt=""
              loading="lazy"
              decoding="async"
              className={cn(
                "rounded-md transition-opacity hover:opacity-90",
                sent
                  // Square, so a row of mixed aspect ratios is a grid rather
                  // than a ragged strip. `object-cover` crops to hold that; the
                  // whole picture is one click away and that view contains it.
                  ? "size-20 object-cover"
                  // Capped on both axes and cropped on neither: with both
                  // dimensions left `auto`, the caps scale the picture rather
                  // than trim it, so a wide screenshot and a tall one each land
                  // at a size worth reading and neither sets the column's width.
                  // The border is the only thing separating a pale screenshot
                  // from the page behind it.
                  : "max-h-80 max-w-full border border-border",
              )}
            />
          </button>
        ))}

        {/* Sized like the pictures it stands among, but only in the variant
            where they have a size. */}
        {hidden > 0 && sent && (
          <button
            type="button"
            onClick={() => setOpenIndex(MAX_SHOWN)}
            aria-label={`Show ${hidden} more image${hidden > 1 ? "s" : ""}`}
            className="size-20 rounded-md bg-card text-chat text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            +{hidden}
          </button>
        )}
      </div>

      {/* A tile has no size to match in this variant — the pictures beside it are
          each a different shape — so the overflow is a line of text under the row
          instead. Opens on the first picture it stands for, not on the first in
          the set: the reader clicked it to see what they hadn't seen. */}
      {hidden > 0 && !sent && (
        <button
          type="button"
          onClick={() => setOpenIndex(MAX_SHOWN)}
          className="text-chat text-muted-foreground transition-colors hover:text-foreground"
        >
          +{hidden} more image{hidden > 1 ? "s" : ""}
        </button>
      )}

      <ImageLightbox
        images={viewable}
        index={openIndex}
        onIndex={setOpenIndex}
        onClose={() => setOpenIndex(null)}
      />
    </div>
  );
}
