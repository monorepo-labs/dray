import { cn } from "@/lib/utils";
import type { Todo } from "@/lib/todos";

/// The three states, drawn here rather than taken from lucide.
///
/// **Lucide cannot make these the same size.** Its squares and circles are
/// inset in a 24 viewBox, so the glyph never fills its own box, and what is
/// visible is the shape *plus its stroke* — `SquareCheck` strokes in the page
/// colour to keep the tick legible, shrinking the box, where a plain `Square`
/// stroked in its own colour grows by the same amount. Two boxes ~20% apart
/// under one `size-4`. One viewBox of our own, the full 16 with no stroke on
/// the box: all three are the same square by construction.
///
/// In progress is a half-filled box in the page's own ink, not the accent
/// yellow. That yellow is what the sidebar spends on a session *wanting* the
/// reader, so an item merely being worked on wore the colour of a problem.
/// Clipped to the box's own rounding rather than drawn as a second rounded
/// shape, or the half's corners would read as a smaller box inside the first.
function TodoMark({ status }: { status: Todo["status"] }) {
  return (
    <svg viewBox="0 0 16 16" className="mt-0.5 size-4 shrink-0" aria-hidden>
      <rect
        width="16"
        height="16"
        rx="6"
        className={status === "completed" ? "fill-accent-add" : "fill-muted-foreground/25"}
      />
      {status === "in_progress" && (
        <path
          d="M8 0h2a6 6 0 0 1 6 6v4a6 6 0 0 1-6 6H8Z"
          className="fill-foreground/70"
        />
      )}
      {status === "completed" && (
        <path
          d="m4.6 8.3 2.2 2.2 4.6-4.8"
          fill="none"
          strokeWidth="1.7"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="stroke-background"
        />
      )}
    </svg>
  );
}

/// The agent's own task list, drawn as the checklist it is.
///
/// Outside the expander and always on screen, unlike every other tool body: a
/// checklist is a progress report rather than an argument, and one hidden
/// behind a caret says nothing the row's label did not. It is also the only
/// thing this call carries, so the arguments under it would be the same list
/// again as JSON — see `TODO_FIELDS`.
///
/// Drawn at the transcript's own size, not the tool row's. Every other tool
/// body is machine output read at a glance where this is a list of sentences
/// the reader is tracking their work against.
export default function TodoList({
  todos,
  live = false,
}: {
  todos: Todo[];
  /// Whether this list is the session's *current* one rather than a record of
  /// one call. Only the panel's is: a transcript row is what the agent wrote at
  /// that moment, and an animation there claims an item is being worked on now
  /// when the turn it belongs to may be hours old.
  live?: boolean;
}) {
  return (
    <ul className="flex flex-col gap-1.5">
      {todos.map((todo, i) => (
        <li key={todo.id ?? i} className="flex items-start gap-2 text-chat leading-snug">
          <TodoMark status={todo.status} />
          <span
            className={cn(
              // Dimmed and not struck through: the tick beside it already says
              // done, and a rule drawn across a sentence is there to say it was
              // wrong rather than that it is finished.
              todo.status === "completed" && "text-muted-foreground",
              // The running one is the reader's answer to "where is it now", so
              // it is the one line drawn at full strength — and, in the panel
              // alone, the one that shimmers, the same mark a pending tool row
              // wears.
              todo.status === "in_progress" ? "text-foreground" : "text-foreground/90",
              todo.status === "in_progress" && live && "shimmer-text",
            )}
          >
            {todo.content}
          </span>
        </li>
      ))}
    </ul>
  );
}
