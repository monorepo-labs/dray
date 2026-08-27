import { describe, expect, it } from "vitest";

import { buildTranscript, segmentWork } from "@/lib/transcript";
import type { AgentEvent, AgentEventPayload } from "@/types/events";

/// Only the envelope fields `buildTranscript` orders and keys by are filled;
/// the rest has no bearing on the two rules under test.
function event(seq: number, payload: AgentEventPayload): AgentEvent {
  return {
    id: `e-${seq}`,
    sessionId: "s",
    harness: "claude_code",
    seq,
    ts: "2026-08-13T00:00:00Z",
    turnId: null,
    subagent: null,
    payload,
    raw: null,
  } as AgentEvent;
}

function prompt(seq: number, text: string, queued: boolean): AgentEvent {
  return event(seq, {
    type: "user_message",
    text,
    images: [],
    issues: [],
    baseline: null,
    queued,
    from: null,
  });
}

function callStarted(seq: number, callId: string): AgentEvent {
  return event(seq, {
    type: "tool_call_started",
    callId,
    name: "Bash",
    toolType: "other",
    input: {},
    rawInput: null,
    title: null,
  } as AgentEventPayload);
}

function completed(seq: number, finalText: string | null = null): AgentEvent {
  return event(seq, {
    type: "turn_completed",
    status: "success",
    stopReason: null,
    finalText,
    usage: null,
    durationMs: null,
    head: null,
  } as AgentEventPayload);
}

function text(seq: number, body: string): AgentEvent {
  return event(seq, {
    type: "assistant_text",
    block: null,
    text: body,
  } as AgentEventPayload);
}

/// The text `buildTranscript` files into `resultByCallId` for a call nothing can
/// finish. Matched on rather than imported because it is deliberately private.
const ABANDONED = /session ended/;

describe("a queued prompt", () => {
  /// The whole point of the flag. A queued prompt was typed into a turn that was
  /// already running, so the calls open in front of it are still live — marking
  /// them abandoned would stop a running tool's row shimmering while it works.
  it("leaves the tool calls open in front of it running", () => {
    const { resultByCallId } = buildTranscript(
      [prompt(0, "go", false), callStarted(1, "c1"), prompt(2, "and also", true)],
      true,
    );

    expect(resultByCallId.get("c1")).toBeUndefined();
  });

  /// The rule it inverts has to keep working, or a queued prompt would be the
  /// only thing holding it up.
  it("still abandons them when the prompt is an ordinary one", () => {
    const { resultByCallId } = buildTranscript(
      [prompt(0, "go", false), callStarted(1, "c1"), prompt(2, "never mind", false)],
      true,
    );

    expect(resultByCallId.get("c1")?.text).toMatch(ABANDONED);
  });

  /// The CLI folds a queued prompt into the running turn and emits one
  /// `turn_completed` for the pair. Cutting a turn here would leave the first
  /// permanently open and hand it the rest of the first turn's work.
  it("renders inside the running turn rather than opening one", () => {
    const { turns } = buildTranscript(
      [
        prompt(0, "go", false),
        callStarted(1, "c1"),
        prompt(2, "and also", true),
        completed(3),
      ],
      false,
    );

    expect(turns).toHaveLength(1);
    expect(turns[0].completed).not.toBeNull();
    // It draws a row where it was typed — the count is what the collapsed
    // summary reads, so a prompt that rendered but didn't count would misreport.
    expect(turns[0].work.some((w) => "payload" in w && w.payload.type === "user_message")).toBe(
      true,
    );
  });

  /// It stays on screen through a collapse, so it is not a row the toggle
  /// promises to reveal. Counting it would offer a toggle over rows already
  /// visible — and in the one-call case, over nothing at all.
  it("does not count toward the rows a collapse would hide", () => {
    const withQueued = buildTranscript(
      [prompt(0, "go", false), callStarted(1, "c1"), prompt(2, "and also", true), completed(3)],
      false,
    );
    const without = buildTranscript(
      [prompt(0, "go", false), callStarted(1, "c1"), completed(2)],
      false,
    );

    expect(withQueued.turns[0].rows).toBe(without.turns[0].rows);
  });

  /// It renders, so it breaks a run of same-tool calls rather than being held
  /// and re-emitted after the group — which would move it away from the point in
  /// the turn where it was actually typed.
  it("splits a run of tool calls rather than folding into the group", () => {
    const { turns } = buildTranscript(
      [
        prompt(0, "go", false),
        callStarted(1, "c1"),
        callStarted(2, "c2"),
        prompt(3, "and also", true),
        callStarted(4, "c3"),
        callStarted(5, "c4"),
        completed(6),
      ],
      false,
    );

    const kinds = turns[0].work.map((w) =>
      "kind" in w ? "group" : w.payload.type,
    );
    expect(kinds).toEqual(["group", "user_message", "group"]);
  });

  /// A log replayed from a truncation can open on one, and it has to have
  /// somewhere to go rather than being dropped.
  it("opens a turn when there is none to join", () => {
    const { turns } = buildTranscript([prompt(0, "orphan", true)], false);

    expect(turns).toHaveLength(1);
    expect(turns[0].prompt?.payload.type).toBe("user_message");
  });
});

