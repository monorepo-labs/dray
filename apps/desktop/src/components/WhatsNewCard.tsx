import { SparklesIcon } from "@heroicons/react/16/solid";

import { Button } from "@/components/ui/button";
import type { Release } from "@/lib/changelog";

/// How many items the card names before "+N more" takes over.
const SHOWN = 3;

/// Markdown marks dropped, for a line too small to carry them.
const plain = (text: string) =>
  text.replace(/\*\*|`/g, "").replace(/\[([^\]]+)\]\([^)\s]+\)/g, "$1");

/// The release a reader just updated to, waiting in the corner until they
/// dismiss it or open the changelog. No timer: the notice stack's cards run
/// out in seconds, and a release flagged `notify` is worth more than that.
///
/// Titles only — the changelog is one click away — under the release's first
/// image or video, since the media is what a release flags itself to show off.
export default function WhatsNewCard({
  release,
  onDismiss,
  onView,
}: {
  release: Release;
  onDismiss: () => void;
  onView: () => void;
}) {
  const items = release.sections.flatMap((s) => s.items);
  if (items.length === 0) return null;
  const media = items.find((i) => i.media.length > 0)?.media[0];
  const more = items.length - SHOWN;

  return (
    <div
      role="region"
      aria-label="What's new"
      className="fixed bottom-3 left-3 z-50 flex w-64 flex-col overflow-hidden rounded-lg bg-popover text-popover-foreground shadow-(--shadow-ring) backdrop-blur-xl animate-in fade-in slide-in-from-bottom-2"
    >
      {media && (
        // Inset from the card's edge; 4px corners sit concentric with its 8px
        // at this padding, near enough.
        <div className="px-1.5 pt-1.5">
          {media.kind === "video" ? (
            <video
              src={media.url}
              aria-label={media.alt || undefined}
              autoPlay
              muted
              loop
              playsInline
              className="aspect-video w-full rounded-sm object-cover"
            />
          ) : (
            <img src={media.url} alt={media.alt} className="aspect-video w-full rounded-sm object-cover" />
          )}
        </div>
      )}
      <div className="flex flex-col gap-1.5 px-3 pt-2.5">
        <span className="mb-1 flex items-center gap-1.5 text-ui font-medium text-foreground">
          <SparklesIcon className="size-3.5 text-accent-add" aria-hidden />
          What's new in Dray {release.version}
        </span>
        <ul className="flex flex-col gap-1 text-ui">
          {items.slice(0, SHOWN).map((item, i) => (
            <li key={i} className="flex gap-2">
              <span aria-hidden className="flex h-[1lh] shrink-0 items-center">
                <span className="size-[5px] rounded-full bg-muted-foreground/60" />
              </span>
              <span className="min-w-0 truncate">{plain(item.title ?? item.body)}</span>
            </li>
          ))}
        </ul>
        {more > 0 && (
          <span className="text-xs text-muted-foreground">
            +{more} more {more === 1 ? "change" : "changes"}
          </span>
        )}
      </div>
      <div className="grid grid-cols-2 gap-1.5 p-2.5">
        <Button variant="ghost" size="sm" onClick={onDismiss}>
          Dismiss
        </Button>
        <Button size="sm" onClick={onView}>
          View all
        </Button>
      </div>
    </div>
  );
}
