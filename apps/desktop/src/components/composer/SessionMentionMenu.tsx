import PickerMenu from "@/components/composer/PickerMenu";
import { cn } from "@/lib/utils";
import type { SessionIndexItem, SessionStatus } from "@/types/events";

/// The mark on the left of a row, saying what that session is doing.
///
/// The sidebar's own pair, read from the same two facts: yellow while a turn is
/// running, green where one finished and has not been read. Idle draws nothing,
/// which is what makes the few that do worth looking at — and the slot stays
/// either way, or a row's title would sit at a different indent from the one
/// above it.
function StatusMark({ status }: { status: SessionStatus }) {
  return (
    <span className="flex w-1.5 shrink-0 items-center justify-center">
      {status !== "idle" && (
        <span
          role="img"
          aria-label={status === "in_progress" ? "Working" : "Unread"}
          className={cn(
            "size-1.5 rounded-full",
            status === "in_progress" ? "bg-accent-command" : "bg-accent-add",
          )}
        />
      )}
    </span>
  );
}

/// The `&` picker's rows.
///
/// Flat, like the file and issue pickers: the ranking *is* the answer — this
/// project's sessions, most recently touched first — so there is nothing a
/// heading would separate.
///
/// The title leads because it is the whole of what a session is recognised by,
/// and the branch trails dimmed because it is the only thing telling two
/// sessions with one title apart. No id anywhere on the row: it is what the
/// pick writes into the text, and it says nothing to the person choosing.
export default function SessionMentionMenu({
  sessions,
  statusBySession,
  activeIndex,
  onPick,
  onHover,
  placement = "above",
  bare = false,
}: {
  sessions: SessionIndexItem[];
  /// Live status, which outranks the index entry's own — that one carries a
  /// `completed` across a restart and nothing newer.
  statusBySession: Record<string, SessionStatus>;
  activeIndex: number;
  onPick: (session: SessionIndexItem) => void;
  onHover: (index: number) => void;
  placement?: "above" | "below";
  bare?: boolean;
}) {
  return (
    <PickerMenu
      groups={[{ label: null, items: sessions }]}
      label="Sessions"
      keyOf={(session) => session.sessionId}
      activeIndex={activeIndex}
      onPick={onPick}
      onHover={onHover}
      placement={placement}
      bare={bare}
      renderItem={(session) => (
        <>
          <StatusMark status={statusBySession[session.sessionId] ?? session.status} />

          <span className="min-w-0 truncate font-medium">{session.title}</span>

          {/* Trailing, so it can't push the title off its own left edge — and
              the worktree name where there is one, since that is the word the
              reader has seen in the sidebar and on the branch. */}
          {(session.worktreeName ?? session.branch) && (
            <span className="ml-auto shrink-0 truncate text-muted-foreground">
              {session.worktreeName ?? session.branch}
            </span>
          )}
        </>
      )}
    />
  );
}
