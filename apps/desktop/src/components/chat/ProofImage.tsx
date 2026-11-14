import { useState } from "react";

import ImageLightbox from "@/components/chat/ImageLightbox";
import { basename } from "@/lib/format";

/// A screenshot the agent named in its reply, drawn under the path the way a
/// recording plays there, and opened full size on click. A span, since it sits
/// inside the paragraph that names the path.
export default function ProofImage({ src, path }: { src: string; path: string }) {
  const [open, setOpen] = useState(false);
  // A path holding no picture draws nothing rather than a broken frame.
  const [failed, setFailed] = useState<string | null>(null);
  if (failed === src) return null;
  return (
    <span className="mt-1.5 block w-fit max-w-full overflow-hidden rounded-xl border border-border">
      <img
        src={src}
        alt=""
        loading="lazy"
        decoding="async"
        onClick={() => setOpen(true)}
        onError={() => setFailed(src)}
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
