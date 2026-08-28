# Codex fixtures

Real `codex app-server` stdio, captured **both directions**, one JSON object per
line: `{"dir": "in" | "out" | "err", "line": "<the raw JSON-RPC line>"}`.

The wrapper is what makes these different from the Claude Code fixtures next
door. app-server is a peer, so a capture that recorded only what the server said
would lose half the protocol — an approval is a request *we answer*, and the
answer is what the next line depends on.

Captured against **`codex-cli 0.148.0-alpha.21`**, the binary bundled at
`/Applications/ChatGPT.app/Contents/Resources/codex`. Home paths are rewritten
to `/Users/dev`; nothing else is edited. Re-capture against a newer CLI by
driving the same three scenarios and naming the new version here.

| file | what it pins |
|---|---|
| `simple_turn.jsonl` | The whole lifecycle at its smallest: handshake, `thread/start`, one turn, one `agentMessage`. Also the only capture where `last` and `total` token usage agree, because it is a single-call turn — which is exactly why it could not settle which one the ring reads. |
| `multi_call_turn.jsonl` | A three-call turn, and the one that *did* settle it: `total` runs 15593 → 31298 → 47083 while `last` runs 15593 → 15705 → 15785. Also the only capture of `phase: "commentary"` beside `phase: "final_answer"`. |
| `command_approval.jsonl` | The approval round trip — `item/commandExecution/requestApproval`, our `{"decision":"accept"}`, and the `serverRequest/resolved` that retires it. The only capture of `availableDecisions`, which here offers `accept`, `acceptWithExecpolicyAmendment` and `cancel` and **no `decline`**: the server names the options, we do not infer them. |

## Not captured yet

Named because each one settles an open question in
[CODEX.md](../../../../CODEX.md), and guessing at them is what the captures
exist to stop: a subagent (`collabToolCall`) turn, `git` inside a linked
worktree under `workspace-write`, `item/tool/requestUserInput` without the
experimental capability, and an MCP elicitation.
