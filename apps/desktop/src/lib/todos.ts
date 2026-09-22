import type { AgentEvent } from "@/types/events";

export type Todo = {
  content: string;
  /// Unrecognised words read as pending, the safe direction: a list item drawn
  /// as not-done is wrong about one row, where dropping it hides work.
  status: "pending" | "in_progress" | "completed";
  id?: string;
};

/// Whether a call is a task list write at all. Claude Code's `TodoWrite` and
/// grok's `todo_write` are the same tool under two spellings.
///
/// Asked separately from reading the list, because a *merge* update carries no
/// item text at all — so "is this a todo call" and "does this call draw a
/// checklist" are two questions, and the row's arguments have to be dropped on
/// the first rather than the second or a merge expands onto its own JSON.
export function isTodoCall(toolName: string): boolean {
  return toolName === "TodoWrite" || toolName === "todo_write";
}

type Written = { merge: boolean; items: { id?: string; content?: string; status: Todo["status"] }[] };

/// What a `todo_write` call says, without deciding what it means for the list.
function written(input: unknown): Written | null {
  if (!input || typeof input !== "object") return null;
  const call = input as Record<string, unknown>;
  if (!Array.isArray(call.todos)) return null;

  const items = call.todos.flatMap((raw): Written["items"] => {
    if (!raw || typeof raw !== "object") return [];
    const item = raw as Record<string, unknown>;
    const status = item.status;
    return [
      {
        id: typeof item.id === "string" ? item.id : undefined,
        content: typeof item.content === "string" && item.content ? item.content : undefined,
        status: status === "completed" || status === "in_progress" ? status : "pending",
      },
    ];
  });

  return items.length > 0 ? { merge: call.merge === true, items } : null;
}

/// The task list a single call carries, or `null` where it carries none.
///
/// This is the *row's* reading, so it answers for a call in isolation: a merge
/// update naming ids and statuses and no text has nothing to draw, and says so
/// rather than inventing rows. The panel reads the whole log instead — see
/// `currentTodos`.
export function todoList(toolName: string, input: unknown): Todo[] | null {
  if (!isTodoCall(toolName)) return null;
  const call = written(input);
  if (!call) return null;

  const list = call.items.flatMap((item) =>
    item.content ? [{ content: item.content, status: item.status, id: item.id }] : [],
  );
  return list.length > 0 ? list : null;
}

/// Folds one write onto the list before it.
///
/// **`merge` is grok's, and getting it wrong lost the whole list.** A merge
/// update names `id` and `status` and *no content at all*, so read as a list in
/// its own right it is three items with nothing to say — which is how a session
/// that had ticked every box ended up drawing its raw JSON instead of a
/// checklist. Matched on `id` alone, which is the only thing such an update
/// carries; an id the list has not met is appended where it brings text of its
/// own and dropped where it does not, since a row with no words is not a row.
function fold(previous: Todo[] | null, call: Written): Todo[] | null {
  if (!call.merge || !previous) {
    const list = call.items.flatMap((item) =>
      item.content ? [{ content: item.content, status: item.status, id: item.id }] : [],
    );
    // A write that replaces the list with nothing drawable leaves the previous
    // one standing: losing the list is the worse of the two wrong answers.
    return list.length > 0 ? list : previous;
  }

  const merged = previous.map((todo) => {
    const update = call.items.find((item) => item.id !== undefined && item.id === todo.id);
    return update ? { ...todo, status: update.status, content: update.content ?? todo.content } : todo;
  });

  const seen = new Set(previous.map((todo) => todo.id));
  const added = call.items.flatMap((item) =>
    item.content && !seen.has(item.id)
      ? [{ content: item.content, status: item.status, id: item.id }]
      : [],
  );

  return [...merged, ...added];
}

/// Whether the agent has started a *different* list, rather than ticking an
/// item off the one it was already working through.
///
/// This is what the panel opens itself on, and the distinction is the whole
/// reason it can: `todo_write` fires on every status change, so a rule reading
/// "the list moved" would yank the pane open several times a turn. A list the
/// reader has already been shown does not need showing again — but a session
/// that finishes its plan and starts on something else does.
///
/// The test is **no shared item text**. A tick keeps every line, adding a step
/// keeps most, and replacing the work replaces all of them — so overlap is a
/// cleaner signal than any threshold, and it needs nothing remembered beyond
/// the previous list.
export function startsNewList(previous: Todo[] | null, next: Todo[]): boolean {
  if (!previous || previous.length === 0) return true;
  const before = new Set(previous.map((todo) => todo.content));
  return !next.some((todo) => before.has(todo.content));
}

/// The session's current task list.
///
/// **Read back out of the log rather than tracked in a map**, the bargain the
/// context ring already makes: everything moving this list is persisted, so a
/// reopened session shows what it showed live and nothing has to be kept in
/// step with the turn.
///
/// The walk runs **forwards**, since a merge update only means anything against
/// the list it updates — a backwards walk stopping at the newest call reads the
/// last tick as the whole list.
///
/// A finished list is **kept**, not retired. It is the record of what the turn
/// actually did, which is worth as much as the list of what is left.
export function currentTodos(events: AgentEvent[]): Todo[] | null {
  let list: Todo[] | null = null;
  for (const event of events) {
    const payload = event.payload;
    if (payload.type !== "tool_call_started") continue;
    if (!isTodoCall(payload.name)) continue;
    const call = written(payload.input);
    if (call) list = fold(list, call);
  }
  return list;
}
