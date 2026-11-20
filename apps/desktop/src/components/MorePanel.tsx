import AttachmentList from "@/components/AttachmentsPanel";
import RoutinesSection from "@/components/RoutinesSection";
import SubagentPanel from "@/components/SubagentPanel";
import TodoList from "@/components/chat/TodoList";
import type { HeldLog } from "@/lib/olderMedia";
import type { Todo } from "@/lib/todos";

/// The catch-all tab: a task list at the top, the session's running background
/// tasks under it. Sections rather than tabs of their own, because the tab row cannot grow
/// one per answer the reader merely *checks* — and neither of these is
/// something they work in.
///
/// Subagents keep the whole body where a task list takes only the height it
/// needs: a run list is browsed and a checklist is read at a glance.
export default function MorePanel({
  todos,
  live,
  attachments,
  subagents,
  routines,
}: {
  todos: Todo[] | null;
  /// The logs the attachment list reads, newest first — see `AttachmentList`.
  /// `null` where none holds a picture or recording.
  attachments: HeldLog[] | null;
  /// Whether the session is mid-turn. The checklist's running item shimmers on
  /// this alone — a list is **kept** after the turn ends, so an item left at
  /// `in_progress` by a session that stopped would otherwise animate a claim
  /// about now over a list that is only history.
  live: boolean;
  subagents: React.ComponentProps<typeof SubagentPanel>;
  /// A bot chat's routines; absent outside one.
  routines?: React.ComponentProps<typeof RoutinesSection>;
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
          reader has nothing to read here. */}
      {/* Titles its own two sections, Background tasks and Subagents. */}
      {subagents.runs.length > 0 && <SubagentPanel {...subagents} />}

      {attachments && <AttachmentList logs={attachments} />}

      {/* Under the attachments, so Load more pushes it down; kept below on purpose. */}
      {routines && routines.routines.length > 0 && <RoutinesSection {...routines} />}
    </div>
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
