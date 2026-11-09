import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";

import { Button } from "@/components/ui/button";
import PermissionRequest from "@/components/chat/PermissionRequest";
import QuestionRequest from "@/components/chat/QuestionRequest";
import type { PaneChat } from "@/components/SplitView";
import type { PaneState } from "@/hooks/useSessions";
import { RANK_CREW } from "@/lib/cardKeys";
import type { CrewRow } from "@/lib/crew";
import { truncate } from "@/lib/format";
import { toolArgument } from "@/lib/tools";
import { buildTranscript } from "@/lib/transcript";
import { cn } from "@/lib/utils";
import type { AgentEvent } from "@/types/events";

/// The crew's width, fixed — not a share, and not draggable. A card is
/// answered and gone, so a column the reader could widen is a second workspace
/// nobody asked for.
export const CREW_W = 420;
/// Off for now: cards stack above the composer whatever the window's width.
/// The side column is kept, not deleted, in case it comes back.
export const CREW_BESIDE = false;
/** Widest window on which an open right panel stacks the crew: a 14" MacBook. */
export const CREW_STACK_WITH_PANEL_W = 1512;

type CrewProps = {
  /// The rows holding a card, and only those.
  rows: CrewRow[];
  paneState: (sessionId: string) => PaneState;
  /// Opens a session whose card could not be read, which goes through the
  /// select path and so reads it again and reports a failure.
  onOpen: (sessionId: string) => void;
  chat: PaneChat;
  /// Drawn above the composer rather than beside the transcript — see
  /// `crewBeside` in `App`.
  stacked?: boolean;
};

/// What the sessions this conversation started are waiting on, answered in
/// place. Drawn only while something is asking — the sidebar already lists the
/// sessions, so a standing list here was the same thing twice. A hidden session
/// surfaces nowhere else.
///
/// **One card at a time**, with arrows to step through the rest: several cards
/// at once is a wall of questions on top of the conversation the reader is in.
///
/// The title is a label, not a link. Answering a card is a reply sent by id,
/// not a move into that session, so nothing here moves the selection.
export default function Crew({ rows, paneState, onOpen, chat, stacked = false }: CrewProps) {
  // Held by id, so an answered card leaving does not shift the reader onto
  // whichever card took its index; they land on the first one instead.
  const [pickedId, setPickedId] = useState<string | null>(null);
  const at = Math.max(0, rows.findIndex((r) => r.item.sessionId === pickedId));
  const row = rows[at];
  const step = (delta: number) =>
    setPickedId(rows[(at + delta + rows.length) % rows.length].item.sessionId);
  if (!row) return null;

  const list = (
    // The edge is a `border-image` ramp in `--border`'s own colour, full at the
    // composer's end and gone by the top: a flat one reads as a split between
    // two places to work. `border-image` rather than a pseudo-element, since
    // this column scrolls and an absolute child would slide away with it.
    <div
      className={cn(
        "flex min-h-0 flex-col gap-1 overflow-y-auto",
        !stacked && "shrink-0 border-l [border-image:linear-gradient(to_bottom,transparent,var(--border))_1]",
      )}
      style={stacked ? undefined : { width: CREW_W }}
    >
      <div key={row.item.sessionId} className="flex shrink-0 flex-col">
        <div className="flex h-8 items-center gap-2 pl-3 pr-1.5 text-ui text-muted-foreground select-none">
          <span className="truncate">{row.item.title}</span>
          <span className="sr-only">Waiting for you</span>
          {rows.length > 1 && (
            <div className="ml-auto flex shrink-0 items-center gap-0.5 text-muted-foreground">
              <Button variant="ghost" size="icon-xs" aria-label="Previous request" onClick={() => step(-1)}>
                <ChevronLeft />
              </Button>
              <span className="min-w-8 text-center tabular-nums">
                {at + 1}/{rows.length}
              </span>
              <Button variant="ghost" size="icon-xs" aria-label="Next request" onClick={() => step(1)}>
                <ChevronRight />
              </Button>
            </div>
          )}
        </div>
        <PendingCard
          sessionId={row.item.sessionId}
          events={paneState(row.item.sessionId).session?.events}
          chat={chat}
          onOpen={() => onOpen(row.item.sessionId)}
        />
      </div>
    </div>
  );

  // Stacked, the wrapper lines the cards up with the composer's column; `mb-2`
  // keeps it off the handoff sliver. No fill of its own: it sits on the
  // transcript's. Not `shrink-0`: the composer is, so a tall draft would push it
  // out of the window.
  return stacked ? (
    <div className="mx-auto mb-2 flex max-h-[70%] min-h-0 w-full max-w-3xl flex-col overflow-hidden px-3 pt-3">
      {list}
    </div>
  ) : (
    list
  );
}

/// The card one session is waiting on.
function PendingCard({
  sessionId,
  events,
  chat,
  onOpen,
}: {
  sessionId: string;
  events: AgentEvent[] | undefined;
  onOpen: () => void;
  chat: Pick<PaneChat, "onRespondPermission" | "onAnswerQuestions">;
}) {
  // `buildTranscript`'s own pairing rather than a walk of our own: it is what
  // matches a request to its decision, drops one the CLI took back, and knows
  // that a `questions_asked` rides the same channel.
  const ask = useMemo(() => buildTranscript(events ?? [], true).pendingAsks[0], [events]);

  // `announce` takes a drawn crew as the reader having seen the question, so a
  // card below the fold would hold the agent's turn with nobody told. `nearest`
  // moves nothing for a card already in view; keyed on the request so a
  // re-render does not scroll.
  const cardRef = useRef<HTMLDivElement>(null);
  const requestId = ask?.requestId;
  useEffect(() => {
    if (requestId) cardRef.current?.scrollIntoView({ block: "nearest" });
  }, [requestId]);

  // Read out of a transcript that may still be loading or may have failed to.
  // Open is the retry. A *loaded* one without the ask draws nothing.
  if (!ask) {
    if (events) return null;
    return (
      <div className="flex items-center justify-between gap-2 px-3 pb-3 text-ui text-muted-foreground">
        Loading the request…
        <Button variant="outline" size="xs" onClick={onOpen}>
          Open
        </Button>
      </div>
    );
  }

  return (
    <div ref={cardRef} className="px-3 pb-3">
      {ask.type === "questions_asked" ? (
        // `autoFocus` off: this card arrives in a column the reader was not
        // looking at, and taking the caret would put their next keystroke in
        // another session's form.
        <QuestionRequest
          requestId={ask.requestId}
          questions={ask.questions}
          autoFocus={false}
          keyRank={RANK_CREW}
          onAnswer={(answers) => chat.onAnswerQuestions(sessionId, ask.requestId, answers)}
        />
      ) : (
        <PermissionRequest
          // Capped: with no description the title is often the whole command,
          // already drawn in full just above it, and this column is 420px wide.
          description={truncate(
            ask.description ?? ask.title ?? ask.displayName ?? ask.toolName,
            140,
          )}
          argument={toolArgument(ask.input)}
          options={ask.options}
          onRespond={(optionId) => chat.onRespondPermission(sessionId, ask.requestId, optionId)}
          keyRank={RANK_CREW}
        />
      )}
    </div>
  );
}
