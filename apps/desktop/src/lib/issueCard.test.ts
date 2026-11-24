import { describe, expect, it } from "vitest";

import { botItems } from "@/lib/botTranscript";
import { approvalsKey, issueApprovals, rowRef, rowState } from "@/lib/issueCard";
import { buildTranscript } from "@/lib/transcript";
import type { AgentEvent, IssueCardRow } from "@/types/events";

let seq = 0;
const event = (payload: object): AgentEvent =>
  ({ id: `e${seq}`, sessionId: "s", harness: "claude_code", seq: seq++, ts: "", turnId: null, subagent: null, payload }) as AgentEvent;

const bug = { name: "bug", color: "#d73a4a" };
const ready = { name: "Ready", color: "#0e8a16" };
const row = (number: number, labels = [bug]): IssueCardRow => ({ number, title: `Issue ${number}`, url: `u${number}`, closed: false, labels });
const card = () => event({ type: "issue_card", repo: "acme/app", issues: [row(1), row(2), row(3, [ready])] });
const approve = (cardId: string, number: number) =>
  event({ type: "issue_approved", cardId, number, labels: [bug, { name: "ready", color: "#0e8a16" }] });

describe("issue card approvals", () => {
  it("reads each card's approvals with the labels they left", () => {
    const one = card();
    const other = card();
    const approvals = issueApprovals([one, approve(one.id, 2), other, approve(other.id, 1)]);
    expect([...approvals.get(one.id)!.keys()]).toEqual([2]);
    expect(approvals.get(one.id)!.get(2)!.map((l) => l.name)).toEqual(["bug", "ready"]);
    expect(approvalsKey(approvals)).toBe(`${one.id}:2;${other.id}:1`);
  });

  it("counts a row approved here, or already labelled ready", () => {
    const one = card();
    const approved = issueApprovals([one, approve(one.id, 2)]).get(one.id);
    expect(rowState(row(1), approved).approved).toBe(false);
    expect(rowState(row(2), approved)).toEqual({ approved: true, labels: [bug, { name: "ready", color: "#0e8a16" }] });
    expect(rowState(row(3, [ready]), undefined).approved).toBe(true);
  });

  it("opens a row by GitHub's owner/repo#n", () => {
    expect(rowRef("acme/app", row(4)).identifier).toBe("acme/app#4");
  });
});

describe("where an issue card draws", () => {
  it("is a card in a bot's chat, and its approval no row", () => {
    const one = card();
    const items = botItems([one, approve(one.id, 1)]);
    expect(items.map((i) => i.kind)).toEqual(["card"]);
  });

  it("sits outside the turn's work in a task's chat", () => {
    const prompt = event({ type: "user_message", text: "list", images: [], issues: [], baseline: null, queued: false, from: null, cwd: null });
    const one = card();
    const { turns } = buildTranscript([prompt, one, approve(one.id, 1)]);
    const turn = turns[turns.length - 1];
    expect(turn.cards.map((c) => c.id)).toEqual([one.id]);
    expect(turn.work).toEqual([]);
  });
});
