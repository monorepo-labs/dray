import { describe, expect, it } from "vitest";

import { taskRuns } from "@/components/TasksPanel";
import type { CrewRow } from "@/lib/crew";
import type { SessionIndexItem } from "@/types/events";

const row = (sessionId: string, state: Partial<CrewRow> = {}, flags: Partial<SessionIndexItem> = {}): CrewRow => ({
  item: { sessionId, ...flags } as SessionIndexItem,
  busy: false,
  asking: false,
  unread: false,
  background: false,
  ...state,
});

const ids = (runs: CrewRow[][]) => runs.map((run) => run.map((r) => r.item.sessionId));

describe("taskRuns", () => {
  it("keeps a waiting task above a newer idle one in a list too short to split", () => {
    const { runs } = taskRuns([row("idle"), row("ask", { asking: true })]);
    expect(ids(runs)).toEqual([["ask", "idle"]]);
  });

  it("breaks between states, single needs-you and working rows sharing one", () => {
    const { runs } = taskRuns([
      row("idle1"),
      row("busy", { busy: true }),
      row("idle2"),
      row("ask", { asking: true }),
      row("old", {}, { aside: true }),
    ]);
    expect(ids(runs)).toEqual([["ask", "busy"], ["idle1", "idle2"], ["old"]]);
  });

  it("files a task with background work under working", () => {
    const { runs } = taskRuns([row("idle1"), row("idle2"), row("bg", { background: true }), row("busy", { busy: true })]);
    expect(ids(runs)).toEqual([["bg", "busy"], ["idle1", "idle2"]]);
  });

  it("leads pinned rows out of the runs, not counting them toward a split", () => {
    const { pinned, runs } = taskRuns([
      row("pin", {}, { pinned: true }),
      row("idle"),
      row("busy", { busy: true }),
    ]);
    expect(pinned.map((r) => r.item.sessionId)).toEqual(["pin"]);
    expect(ids(runs)).toEqual([["busy", "idle"]]);
  });
});
