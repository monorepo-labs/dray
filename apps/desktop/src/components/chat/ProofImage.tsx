import { useState, type ReactNode } from "react";

import ImageLightbox from "@/components/chat/ImageLightbox";
import { basename } from "@/lib/format";
import { fileSrc, invoke } from "@/lib/transport";
import type { FileBody } from "@/types/events";

/// What the `read_file` fallback found for one path: `null` while it reads.
type Read = { path: string; src: string | null; failed: boolean };

/// An image file the agent named in its reply — a screenshot path or a markdown
/// image — drawn where it is named and opened full size on click. A span, since
/// it sits inside the paragraph that names it.
///
/// `path` is qualified for the session's server. It loads through `fileSrc`
/// first, which serves attachments and recordings alone, then through
/// `read_file`'s `data:` URL, the Files view's own route to any other file.
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

  if (reading?.failed) return <>{fallback}</>;
  const src = reading ? reading.src : fileSrc(path);
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

  return (
    <span className="mt-1.5 block w-fit max-w-full overflow-hidden rounded-xl border border-border">
      <img
        src={src}
        alt={alt}
        loading="lazy"
        decoding="async"
        onClick={() => setOpen(true)}
        onError={onError}
        className="block max-h-96 max-w-full cursor-zoom-in"
      />
      <ImageLightbox
        images={[{ src, name: basename(path) }]}
        index={open ? 0 : null}
        onIndex={() => {}}
        onClose={() => setOpen(false)}
      />
    </span>
  );
}