describe("a turn that closed without finalText", () => {
  /// An interrupt closes the turn with `finalText: null`. Falling back to the
  /// last message keeps the collapsed view ending on what the agent last said,
  /// instead of filing that message behind the summary with everything else.
  it("falls back to its last message", () => {
    const { turns } = buildTranscript(
      [
        prompt(0, "go", false),
        text(1, "partial answer"),
        callStarted(2, "c1"),
        completed(3),
      ],
      false,
    );

    expect(turns[0].finalText).toBe("partial answer");
  });

  /// A turn nothing ever closed shows its work loose — the fallback is for a
  /// closed turn's collapsed view, and this one never collapses.
  it("does not fall back while the turn is unclosed", () => {
    const { turns } = buildTranscript(
      [prompt(0, "go", false), text(1, "partial answer")],
      true,
    );

    expect(turns[0].finalText).toBeNull();
  });
});

describe("segmentWork", () => {
  /// The collapsed view's whole reason: work is cut at each queued prompt so
  /// the prompt stays after the stretch it interrupted rather than bunching
  /// with the other prompts once the rows between them are hidden.
  it("cuts the work at each queued prompt", () => {
    const { turns } = buildTranscript(
      [
        prompt(0, "go", false),
        callStarted(1, "c1"),
        callStarted(2, "c2"),
        prompt(3, "and also", true),
        callStarted(4, "c3"),
        completed(5),
      ],
      false,
    );

    const segments = segmentWork(turns[0]);
    expect(segments).toHaveLength(2);
    expect(segments[0].toolCalls).toBe(2);
    expect(segments[0].prompt).not.toBeNull();
    expect(segments[1].toolCalls).toBe(1);
    expect(segments[1].prompt).toBeNull();
  });

  /// `finalText` re-renders the turn's last message, and the turn-level counts
  /// discount it — the last segment has to agree, or the summary line promises
  /// a message the collapse isn't hiding.
  it("mirrors the finalText discount on the last segment", () => {
    const { turns } = buildTranscript(
      [
        prompt(0, "go", false),
        callStarted(1, "c1"),
        prompt(2, "and also", true),
        callStarted(3, "c2"),
        text(4, "done"),
        completed(5, "done"),
      ],
      false,
    );

    const segments = segmentWork(turns[0]);
    const last = segments[segments.length - 1];
    expect(last.messages).toBe(0);
    expect(segments.reduce((n, s) => n + s.messages, 0)).toBe(turns[0].messages);
  });

  /// Two prompts with nothing between them: the empty stretch draws no summary
  /// line, so `rows` has to say so.
  it("gives an empty stretch zero rows", () => {
    const { turns } = buildTranscript(
      [
        prompt(0, "go", false),
        callStarted(1, "c1"),
        prompt(2, "first", true),
        prompt(3, "second", true),
        callStarted(4, "c2"),
        completed(5),
      ],
      false,
    );

    const segments = segmentWork(turns[0]);
    expect(segments).toHaveLength(3);
    expect(segments[1].rows).toBe(0);
  });
});

