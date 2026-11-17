import { useState } from "react";

import ImageLightbox, { Thumb, type LightboxImage } from "@/components/chat/ImageLightbox";
import { Button } from "@/components/ui/button";
import { basename } from "@/lib/format";
import { allMedia, loadOlderMedia, olderCursor, type HeldLog, type OlderMedia } from "@/lib/olderMedia";
import { fileSrc, invoke, qualify, serverOfSession } from "@/lib/transport";
import { cn } from "@/lib/utils";
import type { SessionPage } from "@/types/events";

/// What one Load more press goes looking for: a row and a half of the grid.
const LOAD_MORE = 9;

type MediaFilter = "all" | "you" | "ai";
const MEDIA_FILTERS: { id: MediaFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "you", label: "You" },
  { id: "ai", label: "AI" },
];

/// A contact sheet of every picture and recording in `logs`, each opening the
/// transcript's own viewer to step through the set, with Load more reading
/// further back than the transcript holds. Uncapped: a grid that can grow by
/// a button has no business hiding rows behind a count.
///
/// `logs` is newest first and is more than one only for a bot's chat, which
/// an agent switch splits into several sessions read as one conversation.
export default function AttachmentGrid({ logs }: { logs: HeldLog[] }) {
  // The open picture by its source, not its position: the list is newest first,
  // so a screenshot landing while the viewer is open would shift every index.
  const [openSrc, setOpenSrc] = useState<string | null>(null);
  const [filter, setFilter] = useState<MediaFilter>("all");
  // Per session, since the pane stays mounted across a session switch.
  const [older, setOlder] = useState<Record<string, OlderMedia>>({});
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);

  // Outside `ChatSessionContext`, so the session's server is named here rather
  // than through `useSessionPath`.
  const server = serverOfSession(logs[0]?.sessionId ?? "");
  const media = allMedia(logs, older);
  const items = media
    .filter((m) => filter === "all" || m.byYou === (filter === "you"))
    .map((m) =>
      "video" in m
        ? { src: fileSrc(qualify(m.video, server)), name: basename(m.video), video: true }
        : {
            src: m.image.path ? fileSrc(qualify(m.image.path, server)) : m.image.url,
            name: m.image.path ? basename(m.image.path) : "image",
          },
    )
    .filter((item): item is LightboxImage => Boolean(item.src));
  const at = items.findIndex((item) => item.src === openSrc);
  const hasMore = logs.some((log) => olderCursor(log, older[log.sessionId]) != null);

  const loadMore = async () => {
    setLoading(true);
    setFailed(false);
    try {
      const page = (sessionId: string, before: number) =>
        invoke<SessionPage>("get_session_page", { sessionId, before, turns: 16 });
      setOlder(await loadOlderMedia(logs, older, page, LOAD_MORE));
    } catch (e) {
      console.error("failed to load older attachments", e);
      setFailed(true);
    } finally {
      setLoading(false);
    }
  };

  // Empty cells finish the last row, so the lines run the whole width rather
  // than stopping where the pictures do.
  const filler = (6 - (items.length % 6)) % 6;
  const cell = "aspect-square border-b-[0.5px] border-border [&:not(:nth-child(6n))]:border-r-[0.5px]";

  return (
    <div className="flex shrink-0 flex-col gap-2 pt-3 pb-3">
      {/* No filters over nothing at all: they would sort an empty set. */}
      {media.length > 0 && (
        <div role="group" aria-label="Show attachments from" className="flex gap-3 px-3">
          {MEDIA_FILTERS.map(({ id, label }) => (
            <button
              key={id}
              type="button"
              aria-pressed={filter === id}
              onClick={() => {
                setFilter(id);
                setOpenSrc(null);
              }}
              className={cn(
                "text-ui transition-colors",
                filter === id ? "text-foreground" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {label}
            </button>
          ))}
        </div>
      )}
      {items.length === 0 ? (
        <p className="px-3 py-2 text-ui text-muted-foreground">
          {media.length > 0 ? "Nothing here." : hasMore ? "No attachments in recent messages." : "No attachments yet."}
        </p>
      ) : (
        // Edge to edge, with the panel's own sides as the outer frame.
        <div className="grid grid-cols-6 border-t-[0.5px] border-border">
          {items.map((item) => (
            <button
              key={item.src}
              type="button"
              onClick={() => setOpenSrc(item.src)}
              aria-label={item.video ? `Play ${item.name}` : `Open ${item.name}`}
              // A wash laid over the picture rather than a fill behind it,
              // which the picture would cover.
              className={cn(
                cell,
                "relative cursor-default overflow-hidden after:absolute after:inset-0 after:transition-colors hover:after:bg-foreground/10",
              )}
            >
              <Thumb item={item} className="size-full" />
            </button>
          ))}
          {Array.from({ length: filler }, (_, i) => (
            <div key={`filler-${i}`} className={cell} />
          ))}
        </div>
      )}
      {hasMore && (
        <div className="px-3">
          <Button variant="secondary" size="xs" onClick={() => void loadMore()} disabled={loading}>
            {loading ? "Loading…" : failed ? "Couldn't load. Try again" : "Load more"}
          </Button>
        </div>
      )}
      <ImageLightbox
        images={items}
        index={at === -1 ? null : at}
        onIndex={(i) => setOpenSrc(items[i].src)}
        onClose={() => setOpenSrc(null)}
      />
    </div>
  );
}
