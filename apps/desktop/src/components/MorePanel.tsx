import SubagentPanel from "@/components/SubagentPanel";
import TodoList from "@/components/chat/TodoList";
import type { Todo } from "@/lib/todos";

/// The catch-all tab: a task list at the top, the session's subagent runs under
/// it. Sections rather than tabs of their own, because the tab row cannot grow
/// one per answer the reader merely *checks* — and neither of these is
/// something they work in.
///
/// Subagents keep the whole body where a task list takes only the height it
/// needs: a run list is browsed and a checklist is read at a glance.
export default function MorePanel({
  todos,
  subagents,
}: {
  todos: Todo[] | null;
  subagents: React.ComponentProps<typeof SubagentPanel>;
}) {
  return (
    // One scroller for the tab, not one per section. With the checklist
    // uncapped a section of its own would take whatever it needed and leave the
    // runs a sliver to scroll inside — so the pane scrolls and both lists sit
    // at their natural height.
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      {todos && <TodoSection todos={todos} />}

      {/* A section with no rows is drawn as nothing at all, not as an empty
          state: this tab is a catch-all, so its sections come and go, and a
          heading over the words "no subagents" is two lines spent saying the
          reader has nothing to read here. Both sections are titled or neither
          is — a heading over one list and none over the other reads as the
          second belonging to the first. */}
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
function TodoSection({ todos }: { todos: Todo[] }) {
  // const done = todos.filter((todo) => todo.status === "completed").length;

  return (
    // No rule under it — the next section's own heading is what says one
    // ended, the same reading the sidebar's runs take.
    <div className="shrink-0">
      {/* Parked rather than deleted while the section's shape is being looked
          at — the count is the only thing here the list itself does not say.
      <SectionTitle>
        <span className="flex items-center gap-1.5">
          <span className="shrink-0">Todo</span>
          <span className="shrink-0 font-mono tabular-nums">
            {done}/{todos.length}
          </span>
        </span>
      </SectionTitle>
      */}

      {/* No cap and no scroller of its own: a list cut off at a fixed height
          hides the very items the reader opened the tab for, and the pane
          already scrolls. A long plan pushes the runs down instead, which is
          the honest order — the list is what is happening now. */}
      {/* `pt-4` here rather than on the heading: the section has to carry its
          own break above it whether or not it is titled, or dropping the title
          leaves the first item flush against the tab row. */}
      <div className="px-3 pt-3 pb-3">
        <TodoList todos={todos} live />
      </div>
    </div>
  );
}
