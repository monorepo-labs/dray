import { describe, expect, it } from "vitest";

import { planAsked } from "./plan";
import { currentTodos, isTodoCall, startsNewList, todoList } from "./todos";
import { namedParts } from "./tools";
import type { AgentEvent } from "@/types/events";

function toolCall(name: string, input: unknown): AgentEvent {
  return {
    payload: { type: "tool_call_started", name, input },
  } as unknown as AgentEvent;
}

describe("todoList", () => {
  it("reads both harnesses' spelling of the same list", () => {
    const claude = { todos: [{ content: "Fix it", status: "in_progress" }] };
    const grok = { merge: false, todos: [{ content: "Fix it", id: "1", status: "in_progress" }] };

    expect(todoList("TodoWrite", claude)).toEqual([
      { content: "Fix it", status: "in_progress", id: undefined },
    ]);
    expect(todoList("todo_write", grok)).toEqual([
      { content: "Fix it", status: "in_progress", id: "1" },
    ]);
  });

  it("reads an unknown status as pending rather than dropping the row", () => {
    const list = todoList("todo_write", { todos: [{ content: "Wait", status: "deferred" }] });
    expect(list?.[0].status).toBe("pending");
  });

  it("answers null for anything that is not a task list", () => {
    expect(todoList("Bash", { todos: [{ content: "x", status: "pending" }] })).toBeNull();
    expect(todoList("todo_write", { todos: [] })).toBeNull();
    expect(todoList("todo_write", { todos: "soon" })).toBeNull();
  });
});

describe("currentTodos", () => {
  const pending = [{ content: "Fix it", status: "pending" }];
  const done = [{ content: "Fix it", status: "completed" }];

  it("takes the newest list, since a write replaces rather than adds", () => {
    const events = [
      toolCall("todo_write", { todos: [{ content: "Old", status: "pending" }] }),
      toolCall("Bash", { command: "ls" }),
      toolCall("todo_write", { todos: pending }),
    ];
    expect(currentTodos(events)?.[0].content).toBe("Fix it");
  });

  it("keeps a finished list, which the strip folds rather than dropping", () => {
    expect(currentTodos([toolCall("todo_write", { todos: done })])).toEqual([
      { content: "Fix it", status: "completed", id: undefined },
    ]);
  });

  it("answers null for a session that never wrote one", () => {
    expect(currentTodos([toolCall("Bash", { command: "ls" })])).toBeNull();
  });

  // grok ticks an item off with `merge: true` and sends `id` and `status` and
  // no text at all, which read as a list in its own right is rows with nothing
  // to say — the reading that lost the whole checklist and drew raw JSON in
  // its place. Folded forwards, the words come from the write that had them.
  it("folds a merge update onto the list it updates", () => {
    const events = [
      toolCall("todo_write", {
        merge: false,
        todos: [
          { id: "1", content: "Read it", status: "in_progress" },
          { id: "2", content: "Fix it", status: "pending" },
        ],
      }),
      toolCall("todo_write", {
        merge: true,
        todos: [
          { id: "1", status: "completed" },
          { id: "2", status: "in_progress" },
        ],
      }),
    ];

    expect(currentTodos(events)).toEqual([
      { content: "Read it", status: "completed", id: "1" },
      { content: "Fix it", status: "in_progress", id: "2" },
    ]);
  });

  it("appends an id the list has not met, where it brings words of its own", () => {
    const events = [
      toolCall("todo_write", { todos: [{ id: "1", content: "Read it", status: "pending" }] }),
      toolCall("todo_write", {
        merge: true,
        todos: [{ id: "2", content: "Ship it", status: "pending" }],
      }),
    ];

    expect(currentTodos(events)?.map((todo) => todo.content)).toEqual(["Read it", "Ship it"]);
  });
});

describe("todoList against a merge update", () => {
  // The row's reading and the panel's are two questions. A merge update draws
  // no checklist — there is nothing in it to draw — but it is still a todo
  // call, which is what makes the row drop its arguments rather than expanding
  // onto the bare ids.
  it("is a todo call with no list to draw", () => {
    const merge = { merge: true, todos: [{ id: "1", status: "completed" }] };
    expect(isTodoCall("todo_write")).toBe(true);
    expect(todoList("todo_write", merge)).toBeNull();
  });
});

describe("startsNewList", () => {
  const todo = (content: string, status = "pending") =>
    ({ content, status }) as Parameters<typeof startsNewList>[1][number];

  it("is not news when an item is ticked off, which is most writes", () => {
    const before = [todo("Read it"), todo("Fix it")];
    const after = [todo("Read it", "completed"), todo("Fix it", "in_progress")];
    expect(startsNewList(before, after)).toBe(false);
  });

  it("is not news when a step is added to work already under way", () => {
    const before = [todo("Read it")];
    expect(startsNewList(before, [todo("Read it"), todo("Fix it")])).toBe(false);
  });

  it("is news for the session's first list", () => {
    expect(startsNewList(null, [todo("Read it")])).toBe(true);
  });

  it("is news when the plan is finished and different work starts", () => {
    const before = [todo("Read it", "completed"), todo("Fix it", "completed")];
    expect(startsNewList(before, [todo("Ship it"), todo("Write it up")])).toBe(true);
  });
});

describe("namedParts", () => {
  it("splits a namespaced tool id and title-cases both halves", () => {
    expect(namedParts("supermemory-ai__search_supermemory_memory_api_for")).toEqual({
      server: "Supermemory Ai",
      method: "Search Supermemory Memory Api For",
    });
  });

  it("refuses anything that is not two identifier runs", () => {
    expect(namedParts("run_terminal_command")).toBeNull();
    expect(namedParts("cat a__b.txt | wc -l")).toBeNull();
    expect(namedParts("/tmp/a__b/c")).toBeNull();
  });
});

describe("planAsked", () => {
  it("reads the plan off either harness's tool name", () => {
    expect(planAsked("exit_plan_mode", { plan: "## Step one" })).toBe("## Step one");
    expect(planAsked("ExitPlanMode", { plan: "## Step one" })).toBe("## Step one");
  });

  it("answers null for a tool that merely carries a plan field", () => {
    expect(planAsked("Bash", { plan: "## Step one" })).toBeNull();
    expect(planAsked("exit_plan_mode", { plan: "  " })).toBeNull();
    expect(planAsked("exit_plan_mode", {})).toBeNull();
  });
});
