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
| `tool_kinds.jsonl` | One turn asked to run every tool it has: `webSearch`, `imageView`, `mcpToolCall`, `subAgentActivity` and `collabAgentToolCall` beside the `commandExecution` the others already cover. Every one of those used to draw nothing. See below. |
| `command_approval.jsonl` | The approval round trip — `item/commandExecution/requestApproval`, our `{"decision":"accept"}`, and the `serverRequest/resolved` that retires it. The only capture of `availableDecisions`, which here offers `accept`, `acceptWithExecpolicyAmendment` and `cancel` and **no `decline`**: the server names the options, we do not infer them. |

`tool_kinds.jsonl` is the odd one out: an agent asked to run each of its tools
once, so it pins the *item vocabulary* rather than a lifecycle. It carries
`webSearch`, `imageView`, `mcpToolCall`, `subAgentActivity` and
`collabAgentToolCall` — every kind that used to land in `ThreadItem::Other` and
draw nothing. Three things in it are worth knowing:

- **`webSearch` arrives twice and the first one is empty**, with `query: ""` and
  `results: null`. The null is what makes `null_as_default` load-bearing here
  and not just careful — `#[serde(default)]` alone failed the line, so a search
  drew no row at all.
- **It is not the only web search.** A session running under the ChatGPT
  connectors searches through an `extension` item with `kind: "web.search"`
  instead, carrying the same query and results. That route is not in this
  capture — it came off a real user session — and handling either alone draws
  half the searches a reader makes.
- **`mcpToolCall` disagrees with itself across captures.** This one carries
  `appContext`/`pluginId`/`durationMs`; a connector-driven session carried
  `connectorId`/`appName`/`duration{secs,nanos}`. Hence `result` stays a whole
  `Value` rather than being read field by field.
- **It carries a second thread.** The subagent's 16 lines sit interleaved with
  the main conversation's 222, told apart by `threadId` alone — its own
  `turn/started`, its `agentMessage` ("One, two, three."), its token usage and
  its `turn/completed`. That is the whole of what
  `a_subagents_thread_is_filed_under_its_spawn` reads.
- **It stops mid-main-turn, and the test depends on that.** The capture was cut
  before the main `turn/completed` arrived, so the *only* close in it is the
  subagent's — which makes "the main conversation closes zero turns" the sharp
  assertion rather than the weak one. Re-capturing this scenario to completion
  would make that test pass for the wrong reason; give the recapture its own
  file, or move the assertion to count closes per thread.

## Not captured yet

Named because each one settles an open question in
[CODEX.md](../../../../CODEX.md), and guessing at them is what the captures
exist to stop: a subagent that **fails** (only `started` and `completed` are
captured, so the `failed` kind is written against the pattern rather than
against a line), `git` inside a linked worktree under `workspace-write`,
`item/tool/requestUserInput` without the experimental capability, and an MCP
elicitation.
