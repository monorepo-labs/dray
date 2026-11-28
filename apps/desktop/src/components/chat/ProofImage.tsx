import { useState, type ReactNode } from "react";

import { GalleryPicture, useInImageRow, useMessageMedia } from "@/components/chat/ImageGallery";
import ImageLightbox from "@/components/chat/ImageLightbox";
import { basename } from "@/lib/format";
import { fileSrc, invoke } from "@/lib/transport";
import type { FileBody } from "@/types/events";

/// What the `read_file` fallback found for one path: `null` while it reads.
type Read = { path: string; src: string | null; failed: boolean };

/// An image file the agent named in its reply — a screenshot path or a markdown
/// image — drawn where it is named and opened full size on click. Phrasing
/// content, since it sits inside the paragraph that names it.
///
/// `path` is qualified for the session's server. It loads through `fileSrc`
/// first, which serves attachments and recordings alone, then through
/// `read_file`'s `data:` URL, the Files view's own route to any other file.
///
/// Inside a `MessageMedia` it opens the message's viewer, and inside an
/// `ImageGallery` it is one tile of the row.
export default function ProofImage({
  path,
  alt = "",
  fallback = null,
}: {
  path: string;
  alt?: string;
  /// Drawn where neither route finds a picture.
  fallback?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [read, setRead] = useState<Read | null>(null);
  const reading = read?.path === path ? read : null;

  const src = reading?.failed ? null : reading ? reading.src : fileSrc(path);
  const slot = useMessageMedia(src ? { src, name: basename(path) } : null);
  const inRow = useInImageRow();

  if (reading?.failed) return <>{fallback}</>;
  if (!src) return null;

  const settle = (next: Read) => setRead((cur) => (cur?.path === path ? next : cur));
  const onError = () => {
    if (reading) return settle({ path, src: null, failed: true });
    setRead({ path, src: null, failed: false });
    invoke<FileBody>("read_file", { path }).then(
      (body) =>
        settle(
          body.kind === "image"
            ? { path, src: body.dataUrl, failed: false }
            : { path, src: null, failed: true },
        ),
      () => settle({ path, src: null, failed: true }),
    );
  };

  if (slot && inRow) {
    return <GalleryPicture src={src} alt={alt} slot={slot} onError={onError} />;
  }

  return (
    <>
      {/* A button so focus has somewhere to come back to when the viewer closes. */}
      <button
        ref={slot?.ref}
        type="button"
        onClick={(e) => (slot ? slot.open(e.currentTarget) : setOpen(true))}
        className="mt-1.5 block w-fit max-w-full cursor-zoom-in overflow-hidden rounded-xl border border-border"
      >
        <img
          src={src}
          alt={alt}
          loading="lazy"
          decoding="async"
          onError={onError}
          className="block max-h-72 max-w-full"
        />
      </button>
      {/* Outside the button, since a click in the portal bubbles to it. */}
      {!slot && (
        <ImageLightbox
          images={[{ src, name: basename(path) }]}
          index={open ? 0 : null}
          onIndex={() => {}}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
