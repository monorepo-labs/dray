import type { ReactElement } from "react";

import type { Segment } from "@/lib/highlight";
import { openLink } from "@/lib/openLink";
import { cn } from "@/lib/utils";

/// The inline marks a prompt bubble draws, or `null` for a segment that is not
/// one.
///
/// Shared by the delivered bubble and the queued one, which the composer's own
/// note already names the reason for: a queued prompt is the same message a
/// moment early, so a run drawn bold once sent and literal while it waits reads
/// as the app changing what the reader wrote.
///
/// The delimiters are dropped here and nowhere else. `Segment.text` keeps them,
/// which is what lets the composer's overlay paint the same segments over a
/// textarea that still lays every one of them out.
export function inlineMark(segment: Segment, key: number): ReactElement | null {
  const inner = segment.inner ?? "";

  switch (segment.kind) {
    case "strong":
      return (
        <strong key={key} className="font-semibold">
          {inner}
        </strong>
      );

    case "em":
      return (
        <em key={key} className="italic">
          {inner}
        </em>
      );

    case "strike":
      // `opacity` rather than a muted colour: struck text sits inside a
      // sentence that keeps its own, and recolouring it would read as a second
      // kind of run rather than as the same words withdrawn.
      return (
        <s key={key} className="opacity-60">
          {inner}
        </s>
      );

    case "code":
      // Sized off `text-code` like every other code run in the app, with the
      // fill carrying the edge — a border on an inline run sets its own line
      // height and pushes the sentence's lines apart.
      return (
        <code key={key} className="rounded bg-muted/60 px-1 py-0.5 font-mono text-code">
          {inner}
        </code>
      );

    case "link":
      // The same route a bare URL in the bubble takes, so both ask where to
      // open before leaving the app.
      return (
        <button
          key={key}
          type="button"
          title={segment.href}
          className={cn(
            "cursor-pointer underline decoration-muted-foreground underline-offset-2",
            "hover:decoration-foreground",
          )}
          onClick={(e) => segment.href && openLink(segment.href, e)}
        >
          {inner}
        </button>
      );

    default:
      return null;
  }
}
