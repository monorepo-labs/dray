import { useState } from "react";

import SubagentPanel from "@/components/SubagentPanel";
import ImageLightbox, { Thumb, type LightboxImage } from "@/components/chat/ImageLightbox";
import TodoList from "@/components/chat/TodoList";
import { basename } from "@/lib/format";
import type { Todo } from "@/lib/todos";
import type { SessionMedia } from "@/lib/transcript";
import { fileSrc, qualify, serverOfSession } from "@/lib/transport";
import { cn } from "@/lib/utils";

/// The catch-all tab: a task list at the top, the session's subagent runs under
/// it. Sections rather than tabs of their own, because the tab row cannot grow
/// one per answer the reader merely *checks* — and neither of these is
/// something they work in.
///
/// Subagents keep the whole body where a task list takes only the height it
/// needs: a run list is browsed and a checklist is read at a glance.
export default function MorePanel({
  todos,
  live,
  media,
  sessionId,
  subagents,
}: {
  todos: Todo[] | null;
  /// Pictures and recordings, newest first — see `sessionMedia`.
  media: SessionMedia[];
  sessionId: string;
  /// Whether the session is mid-turn. The checklist's running item shimmers on
  /// this alone — a list is **kept** after the turn ends, so an item left at
  /// `in_progress` by a session that stopped would otherwise animate a claim
  /// about now over a list that is only history.
  live: boolean;
  subagents: React.ComponentProps<typeof SubagentPanel>;
}) {
  return (
    // One scroller for the tab, not one per section. With the checklist
    // uncapped a section of its own would take whatever it needed and leave the
    // runs a sliver to scroll inside — so the pane scrolls and both lists sit
    // at their natural height.
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      {todos && <TodoSection todos={todos} live={live} />}

      {/* A section with no rows is drawn as nothing at all, not as an empty
          state: this tab is a catch-all, so its sections come and go, and a
          heading over the words "no subagents" is two lines spent saying the
          reader has nothing to read here. Both sections are titled or neither
          is — a heading over one list and none over the other reads as the
          second belonging to the first. */}
      {/* Untitled: a grid of pictures names itself. */}
      {media.length > 0 && <AttachmentGrid media={media} sessionId={sessionId} />}

      {subagents.runs.length > 0 && (
        <>
          <SectionTitle>Background Tasks</SectionTitle>
          <SubagentPanel {...subagents} />
        </>
      )}
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    // `pt-4` on every one of them rather than a gap on the container: the
    // heading carries the break above it, so a section arriving or going takes
    // its own spacing with it.
    <div className="shrink-0 px-3 pt-4 pb-2 text-ui text-muted-foreground">{children}</div>
  );
}

/// The list itself, with no caret on it. A section the reader opened the tab to
/// read is not one to make them open again — and the panel opens itself here on
/// a new list, which a collapsed section would answer with a heading.
function TodoSection({ todos, live }: { todos: Todo[]; live: boolean }) {
  return (
    // No rule under it — the next section's own heading is what says one
    // ended, the same reading the sidebar's runs take.
    <div className="shrink-0">
      {/* No cap and no scroller of its own: a list cut off at a fixed height
          hides the very items the reader opened the tab for, and the pane
          already scrolls. A long plan pushes the runs down instead, which is
          the honest order — the list is what is happening now. */}
      {/* `pt-4` here rather than on the heading: the section has to carry its
          own break above it whether or not it is titled, or dropping the title
          leaves the first item flush against the tab row. */}
      <div className="px-3 pt-3 pb-3">
        <TodoList todos={todos} live={live} />
      </div>
    </div>
  );
}

/// Fixed rather than `auto-fill`, so two rows is a known count.
const COLUMNS = 6;
const MAX_TILES = COLUMNS * 2;

type MediaFilter = "all" | "you" | "ai";
const MEDIA_FILTERS: { id: MediaFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "you", label: "You" },
  { id: "ai", label: "AI" },
];

/// A contact sheet: pictures cropped square to their cells, each opening the
/// transcript's own viewer to step through the whole set. Held to two rows so it
/// never pushes Background Tasks off the pane; past that the last cell is a
/// count opening the viewer where the cells stop.
function AttachmentGrid({ media, sessionId }: { media: SessionMedia[]; sessionId: string }) {
  // The open picture by its source, not its position: the list is newest first,
  // so a screenshot landing while the viewer is open would shift every index.
  const [openSrc, setOpenSrc] = useState<string | null>(null);
  const [filter, setFilter] = useState<MediaFilter>("all");
  // Outside `ChatSessionContext`, so the session's server is named here rather
  // than through `useSessionPath`.
  const server = serverOfSession(sessionId);
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
  const shown = items.length > MAX_TILES ? MAX_TILES - 1 : items.length;
  const hidden = items.length - shown;
  // Empty cells finish the last row, so the lines run the whole width rather
  // than stopping where the pictures do.
  const filler = (COLUMNS - ((shown + (hidden > 0 ? 1 : 0)) % COLUMNS)) % COLUMNS;
  const cell = "aspect-square border-b-[0.5px] border-border [&:not(:nth-child(6n))]:border-r-[0.5px]";

  return (
    <div className="flex shrink-0 flex-col gap-2 pt-3 pb-3">
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
      {items.length === 0 ? (
        <p className="px-3 py-2 text-ui text-muted-foreground">Nothing here.</p>
      ) : (
        // Edge to edge, with the panel's own sides as the outer frame.
        <div className="grid grid-cols-6 border-t-[0.5px] border-border">
          {items.slice(0, shown).map((item) => (
            <button
              key={item.src}
              type="button"
              onClick={() => setOpenSrc(item.src)}
              aria-label={item.video ? `Play ${item.name}` : `Open ${item.name}`}
              className={cn(cell, "cursor-zoom-in overflow-hidden transition-opacity hover:opacity-90")}
            >
              <Thumb item={item} className="size-full" />
            </button>
          ))}
          {hidden > 0 && (
            <button
              type="button"
              onClick={() => setOpenSrc(items[shown].src)}
              aria-label={`Show ${hidden} more`}
              className={cn(
                cell,
                "bg-muted/60 text-chat text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
              )}
            >
              +{hidden}
            </button>
          )}
          {Array.from({ length: filler }, (_, i) => (
            <div key={`filler-${i}`} className={cell} />
          ))}
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
