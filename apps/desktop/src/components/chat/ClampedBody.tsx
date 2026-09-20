import { type ReactNode, useLayoutEffect, useRef, useState } from "react";

import { cn } from "@/lib/utils";

/// A user bubble's text, stopped at twenty lines with a "Show more" under it.
///
/// A pasted wall — a stack trace, a whole file — otherwise fills the transcript
/// and buries the answer it asked for. Twenty is long enough that a typed
/// prompt is never collapsed and only a paste is. Nothing is truncated: the
/// reader's own words stay reachable, a prompt being the one thing in the
/// transcript they wrote.
///
/// Shared by the delivered bubble and the queued one, which is not tidiness: a
/// held prompt is drawn by `QueuedMessages` and the same words by `UserMessage`
/// seconds later, so a clamp on one alone means a paste fills the transcript
/// for the whole queued period and then abruptly becomes collapsible on
/// delivery — the same message bounded two ways.
///
/// The button sits *inside* the bubble, where it stays attached to the text it
/// opens; under it, it was a loose word on the transcript's own background with
/// nothing saying which message it belonged to. Muted and at the interface size
/// rather than the chat one, which is what keeps it from reading as a last line
/// the reader wrote.
export default function ClampedBody({
  className,
  children,
}: {
  /// The span's own type styling. The break rule is this component's, since it
  /// is what the clamp is measured against.
  className?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const body = useRef<HTMLSpanElement>(null);
  const [clipped, setClipped] = useState(false);

  // Measured rather than counted off the string: whether twenty lines hold a
  // prompt depends on how wide the column is, and a "Show more" expanding to
  // the same twenty lines is a control that does nothing. Read only while
  // collapsed — expanded, the element is its own full height and reports no
  // overflow, which would retire the button that collapses it again.
  useLayoutEffect(() => {
    const el = body.current;
    if (!el || open) return;

    const measure = () => setClipped(el.scrollHeight > el.clientHeight + 1);
    measure();

    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [open]);

  return (
    <>
      <span
        ref={body}
        className={cn("whitespace-pre-wrap wrap-anywhere", className, !open && "line-clamp-20")}
        // A file link or an issue tag clipped past the twentieth line is hidden
        // but still in the tab order, so tabbing reaches a control nobody can
        // see. Opening on focus is the cure that costs no accessibility:
        // `inert` would take the visible text off the accessibility tree along
        // with the hidden run, which is worse than the stray focus stop. Focus
        // bubbles, so this catches a control at any depth.
        onFocus={() => setOpen(true)}
      >
        {children}
      </span>

      {/* Drawn while open too, or the bubble opens with no way back. */}
      {(clipped || open) && (
        <button
          type="button"
          onClick={() => setOpen((prev) => !prev)}
          className="mt-1 block cursor-pointer text-ui text-muted-foreground transition-colors hover:text-foreground"
        >
          {open ? "Show less" : "Show more"}
        </button>
      )}
    </>
  );
}