describe("subagent runs", () => {
  /// The envelope's `id` is the spawning call, the payload's `agentId` is the
  /// harness's task handle, and `stop_task` names the second. Confusing them is
  /// silent — the CLI answers success for an id it does not hold — so the panel
  /// has to read it off the lifecycle events rather than off the key.
  function lifecycle(
    seq: number,
    toolUseId: string,
    payload: AgentEventPayload,
  ): AgentEvent {
    return {
      ...event(seq, payload),
      subagent: { id: toolUseId, label: "general-purpose" },
    } as AgentEvent;
  }

  function started(seq: number, toolUseId: string, taskId: string): AgentEvent {
    return lifecycle(seq, toolUseId, {
      type: "subagent_started",
      agentId: taskId,
      label: "general-purpose",
      description: `run ${taskId}`,
      prompt: null,
    } as AgentEventPayload);
  }

  it("carries the task id the stop control needs, not the spawning call's", () => {
    const { subagents } = buildTranscript(
      [callStarted(0, "toolu_1"), started(1, "toolu_1", "a34397eb")],
      true,
    );

    expect(subagents).toHaveLength(1);
    expect(subagents[0].id).toBe("toolu_1");
    expect(subagents[0].taskId).toBe("a34397eb");
  });

  /// Newest first. The list only grows, and the run worth acting on is the one
  /// that just started — at the bottom it sat below every finished run in the
  /// session.
  it("lists the newest run first", () => {
    const { subagents, subagentById } = buildTranscript(
      [
        callStarted(0, "toolu_1"),
        started(1, "toolu_1", "task-a"),
        callStarted(2, "toolu_2"),
        started(3, "toolu_2", "task-b"),
      ],
      true,
    );

    expect(subagents.map((r) => r.taskId)).toEqual(["task-b", "task-a"]);
    // Lookups by id must be unaffected — the chat opens a run from its own row.
    expect(subagentById.get("toolu_1")?.taskId).toBe("task-a");
  });

  /// A run with no lifecycle event yet has nothing to stop by, and the panel
  /// reads null as "not stoppable" rather than falling back to the call id.
  it("leaves the task id null until a lifecycle event names it", () => {
    const { subagents } = buildTranscript(
      [
        callStarted(0, "toolu_1"),
        lifecycle(1, "toolu_1", {
          type: "assistant_text",
          block: null,
          text: "working",
        } as AgentEventPayload),
      ],
      true,
    );

    expect(subagents[0].taskId).toBeNull();
  });
});

describe("a tool call that came back with pictures", () => {
  function readStarted(seq: number, callId: string, path: string): AgentEvent {
    return event(seq, {
      type: "tool_call_started",
      callId,
      name: "Read",
      toolType: "file_read",
      input: { file_path: path },
      rawInput: null,
      title: null,
    } as AgentEventPayload);
  }

  function readCompleted(seq: number, callId: string, images: number): AgentEvent {
    return event(seq, {
      type: "tool_call_completed",
      callId,
      result: {
        text: "",
        isError: false,
        structured: null,
        exitCode: null,
        durationMs: null,
        images: Array.from({ length: images }, (_, i) => ({
          path: `/archived/${i}.png`,
          url: null,
          mimeType: "image/png",
        })),
      },
    } as AgentEventPayload);
  }

  /// "Read 2 files" is an honest summary of two files and no summary at all of
  /// two screenshots — the row draws them unopened because they are the whole of
  /// what the call returned, and a group puts them back behind a click.
  it("stays its own row instead of joining the run", () => {
    const { turns } = buildTranscript(
      [
        prompt(0, "look", false),
        readStarted(1, "c1", "/tmp/shot.png"),
        readCompleted(2, "c1", 1),
        readStarted(3, "c2", "/src/a.ts"),
        readCompleted(4, "c2", 0),
        readStarted(5, "c3", "/src/b.ts"),
        readCompleted(6, "c3", 0),
        completed(7, "done"),
      ],
      false,
    );

    const work = turns[0].work;
    expect(work.filter((item) => "kind" in item && item.kind === "tool_group")).toHaveLength(1);
    expect(
      work.some(
        (item) => !("kind" in item) && item.payload.type === "tool_call_started" && item.payload.callId === "c1",
      ),
    ).toBe(true);
  });

  /// The rule it bends has to keep working, or every run of reads would come
  /// apart on a result nobody looked at.
  it("leaves an ordinary run grouped", () => {
    const { turns } = buildTranscript(
      [
        prompt(0, "look", false),
        readStarted(1, "c1", "/src/a.ts"),
        readCompleted(2, "c1", 0),
        readStarted(3, "c2", "/src/b.ts"),
        readCompleted(4, "c2", 0),
        completed(5, "done"),
      ],
      false,
    );

    expect(
      turns[0].work.filter((item) => "kind" in item && item.kind === "tool_group"),
    ).toHaveLength(1);
  });
});
