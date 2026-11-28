import { useState } from "react";
import { Plus } from "lucide-react";

import ImageLightbox, { Thumb, type LightboxImage } from "@/components/chat/ImageLightbox";
import Spinner from "@/components/ui/spinner";
import { basename, relativeTime } from "@/lib/format";
import { allMedia, loadOlderMedia, olderCursor, type HeldLog, type OlderMedia } from "@/lib/olderMedia";
import { fileSrc, invoke, qualify, serverOfSession } from "@/lib/transport";
import { cn } from "@/lib/utils";
import type { SessionPage } from "@/types/events";

/// How many the list opens on, and how many each Load more adds.
const LOAD_MORE = 10;

type MediaFilter = "all" | "you" | "ai";
const MEDIA_FILTERS: { id: MediaFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "you", label: "You" },
  { id: "ai", label: "AI" },
];

type Item = LightboxImage & { byYou: boolean; at?: string };

const ARCHIVED = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(-\d+)?\.\w+$/i;

/// Every picture and recording in `logs` as a list, each row opening the
/// transcript's own viewer to step through the set. Opens on the newest ten
/// and Load more adds ten, whatever the chat has paged in meanwhile: from
/// what the transcript already holds where it can, from the log past that.
///
/// A list rather than the six-column grid it replaced: a grid holding one or
/// two pictures, or none and a Load more cell, was mostly empty cells drawing
/// lines round nothing. A row reads the same at any count.
///
/// `logs` is newest first and is more than one only for a bot's chat, which
/// an agent switch splits into several sessions read as one conversation.
export default function AttachmentList({ logs }: { logs: HeldLog[] }) {
  // The open picture by its source, not its position: the list is newest first,
  // so a screenshot landing while the viewer is open would shift every index.
  const [openSrc, setOpenSrc] = useState<string | null>(null);
  const [picked, setFilter] = useState<MediaFilter>("all");
  // Per session, since the pane stays mounted across a session switch.
  const [older, setOlder] = useState<Record<string, OlderMedia>>({});
  const [shownBy, setShownBy] = useState<Record<string, number>>({});
  const key = logs[0]?.sessionId ?? "";
  const shown = shownBy[key] ?? LOAD_MORE;
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);

  // Outside `ChatSessionContext`, so the session's server is named here rather
  // than through `useSessionPath`.
  const server = serverOfSession(logs[0]?.sessionId ?? "");
  const media = allMedia(logs, older);
  // Filters only where they can split the set: over pictures all from one side
  // they would offer to sort it into itself and nothing.
  const filterable = media.some((m) => m.byYou) && media.some((m) => !m.byYou);
  const filter = filterable ? picked : "all";
  const items = media
    .filter((m) => filter === "all" || m.byYou === (filter === "you"))
    .map((m): Item | null => {
      const src =
        "video" in m ? fileSrc(qualify(m.video, server)) : m.image.path ? fileSrc(qualify(m.image.path, server)) : m.image.url;
      if (!src) return null;
      const file = m.name ?? ("video" in m ? basename(m.video) : m.image.path ? basename(m.image.path) : "");
      // A kept copy is named by its id, which says nothing on a row.
      const name = !file || ARCHIVED.test(file) ? ("video" in m ? "Recording" : "Image") : file;
      return { src, name, video: "video" in m, byYou: m.byYou, at: m.at };
    })
    .filter((item): item is Item => item !== null);
  const visible = items.slice(0, shown);
  const at = visible.findIndex((item) => item.src === openSrc);
  const hasMore = items.length > shown || logs.some((log) => olderCursor(log, older[log.sessionId]) != null);

  const loadMore = async () => {
    const showMore = () => setShownBy((prev) => ({ ...prev, [key]: shown + LOAD_MORE }));
    // Already in hand: nothing to read.
    if (items.length >= shown + LOAD_MORE) return showMore();
    setLoading(true);
    setFailed(false);
    try {
      // The media lines alone, read back from `before` until there are enough.
      // A server from before `list_attachments` sends whole turns instead.
      const page = (sessionId: string, before: number) =>
        invoke<SessionPage>("list_attachments", { sessionId, before, limit: LOAD_MORE }).catch(() =>
          invoke<SessionPage>("get_session_page", { sessionId, before, turns: 16 }),
        );
      setOlder(await loadOlderMedia(logs, older, page, shown + LOAD_MORE - items.length));
      showMore();
    } catch (e) {
      console.error("failed to load older attachments", e);
      setFailed(true);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex shrink-0 flex-col">
      {/* The heading `RunHeading` draws over Background tasks and Subagents,
          with the filters at its far end. */}
      <div className="flex items-center px-3 pt-4 pb-2 text-ui text-muted-foreground">
        <span className="flex items-center gap-1.5">
          Attachments
          {/* Only once every one is in hand: a count of what happens to be
              paged in would read as the total and grow under Load more. */}
          {!hasMore && items.length > 1 && <span className="tabular-nums">{items.length}</span>}
        </span>
        {filterable && (
          <div role="group" aria-label="Show attachments from" className="ml-auto flex gap-2.5">
            {MEDIA_FILTERS.map(({ id, label }) => (
              <button
                key={id}
                type="button"
                aria-pressed={filter === id}
                onClick={() => {
                  setFilter(id);
                  setOpenSrc(null);
                }}
                className={cn("transition-colors", filter === id ? "text-foreground" : "hover:text-foreground")}
              >
                {label}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="flex flex-col gap-0.5 px-1 pb-2">
        {visible.length === 0 && (
          // With older history unread, "none" would be a claim about the whole
          // chat that Load more could disprove.
          <p className="px-2 py-1 text-ui text-muted-foreground">
            {hasMore ? "None in recent messages." : "None yet."}
          </p>
        )}
        {visible.map((item) => (
          <button
            key={item.src}
            type="button"
            onClick={() => setOpenSrc(item.src)}
            aria-label={item.video ? `Play ${item.name}` : `Open ${item.name}`}
            className="flex cursor-default items-center gap-2 rounded-lg px-2 py-1 text-left transition-colors hover:bg-sidebar-accent/50"
          >
            <Thumb item={item} small className="size-6 shrink-0 overflow-hidden rounded ring-[0.5px] ring-border" />
            <span className="min-w-0 flex-1 truncate text-ui text-sidebar-foreground">{item.name}</span>
            <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
              {/* The filters' own words, so a row says which one it falls under. */}
              {item.byYou ? "You" : "AI"}
              {item.at && ` · ${relativeTime(item.at)}`}
            </span>
          </button>
        ))}
        {hasMore && (
          <button
            type="button"
            onClick={() => void loadMore()}
            disabled={loading}
            className="flex cursor-default items-center gap-2 rounded-lg px-2 py-1 text-left text-ui text-muted-foreground transition-colors hover:bg-sidebar-accent/50 hover:text-foreground disabled:hover:bg-transparent"
          >
            {/* A tile where a row's thumbnail sits, so its words line up with the names above. */}
            <span className="flex size-6 shrink-0 items-center justify-center rounded ring-[0.5px] ring-border dark:bg-card">
              {loading ? <Spinner className="size-3.5" /> : <Plus className="size-3.5" />}
            </span>
            {failed ? "Couldn't load more. Try again" : "Load more"}
          </button>
        )}
      </div>

      <ImageLightbox
        images={visible}
        index={at === -1 ? null : at}
        onIndex={(i) => setOpenSrc(visible[i].src)}
        onClose={() => setOpenSrc(null)}
      />
    </div>
  );
}
