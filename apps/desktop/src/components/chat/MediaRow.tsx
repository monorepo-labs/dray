import { useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";

import ImageLightbox, { Thumb, type LightboxImage } from "@/components/chat/ImageLightbox";
import ImageRow from "@/components/chat/ImageRow";
import VideoPlayer from "@/components/chat/VideoPlayer";
import { basename } from "@/lib/format";
import type { Media } from "@/lib/transcript";

/// Tiles drawn before the rest fold into a count — the user bubble's number.
const MAX_SHOWN = 3;

/// What a collapsed stretch of work took: pictures and recordings, lifted out
/// from behind its summary line.
///
/// One thing draws the way its own row would — a screenshot wide, a recording
/// playing in place. Two or more become square tiles opening the viewer, since
/// a stretch can hold a dozen screenshots and a dozen at reading size is a
/// scroll standing in for one line.
export default function MediaRow({ media }: { media: Media[] }) {
  const [openIndex, setOpenIndex] = useState<number | null>(null);

  if (media.length === 1) {
    const [only] = media;
    return "image" in only ? (
      <ImageRow images={[only.image]} />
    ) : (
      <VideoPlayer src={convertFileSrc(only.video)} />
    );
  }

  const items = media
    .map((m) =>
      "video" in m
        ? { src: convertFileSrc(m.video), name: basename(m.video), video: true }
        : { src: m.image.path ? convertFileSrc(m.image.path) : m.image.url, name: m.image.path ? basename(m.image.path) : "image" },
    )
    .filter((item): item is LightboxImage => Boolean(item.src));
  if (items.length === 0) return null;

  const hidden = items.length - MAX_SHOWN;

  return (
    <div className="flex max-w-full flex-wrap gap-1.5">
      {items.slice(0, MAX_SHOWN).map((item, i) => (
        <button
          key={i}
          type="button"
          onClick={() => setOpenIndex(i)}
          aria-label={item.video ? `Play ${item.name}` : `Open ${item.name}`}
          className="size-20 cursor-zoom-in overflow-hidden rounded-md border border-border transition-opacity hover:opacity-90"
        >
          <Thumb item={item} className="size-full" />
        </button>
      ))}

      {hidden > 0 && (
        <button
          type="button"
          onClick={() => setOpenIndex(MAX_SHOWN)}
          aria-label={`Show ${hidden} more`}
          className="size-20 rounded-md bg-card text-chat text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          +{hidden}
        </button>
      )}

      <ImageLightbox
        images={items}
        index={openIndex}
        onIndex={setOpenIndex}
        onClose={() => setOpenIndex(null)}
      />
    </div>
  );
}
