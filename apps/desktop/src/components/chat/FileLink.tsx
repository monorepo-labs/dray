import type { ReactNode, SyntheticEvent } from "react";

import { openPath } from "@/hooks/useDocs";
import { cn } from "@/lib/utils";

/// A path anywhere in the chat, drawn as something that opens.
///
/// A span with `role="link"` rather than a button or an anchor, because one of
/// the three callers puts this *inside* the tool row's own expand button —
/// nesting a second interactive element there would be invalid markup and the
/// click would toggle the row instead of opening anything. `stopPropagation` is
/// what keeps the two apart, and it has to happen on the key as well as on the
/// click.
///
/// Underlined on hover rather than at rest, matching the issue tag beside it: a
/// permanent underline through a sentence reads as a correction, and in an
/// agent's prose it would mark up every path it mentions.
///
/// `writtenAsLink` is the exception, and it is not a style choice — the author
/// spelled that one `[Footer.js](/Users/me/Footer.js)`, so it has to read as the
/// link they wrote and sit beside the message's other links without looking
/// half-converted.
export default function FileLink({
  path,
  title,
  writtenAsLink = false,
  className,
  children,
}: {
  /// Absolute, and already resolved. This draws whatever it is given and asks
  /// nothing about whether the file is there, since `openFile` reveals as its
  /// fallback and revealing something gone is a click that does nothing.
  path: string;
  title?: string;
  /// This was a markdown link before it was a file link, so draw it as one.
  writtenAsLink?: boolean;
  className?: string;
  children?: ReactNode;
}) {
  const open = (e: SyntheticEvent) => {
    e.stopPropagation();
    // Markdown opens in the Docs panel and everything else in the reader's
    // editor. A file this app can already render is not one to leave Dray for.
    openPath(path);
  };

  return (
    <span
      role="link"
      tabIndex={0}
      title={title ?? path}
      onClick={open}
      onKeyDown={(e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
        open(e);
      }}
      className={cn(
        "cursor-pointer",
        writtenAsLink
          ? // Streamdown's own anchor classes, copied because there is no way to
            // reach its link renderer from here — and looking like the links
            // either side of it is the whole point of this branch.
            "wrap-anywhere font-medium text-primary underline"
          : "underline decoration-transparent underline-offset-2 transition-colors hover:decoration-current",
        className,
      )}
    >
      {children ?? path}
    </span>
  );
}
