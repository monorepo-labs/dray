// Real content only: the two long agent replies the Claude Code fixtures carry,
// and the plan docs agents wrote for this repo, which hold the tables, fences,
// lists and links a long reply does. Read by path, so `test:affected` counts a
// change to any of them against this file.
import complexLog from "../../src-tauri/src/harness/claude_code/fixtures/complex.jsonl?raw";
import multiTurnLog from "../../src-tauri/src/harness/claude_code/fixtures/multi_turn.jsonl?raw";
import codexDoc from "../../CODEX.md?raw";
import filesPlan from "../../FILES-PLAN.md?raw";
import sshPlan from "../../SSH-PLAN.md?raw";
import readme from "../../../../README.md?raw";

/// The longest assistant text block in a Claude Code stream-json log.
function longestReply(log: string): string {
  let best = "";
  for (const line of log.split("\n")) {
    if (!line.includes('"type":"assistant"')) continue;
    try {
      const content = JSON.parse(line).message?.content ?? [];
      for (const block of content) {
        if (block.type === "text" && block.text.length > best.length) best = block.text;
      }
    } catch {
      // Not a whole line; the fixtures are captured as written.
    }
  }
  return best;
}

export const REPLIES: { name: string; text: string }[] = [
  { name: "complex.jsonl reply", text: longestReply(complexLog) },
  { name: "multi_turn.jsonl reply", text: longestReply(multiTurnLog) },
  { name: "CODEX.md", text: codexDoc },
  { name: "FILES-PLAN.md", text: filesPlan },
  { name: "SSH-PLAN.md", text: sshPlan },
  { name: "README.md", text: readme },
];

/// A long transcript: every reply, twice over.
export const TRANSCRIPT = [...REPLIES, ...REPLIES].map((r) => r.text);

/// What is streamed: an agent reply followed by a plan with tables and fences,
/// as one message.
export const STREAMED = `${REPLIES[0].text}\n\n${filesPlan}`;
