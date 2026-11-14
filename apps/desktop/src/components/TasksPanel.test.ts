import { describe, expect, it } from "vitest";

import { taskRuns } from "@/components/TasksPanel";
import type { CrewRow } from "@/lib/crew";
import type { PrMark, SessionIndexItem } from "@/types/events";

const row = (sessionId: string, state: Partial<CrewRow> = {}, flags: Partial<SessionIndexItem> = {}): CrewRow => ({
  item: { sessionId, ...flags } as SessionIndexItem,
  busy: false,
  asking: false,
  unread: false,
  background: false,
  ...state,
});

const mark = (over: Partial<PrMark> = {}): PrMark => ({
  number: 1,
  url: "",
  headRefName: "b",
  isDraft: false,
  state: "OPEN",
  checksState: "CLEAR",
  mergeable: "MERGEABLE",
  mergeStateStatus: "CLEAN",
  reviewDecision: null,
  ...over,
});

const ids = (runs: CrewRow[][]) => runs.map((run) => run.map((r) => r.item.sessionId));

const none = () => undefined;

describe("taskRuns", () => {
  it("keeps a waiting task above a newer idle one in a list too short to split", () => {
    const { runs } = taskRuns([row("idle"), row("ask", { asking: true })], none);
    expect(ids(runs)).toEqual([["ask", "idle"]]);
  });

  it("breaks between states, idle above working", () => {
    const { runs } = taskRuns([
      row("idle1"),
      row("busy", { busy: true }),
      row("idle2"),
      row("ask", { asking: true }),
      row("old", {}, { aside: true }),
    ], none);
    expect(ids(runs)).toEqual([["ask"], ["idle1", "idle2"], ["busy"], ["old"]]);
  });

  it("files a task with background work under working", () => {
    const { runs } = taskRuns([row("idle1"), row("idle2"), row("bg", { background: true }), row("busy", { busy: true })], none);
    expect(ids(runs)).toEqual([["idle1", "idle2"], ["bg", "busy"]]);
  });

  it("lets single rows in neighbouring states share a break", () => {
    const { runs } = taskRuns([row("busy", { busy: true }), row("idle"), row("ask", { asking: true })], none);
    expect(ids(runs)).toEqual([["ask", "idle", "busy"]]);
  });

  it("leads pinned rows out of the runs, not counting them toward a split", () => {
    const { pinned, runs } = taskRuns([
      row("pin", {}, { pinned: true }),
      row("idle"),
      row("busy", { busy: true }),
    ], none);
    expect(pinned.map((r) => r.item.sessionId)).toEqual(["pin"]);
    expect(ids(runs)).toEqual([["idle", "busy"]]);
  });

  it("leads with needs you, then ready to merge, then about to be ready, then idle, then working", () => {
    const prs: Record<string, PrMark> = {
      ready: mark(),
      readyBusy: mark(),
      running: mark({ checksState: "RUNNING", mergeStateStatus: "BLOCKED" }),
      review: mark({ reviewDecision: "REVIEW_REQUIRED", mergeStateStatus: "BLOCKED" }),
      failing: mark({ checksState: "FAILING", mergeStateStatus: "BLOCKED" }),
      draft: mark({ isDraft: true, checksState: "RUNNING" }),
      merged: mark({ state: "MERGED", mergeable: null, mergeStateStatus: null }),
    };
    const { runs } = taskRuns(
      [
        row("busy", { busy: true }),
        row("failing"),
        row("merged"),
        row("running"),
        row("draft"),
        row("readyBusy", { busy: true }),
        row("ready"),
        row("review"),
        row("ask", { asking: true }),
      ],
      (r) => prs[r.item.sessionId],
    );
    expect(ids(runs)).toEqual([
      ["ask"],
      ["readyBusy", "ready"],
      ["running", "review"],
      ["failing", "merged", "draft"],
      ["busy"],
    ]);
  });
});
