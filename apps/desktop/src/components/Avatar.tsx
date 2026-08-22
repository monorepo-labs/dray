import { useState } from "react";

import { cn } from "@/lib/utils";

/// Someone's picture, falling back to their initial.
///
/// The image is remote and the account may have none, so the letter is the
/// resting state and the image covers it once it loads — that way a slow or
/// missing avatar never leaves a hole where a row's left edge should be.
///
/// Shared by the PR panel and the commit history: both draw a person beside a
/// line of theirs, and two copies would drift on the fallback, which is the
/// part that actually gets seen.
export default function Avatar({
  src,
  name,
  className,
}: {
  src: string | null;
  name: string;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);

  return (
    <span
      aria-hidden
      className={cn(
        "relative flex size-4 shrink-0 items-center justify-center overflow-hidden rounded-full bg-muted text-[9px] uppercase text-muted-foreground",
        className,
      )}
    >
      {name.slice(0, 1)}
      {src && !failed && (
        <img
          src={src}
          alt=""
          loading="lazy"
          onError={() => setFailed(true)}
          className="absolute inset-0 size-full object-cover"
        />
      )}
    </span>
  );
}
