import { Image } from "lucide-react";

import ImageRow from "@/components/chat/ImageRow";
import { SEGMENT_COLOR, highlightSegments, splitMention } from "@/lib/highlight";
import { shortenPath } from "@/lib/tools";
import type { ImageRef } from "@/types/events";

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

  // An image with neither an archived copy nor bytes of its own — the file was
  // cleared out from under a transcript that still names it. `ImageRow` drops
  // those, so this row is what is left to say about them.
  const missing = images.filter((image) => !image.path && !image.url);

  return (
    <div className="flex flex-col items-end gap-1.5">
      {/* Above the text, matching the composer's own tray — what was attached is
          read before the sentence written about it, on the way in and on the way
          back out. `end` so the row grows leftwards from the same edge the
          bubble sits on. */}
      <ImageRow images={images} variant="sent" align="end" />

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

    </div>
  );
}
