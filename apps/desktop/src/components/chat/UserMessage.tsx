import { useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { Image } from "lucide-react";

import ImageLightbox from "@/components/chat/ImageLightbox";
import { basename } from "@/lib/format";
import { SEGMENT_COLOR, highlightSegments, splitMention } from "@/lib/highlight";
import { shortenPath } from "@/lib/tools";
import type { ImageRef } from "@/types/events";

/// How many thumbnails the row draws before it stops counting. Three is what
/// fits beside a bubble without the pictures outweighing the sentence they were
/// sent with; past that the row is a gallery, and a gallery belongs in the
/// viewer.
const MAX_THUMBS = 3;

/// The user's own text, echoed from the event log rather than local state — the
/// backend synthesizes and persists it, so this renders the same live or replayed.
///
/// A slash command and a file mention are coloured and nothing more — same size,
/// same weight, same line. Each stays part of the sentence it sits in, which a
/// chip or a monospace run made them stop being. The segments come from the same
/// function the composer's overlay uses, so a word coloured while typing is
/// still coloured once sent.
///
/// Images sit **outside the bubble**. The bubble is a container for speech, and
/// a picture given a fill and a padding reads as speech with a frame drawn round
/// it; unwrapped, the image is its own edge. They stay inside this component and
/// on its column, so the change is only what the reader sees.
export default function UserMessage({
  text,
  images = [],
}: {
  text: string;
  images?: ImageRef[];
}) {
  const segments = highlightSegments(text);

  // Resolved once here rather than per thumbnail, because the viewer needs the
  // same list in the same order — an index that means one picture in the row and
  // another in the lightbox is the bug this shape rules out.
  const resolved = images.map((image) => ({
    src: image.url ?? (image.path ? convertFileSrc(image.path) : null),
    name: image.path ? basename(image.path) : "image",
    path: image.path,
  }));

  const viewable = resolved.filter((r): r is typeof r & { src: string } => r.src !== null);
  const missing = resolved.filter((r) => r.src === null);

  // `null` is closed. The index is the viewer's whole state, so opening at a
  // given picture and stepping to the next are the same operation.
  const [openIndex, setOpenIndex] = useState<number | null>(null);

  const shown = viewable.slice(0, MAX_THUMBS);
  const hidden = viewable.length - shown.length;

  return (
    <div className="flex flex-col items-end gap-1.5">
      {/* A row that wraps, not a stack. Two screenshots are usually two views of
          one thing and read as a set; stacked, each pushes the next off the
          screen and the message becomes a scroll. `justify-end` so the row grows
          leftwards from the same edge the bubble sits on.

          Above the text, matching the composer's own tray — what was attached is
          read before the sentence written about it, on the way in and on the way
          back out. */}
      {viewable.length > 0 && (
        <div className="flex max-w-[85%] flex-wrap justify-end gap-1.5">
          {shown.map((image, i) => (
            <SentThumb key={i} src={image.src} onOpen={() => setOpenIndex(i)} />
          ))}

          {/* Opens on the first picture it is standing in for, not on the first
              in the set — the reader clicked it to see what they hadn't seen. */}
          {hidden > 0 && (
            <button
              type="button"
              onClick={() => setOpenIndex(MAX_THUMBS)}
              aria-label={`Show ${hidden} more image${hidden > 1 ? "s" : ""}`}
              className="size-20 rounded-md bg-card text-chat text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              +{hidden}
            </button>
          )}
        </div>
      )}

      {text && (
        <div className="max-w-[85%] rounded-xl bg-card px-3 py-2 text-card-foreground">
          <span className="text-chat whitespace-pre-wrap">
            {/* Plain runs concatenate back to `text` exactly, so the spacing the
                user typed survives — nothing here is rebuilt from a parse.
                A mention is the one run drawn shorter than it was sent: the
                directory is dropped and kept on the tooltip, since a deep path
                is most of a line and says little the filename doesn't. The
                composer can't do this — see `splitMention`. */}
            {segments.map((segment, i) => {
              if (segment.kind === "mention") {
                const { name } = splitMention(segment.text);

                return (
                  <span key={i} className={SEGMENT_COLOR.mention} title={segment.text.slice(1)}>
                    @{name}
                  </span>
                );
              }

              return (
                <span key={i} className={SEGMENT_COLOR[segment.kind]}>
                  {segment.text}
                </span>
              );
            })}
          </span>
        </div>
      )}

      {/* An image whose file is gone. Named rather than drawn as a broken frame,
          which says nothing about what was sent. */}
      {missing.map((image, i) => (
        <span key={i} className="flex items-center gap-1.5 text-chat text-muted-foreground">
          <Image className="size-3.5 shrink-0" />
          <span className="truncate">{image.path ? shortenPath(image.path) : "image"}</span>
        </span>
      ))}

      <ImageLightbox
        images={viewable}
        index={openIndex}
        onIndex={setOpenIndex}
        onClose={() => setOpenIndex(null)}
      />
    </div>
  );
}

/// One image the user sent, loaded from the copy the backend archived under
/// `~/.dray/attachments` rather than from wherever it was attached — a
/// screenshot dragged in from `~/Downloads` and deleted an hour later still
/// draws. Bytes live there rather than on the event: the session log is
/// append-only and read whole on open, so a megabyte per image would be paid
/// again on every visit.
function SentThumb({ src, onOpen }: { src: string; onOpen: () => void }) {
  return (
    // Square, so a row of mixed aspect ratios is a grid rather than a ragged
    // strip. `object-cover` crops to hold that; the whole picture is one click
    // away and that view contains it.
    //
    // 80px against the composer tray's 56px. Bigger than a tray tile because the
    // transcript is where a picture has to be recognized rather than merely
    // counted, and small enough that it still reads as a receipt for something
    // the reader sent — at any size worth studying it outweighs the sentence it
    // was sent with, which is what the lightbox is for.
    <button type="button" onClick={onOpen} className="cursor-zoom-in">
      <img
        src={src}
        alt=""
        className="size-20 rounded-md object-cover transition-opacity hover:opacity-90"
      />
    </button>
  );
}
