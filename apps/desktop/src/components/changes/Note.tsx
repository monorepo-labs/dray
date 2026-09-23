import { cn } from "@/lib/utils";
import type { Unreadable } from "@/types/events";

/// One line standing where a diff or a file would be: loading, an error, or why
/// there is nothing to draw.
export default function Note({
  text,
  error = false,
  className,
}: {
  text: string;
  error?: boolean;
  className?: string;
}) {
  return (
    <p
      className={cn(
        "px-3 py-2 text-ui",
        error ? "text-destructive" : "text-muted-foreground",
        className,
      )}
    >
      {text}
    </p>
  );
}

/// Deliberately "not UTF-8" rather than "binary": git's own binary test is
/// NUL-based, so a Latin-1 or UTF-16 file passes it and the row above shows real
/// line counts. Calling that binary contradicts the numbers next to it.
export function unreadableText(why: Unreadable): string {
  return why === "binary" ? "Not UTF-8 text — no diff to show." : "File is too large to diff here.";
}
