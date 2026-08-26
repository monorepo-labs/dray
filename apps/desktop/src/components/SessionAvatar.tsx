import { Blobatar } from "@blobatar/react";
import { useState } from "react";

import { cn } from "@/lib/utils";

/// A session's own mark, drawn from its id.
///
/// Deliberately not [Avatar] with a blobatar behind it. That component draws a
/// **person** — a GitHub or Gravatar picture with their initial standing in
/// until it loads — and a generated shape there would read as a face someone
/// chose. A session is not an account and has never had a picture, so it is the
/// one place a generated mark says something true.
///
/// Seeded on the id, not on the title: the app writes titles itself and rewrites
/// them, and a mark that changes when a session is retitled is not a mark.
export default function SessionAvatar({
  sessionId,
  name,
  className,
}: {
  sessionId: string;
  /// Only the initial is read off this — see the seeding note above.
  name: string;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);

  // The figure alone, on no plate. Its own backdrop is a near-white disc that
  // stays near-white in dark mode, which put the brightest thing on the row
  // beside the quietest line of text on it.
  //
  // A rung larger than the box [Avatar] draws in, and that is not a bigger mark:
  // the figure only reaches ~70% of its viewBox, so at `size-4` it reads lighter
  // than the 13px title beside it and its own slack reads as gap.
  if (!failed)
    return (
      <Blobatar
        name={sessionId}
        aria-hidden
        onError={() => setFailed(true)}
        className={cn("size-5 shrink-0", className)}
      />
    );

  // Swapped rather than layered the way [Avatar] does it: the blobatar is a
  // `data:` URI built here, so there is no load to cover — the initial is the
  // answer for one that cannot draw at all, not a resting state.
  return (
    <span
      aria-hidden
      className={cn(
        "flex size-5 shrink-0 items-center justify-center overflow-hidden rounded-full bg-muted text-[10px] uppercase text-muted-foreground",
        className,
      )}
    >
      {name.slice(0, 1)}
    </span>
  );
}
