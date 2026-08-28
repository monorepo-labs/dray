# Codex as a second harness, over `codex app-server`

Architecture plan. Written against the app-server README and the v2 protocol
types checked out at `codex-rs/`, and against Dray as of `main` at `f095e2a7`.

**Captured live against `codex-cli 0.148.0-alpha.21`** — the binary bundled at
`/Applications/ChatGPT.app/Contents/Resources/codex`, which on this machine is
the only `codex` there is. Captures live outside the repo at
`/tmp/codex-probe/*.jsonl`; §9 says what to commit and how.

## What the live captures corrected

The README is not a reliable source for wire values. Every item here was
verified by running the protocol, and four of them contradict the docs.

| | README says | wire says |
|---|---|---|
| `sandbox` | `workspaceWrite` | **`workspace-write`** — kebab-case, and a camelCase value is refused outright with `unknown variant` |
| approval policy | `unlessTrusted` | **`untrusted`**, `on-request`, `never`, `{granular}` |
| `turn/completed` | "carries an empty `items` array" | carries the **full item list** with `itemsView: "summary"` |
| approval options | inferred by the client | **`availableDecisions`** names them, and it is not always the whole set — the capture offers `accept`, `acceptWithExecpolicyAmendment`, `cancel`, and no `decline` |

And four things the docs do not say at all:

- **`thread/tokenUsage/updated` carries both `total` and `last`.** Across a
  three-call turn `total` ran 15593 → 31298 → 47083 while `last` ran
  15593 → 15705 → 15785. `total` is cumulative across model calls — the exact
  trap CLAUDE.md documents for Claude's `result.usage`, which "reports context
  multiplied by number of steps". **`last` is the context occupancy.** The same
  payload carries `modelContextWindow` (258400), so the ring needs no
  per-model window table and none of the sum-four-disjoint-counts rule Claude
  needs. This settles the open question the plan opened with.
- **`agentMessage` carries `phase`**: `commentary` for the running narration,
  `final_answer` for the answer. Claude has no equivalent.
- **`userMessage` is echoed back as an item.** Confirmed, and it is why the
  mapper must drop it — Dray mints its own with `baseline`, `images` and
  `issues`, none of which the echo carries.
- **Server-initiated request ids start at 0** and live in their own id space,
  independent of ours. The client's pending map must be keyed on our own
  counter only.

Shapes confirmed as usable directly: `thread/status/changed`
(`{type: active, activeFlags: []}` / `{type: idle}`),
`account/rateLimits/updated` (`usedPercent`, `resetsAt`, `planType`,
`rateLimitReachedType`), `turn/completed.durationMs`, and
`serverRequest/resolved` firing immediately after a reply.

Still unverified, and §11 says what settles each: subagent routing, git inside
a linked worktree, `requestUserInput` without the experimental capability.

## TLDR for human

- Keep Dray's session id as the primary key. Store Codex's thread id as one
  new `#[serde(default)]` field on the index entry. Nothing else about identity
  changes.
- One `codex app-server` process per session, same shape as today.
- A JSON-RPC client lives in `harness/codex/rpc.rs`. Nothing shared with Claude
  Code yet; the generic part is small and lifts out when a second JSON-RPC
  harness exists.
- Zero new `AgentEventPayload` variants for the first three slices. Every
  Codex item has a home in the existing vocabulary, and the gaps are dropped
  on purpose.
- Approvals map onto `PermissionRequested` with the decision payload held in
  Rust, exactly as Claude's rules are. `requestUserInput` maps onto
  `QuestionsAsked`. MCP elicitation forms are refused, not rendered, in the
  first pass.
- Worktrees use the `create_worktree` path Dray already has for `--from`.
  Codex always takes it, so its baseline is exact where Claude's is a guess.
- The three Codex fixtures on disk are the wrong protocol and get deleted.
  Capture `codex app-server` stdio, both directions, per scenario.
- Four things in Dray should change to make room, all in `session.rs` and
  `permissions.rs`, all refactors Claude's tests can pin: shared ingest step,
  harness-neutral transport handle, harness on `deliver_prompt`, generic
  pending-permission reply.

---

## 1. What app-server is, in Dray's terms

Claude Code is a one-way pipe with a control side-channel bolted on. app-server
is a JSON-RPC peer: both sides send requests, both sides answer. Three things
follow, and the rest of this document is working them through.

1. **Our sends are requests with responses.** `turn/start` answers with a turn
   id. `thread/start` answers with a thread id. Today `send_msg` writes a line
   and forgets it; here it has to wait for an answer, and the answer carries
   the ids everything after is keyed on.
2. **Their questions are requests too.** An approval is a JSON-RPC request
   with an `id` we must answer, not a line with a `request_id` field. Same
   consequence as Claude's `can_use_tool` — silence stalls the turn — but the
   reply is the JSON-RPC response to that id, and an unknown request must get
   a JSON-RPC *error*, not nothing.
3. **Everything is scoped by thread and turn.** Every notification carries
   `threadId`; most carry `turnId`. Claude gives us neither. This is what makes
   `turn_id` on `AgentEvent` non-`None` for the first time.

The stable surface is enough. Nothing in the first four slices needs
`capabilities.experimentalApi`. Two things it would buy are named where they
come up (`thread/settings/update`, `thread/backgroundTerminals/*`), and both
have a stable route that costs one more round trip.

```
   Dray (Rust)                              codex app-server (child, one per session)
   ───────────                              ─────────────────────────────────────────
   initialize ─────────────────────────────▶
   ◀───────────────────────────────────────  {result: {userAgent, codexHome, …}}
   initialized (notification) ─────────────▶
   thread/start {cwd, model, approvalPolicy}▶
   ◀───────────────────────────────────────  {result: {thread: {id: "019f…"}}}   ← recorded on the index entry
   ◀───────────────────────────────────────  thread/started (notification)
   turn/start {threadId, input: [text]} ───▶
   ◀───────────────────────────────────────  {result: {turn: {id: "turn_…"}}}
   ◀───────────────────────────────────────  turn/started
   ◀───────────────────────────────────────  item/started {reasoning}
   ◀───────────────────────────────────────  item/reasoning/summaryTextDelta …
   ◀───────────────────────────────────────  item/completed {reasoning}
   ◀───────────────────────────────────────  item/started {commandExecution}
   ◀───────────────────────────────────────  item/commandExecution/requestApproval  {id: 7}   ← server REQUEST
   {id: 7, result: {decision: "accept"}} ──▶
   ◀───────────────────────────────────────  serverRequest/resolved {requestId: 7}
   ◀───────────────────────────────────────  item/commandExecution/outputDelta …
   ◀───────────────────────────────────────  item/completed {commandExecution}
   ◀───────────────────────────────────────  item/started {agentMessage}
   ◀───────────────────────────────────────  item/agentMessage/delta …
   ◀───────────────────────────────────────  item/completed {agentMessage}
   ◀───────────────────────────────────────  thread/tokenUsage/updated
   ◀───────────────────────────────────────  turn/completed {status: "completed"}
```

## 2. Session identity

### The problem, precisely

`ThreadStartParams` has no client-supplied id. `thread/start` mints one and
returns it. Dray mints its session id in the frontend (`crypto.randomUUID()`)
before anything is spawned, and that id is:

- the index entry's key and `sessions/<id>.jsonl`'s filename
- `attachments/<id>/`, written *before* the prompt is sent
- `DRAY_SESSION_ID` in the child's env, and the address `dray send` uses
- `parent_session_id`, `fork_from`, and what `dray new --from <id>` resolves
- what `handleSendMsg` selects optimistically while the create is in flight

Every one of those is written before the child answers. That ordering is
deliberate: CLAUDE.md says a session is indexed before spawn so one that
fails to start is still visible, and the fork copies the log under the new id
before the CLI has heard of it.

### Decision: Dray's id stays primary; the thread id is a mapping

Add one field to `SessionIndexItem`:

```
/// Codex's own id for this conversation, recorded from the `thread/start`
/// (or `thread/fork`) response. `None` until that response lands, and forever
/// for a Claude Code session. What `thread/resume` is handed on the next spawn.
#[serde(default)]
pub thread_id: Option<String>,
```

Written the moment `thread/start` returns, before the first `turn/start` goes
out. Read by exactly one thing: the resume path.

**What each feature does under this choice:**

| feature | what happens |
|---|---|
| log filename, attachments dir | Dray id, unchanged |
| `session_branch`, `--from` | resolve session → branch off the index entry, unchanged; they never touch the thread |
| `DRAY_SESSION_ID`, `dray send` | Dray id, unchanged — one address space across harnesses |
| resume (process gone, id known) | spawn, `initialize`, `thread/resume {threadId: item.thread_id}` |
| resume with `thread_id: None` | the create died between index write and `thread/start` answering. Treat as a fresh `thread/start` — same shape as Claude's "no conversation found", but recoverable |
| fork | unchanged on Dray's side: copy log, write entry with `fork_from`. On first send: look up parent's `thread_id`, call `thread/fork {threadId}`, record the *new* thread id on the fork's entry, clear `fork_from`. Refused while parent busy, same guard — and app-server would otherwise "snapshot as if interrupted", which is a worse outcome than a refusal |
| delete | `thread/delete {threadId}` best effort if a child is live, else nothing. Claude's transcript under `~/.claude/projects` is not deleted today either, so leaving the rollout is consistent; the call is cheap and the process is already there when it is |
| orchestration `create_session` | returns Dray id immediately, unchanged. Thread id lands later in the index; nothing over the socket reads it |

**Cost:** one more nullable field, and one window — between index write and
`thread/start` answering — where a Codex thread can exist that Dray has
forgotten. The orphan is a rollout file in `~/.codex/sessions`; the session
recovers by starting a new thread. Acceptable.

### The alternative, and what it breaks

Adopting Codex's id as the session id means the id is not known until
`thread/start` answers. `thread/start` is fast (no model call, tens of ms), so
one could make creation synchronous and mint nothing on the frontend. What
that costs:

- `handleSendMsg` selects the session it just created by the id it minted. It
  would have to wait for the create to answer before selecting, and the
  composer already has a rule that selection is optimistic until its own read
  lands.
- Index-before-spawn goes: the entry cannot be written without an id, so a
  session whose child fails to start vanishes without a trace — the exact case
  the current ordering exists for.
- Attachments are copied under the session dir before send. They would need
  a temp dir and a rename after the id arrives.
- Fork copies the log ahead of the CLI. Codex's `thread/fork` answers fast too,
  but now the fork is eager, not lazy — a child process per fork, which
  CLAUDE.md rejected for cost.
- The two harnesses would mint ids in two places by two rules. Claude keeps
  frontend-minted; Codex server-minted. `dray` would still work (both are
  UUIDs), but every "who mints the id" comment in the codebase would need a
  second sentence.

Nothing is gained that the mapping does not also give. Rejected.

**Upstream ask worth making:** a `threadId` field on `ThreadStartParams`, as
`--session-id` is for Claude. `thread/start` already accepts `path` and
`ephemeral`; a client-chosen id is a small addition. If it lands, the mapping
field stays (old sessions have it) and new sessions get `thread_id ==
session_id`.

### Thread ids from other threads

The connection can carry notifications for threads that are not ours:
`review/start` with `delivery: detached` emits `thread/started` for a new
review thread; `collabToolCall` `spawn_agent` creates child threads. The read
loop must treat `threadId != our thread_id` as a routing question, not drop
those lines. Section 5 (subagents) says where they go.

## 3. Process model

### Decision: one `codex app-server` per session

Same shape as today. `Session` owns a `Child`; kill is kill; "no child survives
a restart" holds without a second thought.

Why not one shared process:

- **Blast radius.** A shared child dying flips every Codex session to `idle`
  at once, and `read_stdout`'s "mint empty `background_tasks_changed` on
  exit" logic would have to fan out to every session on the connection.
- **The restart assumption.** `has_outstanding_work` guards every child-
  replacing path: effort respawn, fork, update install. With one child per
  session those guards are per session. With a shared child, "replace the
  child" means "replace every session's child", and the guard has to read
  every tracker.
- **Connection-scoped things.** `command/exec/outputDelta`, `process/*`,
  `fs/watch` are all connection-scoped; the server kills those processes when
  the connection closes. Per session this is what we want. Shared, one
  session's teardown is another's lost background job.
- **`initialize` is per connection and unrepeatable.** Capabilities are
  negotiated once for the process lifetime. Per session means a session can
  opt into something the next one doesn't need.
- **Environment.** `DRAY_SESSION_ID` and `DRAY_ENDPOINT` are injected into the
  child's env (orchestration). A shared process has one env.

What it costs: one process per open session, each loading config, each
starting the MCP servers `config.toml` declares (app-server starts them per
thread anyway, so this is a wash). Claude Code costs the same today. Idle
Codex sessions keep their process like idle Claude sessions do — the server
unloads an unsubscribed thread after 30 minutes, but a process with one
subscribed thread never hits that.

If memory bites later, the middle path is one process per *project*, not one
global. Not now.

**Codex's own subagents run inside our process.** `spawn_agent` creates threads
in the same app-server. Killing the child kills them, which is what Stop should
mean. Good, and worth knowing: it is the one place "one process per session"
holds more than one conversation.

### Spawn

`codex app-server` with stdio, cwd = the session's tree (or project root, see
worktrees), env with `PATH` put back (`agent_path()`), `DRAY_SESSION_ID`,
`DRAY_ENDPOINT`. Binary through `binpath.rs` like `claude` and `gh`:
inherited `PATH`, then known dirs (`~/.local/bin`, `~/.bun/bin`,
`~/.npm-global/bin`, Homebrew, nvm globs), then `$SHELL -l -c 'command -v
codex'`. Missing binary = one readable error at send, never a spawn error.

`initialize` with `clientInfo: {name: "dray", title: "Dray", version}`. The
README says `clientInfo.name` feeds OpenAI's compliance logs and enterprise
clients should register the name. Note it; do nothing yet.

`initialize` also takes `optOutNotificationMethods`. Opt out of nothing at
first — every line we don't want costs a `None` from the mapper, and the
failure log is the coverage signal. Revisit once captures show what is noise
(`rawResponseItem/completed` if it fires, `turn/diff/updated` — see §5).

## 4. The JSON-RPC client

### Where it lives

`harness/codex/rpc.rs`. Not a shared module yet.

The brief's observation is right: `control.rs` + `permissions.rs` are half of
a request/response layer already. But they are half of a *different* one.
Claude's control channel is its own envelope (`type: control_request`,
`request_id` as a UUID string, double-wrapped responses), not JSON-RPC, and it
has exactly one inbound request kind. Making it consume a generic client
means adapting two working modules to an abstraction with one real user.
CLAUDE.md's rule for `packages/`: create the shared thing when the second
user exists. Same rule here.

The generic core is ~150 lines: an id counter, a pending map, a demux. When a
second JSON-RPC harness arrives (ACP, or Gemini's), lift that into
`harness/jsonrpc.rs`. The Codex-specific typing stays behind.

### Shape

```
                         ┌──────────────────────────────────────────┐
  Session::send_msg ────▶│ RpcClient                                 │
  respond_permission ───▶│   request(method, params) -> Future<Value>│──▶ writer task ──▶ child stdin
  interrupt ────────────▶│   notify(method, params)                  │      (mpsc)
                         │   respond(id, result | error)             │
                         │                                           │
  child stdout ──▶ reader task ──▶ demux:                            │
                         │   id + method  → ServerRequest  ──────────┼──▶ handler (registers pending, emits event, or errors)
                         │   method only  → Notification   ──────────┼──▶ parser → mapper → ingest
                         │   id only      → Response       ──────────┼──▶ pending map → oneshot
                         └──────────────────────────────────────────┘
```

- **One writer task, one mpsc.** Replaces `Arc<Mutex<ChildStdin>>` for this
  harness. Sends, approval replies, interrupts and steers all write; a queue
  keeps them from interleaving and the reader task can reply to a server
  request without holding a lock across the line.
- **Pending map:** `HashMap<i64, oneshot::Sender<Result<Value, RpcError>>>`.
  Outbound ids are integers, monotonic per process. A response for an unknown
  id is filed as a parse failure (`stage: "stray_response"`), never panicked
  on.
- **Requests carry a timeout only where a wedged server would otherwise wedge
  the app.** `initialize`, `thread/start`, `thread/resume`, `thread/fork` get
  one (spawn-and-answer, a few seconds). `turn/start` answers in ms too but
  its *turn* runs unbounded, and the response is not the turn. Approval
  replies and `turn/interrupt` are fire-and-await with the process's own
  lifetime as the bound.
- **Backpressure:** `-32001 "Server overloaded; retry later."` is documented
  as retryable. Retry `turn/start` with jittered backoff, three tries; report
  the last error as an `Error{fatal: false}` event. Nothing else retries.
- **Server requests** demux to a handler that does one of three things:
  1. Registers a pending entry and emits an event (approvals, questions,
     `mcp_tool_call` elicitations) — the reply comes later from
     `respond_permission`/`answer_questions`.
  2. Answers on the spot from inside the reader task (a form elicitation this
     build can't draw → `{action: "decline", content: null}`; anything
     unmodelled → JSON-RPC error `-32601`). Filed as `unsupported_request`,
     same stage Claude's refusal uses, same reason: it is the only stage that
     changes what the agent does.
  3. Requests gated on capabilities we never declare (`attestation/generate`,
     `currentTime/read`, `account/chatgptAuthTokens/refresh`) should never
     arrive. If one does, (2) covers it.
- **`serverRequest/resolved`** retires a pending entry if still present and
  mints `PermissionDecided{automatic: true}` — the exact `control_cancel_request`
  path. If the entry is already gone (we answered), it is nothing.

### Wire types

Hand-written serde, subset only, `#[serde(other)]` on every enum that can
grow — the `parser.rs` conventions. Not a git dependency on
`codex-app-server-protocol`: it drags `codex-protocol` and a chunk of core, and
its types are shaped for the server (`AbsolutePathBuf`, `LegacyAppPathString`,
double-option serde helpers) rather than for reading.

Keep the generated schema around as a *diff reference*, not as source:
`codex app-server generate-json-schema --out` for the captured version, stored
outside the repo (it is large and per-version). When bumping the supported
Codex version, regenerate and diff. The fixture directory's README names the
version every capture was taken against.

`ServerRequest` and `ServerNotification` each become an enum tagged on
`method`; params stay typed for the variants we read and `Value` for the ones
we only need to route (`turn/diff/updated`, `model/*`). A method neither enum
knows lands in a catch-all variant carrying the method name, mapped to `None`
and filed as `unknown_method`.

### What changes in `session.rs`

Four changes. Each is a refactor Claude's existing tests pin.

1. **`Session.stdin` becomes harness-neutral.** Today it is
   `Arc<Mutex<ChildStdin>>`, shared with the stdout task because Claude's
   reader must refuse unsupported requests. For Codex the reader holds the
   `RpcClient`. Proposed: `enum Transport { Lines(Arc<Mutex<ChildStdin>>),
   Rpc(RpcClient) }` on `Session`, and every method that writes
   (`send_msg`, `set_model`, `interrupt`, `stop_task`, `set_permission_mode`,
   `respond_permission`, `answer_questions`) dispatches on it. `write_line`
   stays for the `Lines` arm.
2. **The harness-agnostic half of `read_stdout` lifts into `session.rs`.**
   Everything after the mapper — freezing `head` on `TurnCompleted`,
   `archive_result_images`, `at_boundary` and the queued flush, emit, status
   tracker, the not-persisted set, `append_session_event` — knows nothing
   about Claude. Today it sits in `claude_code.rs` because there was one
   reader. Two readers = one `ingest(agent_event)` in `session.rs` both call,
   or the persistence rules drift by harness. This is the biggest single
   change and worth doing *before* any Codex code, as slice 0.
3. **`deliver_prompt` takes the harness.** It hardcodes `harness: ClaudeCode`
   on the `UserMessage` it mints. Wrong for Codex on every prompt. Also
   the write itself branches: `Lines` writes the stream-json user line, `Rpc`
   calls `turn/start` (or `turn/steer`, §8) and waits for the turn id.
4. **`PendingRequest.options` carries a harness-neutral reply.** Today
   `ResolvedOption.updates: Vec<PermissionUpdate>` is Claude's type. Codex's
   reply is a `decision` value. Make the stored reply a
   `serde_json::Value` built by the harness when the entry is registered, and
   `respond_permission` sends it verbatim on the harness's own channel. The
   frontend contract (`PermissionOption {id, label, kind, behavior}`) is
   untouched, and the rule — the rule never leaves Rust — holds harder: the
   reply is already fully formed the moment the button is offered.

`StatusTracker` needs nothing. `TurnStarted` → in progress, `TurnCompleted`
→ completed, and Codex emits one `turn/started` per turn including the
`thread/compact/start` turn. `thread/status/changed` is ignored: it is a second
opinion on a question the tracker already answers.

## 5. Event mapping

`turn_id` is set on every event inside a turn — the first harness to fill it.
`subagent` is `None` unless the line's `threadId` is a child thread we know
(below). `harness: Codex`.

### Items → payloads

| Codex | `AgentEventPayload` | notes |
|---|---|---|
| `thread/start` / `thread/resume` / `thread/fork` **response** | `SettingsChanged(Settings{model, approval_policy, sandbox, writable_roots, network_access})` | The one place Codex's effective stance is reported. `approval_policy` mapped best-effort onto `PermissionMode` (§6) |
| `thread/started` notification | `None` | The response above already said it |
| `turn/started` | `TurnStarted(SessionInfo{cwd, model, harness_version})` | Opens the model call for `StatusTracker`. Followed immediately by a synthesized `ModelRequestStarted` (below) |
| `turn/completed` `completed` | `TurnCompleted{status: Success, usage, duration_ms}` | `head` filled by ingest as today |
| `turn/completed` `failed` | `TurnCompleted{status: Error, final_text: error.message, stop_reason: codexErrorInfo}` | `final_text` is what the row draws; `stop_reason` is the wire token, never drawn — same rule as Claude's `stop_sequence` |
| `turn/completed` `interrupted` | `TurnCompleted{status: Success, stop_reason: "interrupted"}` | User's own Stop. Drawn as nothing, like `aborted_*`. **Not** a new `TurnStatus` variant: `TurnStatus` has no `#[serde(other)]`, so an old build reading a new variant drops the line, and a dropped `turn_completed` loses `head` for the changes panel |
| `item/started` `userMessage` | `None` | Dray mints its own `UserMessage` with `baseline` in `deliver_prompt`. The echo carries `clientId` = our `clientUserMessageId`; assert it matches in tests, draw nothing |
| `item/started` `agentMessage` | `Delta(BlockStart{block: {message_id: item.id, index: 0}, block_type: Text})` | Codex has no message/block split: one item = one block, index always 0 |
| `item/agentMessage/delta` | `Delta(TextDelta)` | Same `BlockRef` |
| `item/completed` `agentMessage` | `Delta(BlockStop)` then `AssistantText{block: Some(ref), text}` | Committed wins. `phase` and `memoryCitation` dropped |
| `item/started` `reasoning` | `Delta(BlockStart{Thinking})` | |
| `item/reasoning/summaryTextDelta` | `Delta(TextDelta)` | `summaryIndex` boundaries become `"\n\n"` in the accumulated text; `summaryPartAdded` maps `None` |
| `item/reasoning/textDelta` | `Delta(TextDelta)` | Raw reasoning (OSS models). Same block; a reader can't tell and shouldn't |
| `item/completed` `reasoning` | `Reasoning{text: summary.join("\n\n") or content.join, encrypted: both empty}` | `encrypted: true` is the existing "reasoning happened, nothing to show" flag — built for exactly this and never set by Claude |
| `item/started` `commandExecution` | `ToolCallStarted{call_id: id, name: "shell", tool_type, input: {command, cwd}, title: command}` | `tool_type` from `commandActions` when homogeneous: all `read` → `FileRead`, all `search` → `Search`, all `listFiles` → `FileRead`, else `Shell`. This is what lets "Read 3 files" group form for Codex. `source: userShell` → `name: "shell"` still, title prefixed `!` |
| `item/commandExecution/outputDelta` | `None` | See gaps. Modelled and parsed so the failure log stays quiet — the `tool_progress` treatment |
| `item/completed` `commandExecution` | `ToolCallCompleted{result: {text: aggregated_output, is_error: status != completed, exit_code, duration_ms}}` | `declined` → `is_error: true`, text `"declined"` if output empty |
| `item/started` `fileChange` | `ToolCallStarted{name: "apply_patch", tool_type: FileEdit, input: {changes}}` **and** `FileEdits{call_id: id, edits}` | `FileEdits` exists for this and is unused by Claude; `EventRow` renders it. `kind: update{move_path}` → `Update` with the move on `input` |
| `item/fileChange/patchUpdated` | `FileEdits` again, same `call_id` | Feature-gated on the server side; latest wins in the transcript. Not in slice 1 |
| `item/completed` `fileChange` | `ToolCallCompleted` | `failed`/`declined` → `is_error` |
| `mcpToolCall` started / completed | `ToolCallStarted{name: tool, title: "server · tool", tool_type: Mcp, input: arguments}` / `ToolCallCompleted{text: result content flattened, structured: result, images}` | Images archived by ingest as today |
| `webSearch` | `ToolCallStarted{name: "web_search", tool_type: Web, input: {query, action}}` + `ToolCallCompleted` at completion | Existing variant covers it. No new home needed |
| `imageView` | `ToolCallStarted{name: "view_image", tool_type: FileRead, input: {path}}` + `ToolCallCompleted{images: [ImageRef{path}]}` | The item carries a path, not bytes. Ingest would need a *copy-from-path* archive step beside `archive_result_images` so the transcript doesn't point at `/tmp`. Slice 4 |
| `sleep` | `None` | Parsed, dropped. "Agent is waiting" is what the working indicator already says |
| `plan` item | `AssistantText` | Model prose. The `<proposed_plan>` block is text the reader wants to read |
| `turn/plan/updated` | `ToolCallStarted{name: "update_plan", tool_type: Other, input: {explanation, plan}}` + immediate `ToolCallCompleted{text: ""}` | Synthesized pair, `call_id: "plan:<turnId>:<n>"`. `TodoWrite` already renders a checklist from the same shape. Dropping it loses the one thing Codex does that Claude's TodoWrite does |
| `contextCompaction` started / completed | `ContextCompactionStarted` / `ContextCompacted{trigger: None, pre_tokens: None, post_tokens: None}` | Counts absent on the wire. Every count is already `Option`; the UI drops the saving line rather than draws a wrong one. `compacted` (deprecated) → `None` |
| `enteredReviewMode` / `exitedReviewMode` | `None` / `AssistantText{text: review}` | Only reachable if Dray ever calls `review/start`. It doesn't, yet |
| `collabToolCall` | see subagents | |
| `subAgentActivity` | `SubagentProgress` | |
| `hookPrompt` | `None` | |
| `dynamicToolCall` | never arrives — we declare no `dynamicTools` | |
| `thread/tokenUsage/updated` | `UsageUpdate(Usage{…})` (not persisted) **and** remembered for the turn's `TurnCompleted.usage` | Below |
| `account/rateLimits/updated` | `RateLimited{…}` when `rateLimitReachedType` is set, else fold into `Usage.rate_limit` | Same "only when bad news" rule; `HEALTHY` = `rateLimitReachedType == null` |
| `error` `will_retry: true` | `ApiRetry{attempt: n, max_retries: 0, status: httpStatusCode, reason: codexErrorInfo}` | `n` = mapper's own count of will-retry errors in this turn. Codex reports no attempt count or ceiling. `max_retries: 0` = unknown; the indicator needs one frontend tweak to draw "retrying (3)" when the ceiling is zero |
| `error` `will_retry: false` | `Error{source: Harness, message, fatal: false}` | `turn/completed failed` follows and carries the sentence the row draws |
| `warning`, `configWarning`, `guardianWarning` | `Error{source: Harness, fatal: false}` | One row each. `deprecationNotice` → log only |
| `model/rerouted` | `SettingsChanged{model: toModel}` | The composer's model picker should say what is actually running |
| `model/safetyBuffering/updated`, `model/verification`, `turn/moderationMetadata` | `None` | Parsed so they don't pollute the failure log |
| `turn/diff/updated` | `None`, and not emitted | Dray's changes panel diffs two tree snapshots on purpose (CLAUDE.md, *Changes panel diff two snapshots*). This notification is the transcript-derived alternative that design rejected: it misses what a command did, and it never sees a mid-turn commit. Dropping it is the design, not a gap. Opt out via `optOutNotificationMethods` once captures confirm its volume |
| `thread/status/changed`, `thread/closed`, `thread/archived`, `thread/name/updated` | `None` | Status is the tracker's; naming is Dray's |
| `rawResponseItem/completed` | `None` | Only with `experimentalRawEvents` |

### Two synthesized events

- **`ModelRequestStarted`.** Codex has no "requesting" ping. The working
  indicator would fire at `turn/started` and never again, which is the exact
  bug CLAUDE.md describes fixing for Claude (indicator that only ever described
  the first wait). The mapper synthesizes one on `turn/started` and after every
  `item/completed` of a tool-ish item (`commandExecution`, `fileChange`,
  `mcpToolCall`, `webSearch`, `imageView`, `collabToolCall`) — the moments
  Claude's `status: requesting` fires. It is already in the not-persisted set.
- **`BackgroundTasksChanged`.** Codex has no task set on the wire. The mapper
  emits none, so `background_tasks` stays empty and `has_outstanding_work`
  reads the model call alone. Background terminals (a command started with
  `process_id` that outlives its item) are invisible to the tracker. Slice 4
  reads `thread/backgroundTerminals/list` (experimental) on `turn/completed`
  and republishes the set; until then, Stop = `turn/interrupt` alone.

### Context occupancy and the ring

Dray reads the ring back out of persisted events: `turn_completed.usage.
contextWindow` and `context_compacted.postTokens`. For Codex:

- `thread/tokenUsage/updated.tokenUsage.modelContextWindow` → `ContextWindow.max`.
- `used`: **uncertain**. `last` is "the last model call's usage"; its
  `input_tokens + cached_input_tokens` should be the prompt size of the final
  call, which is the occupancy reading Claude's `last_occupancy` derives. But
  whether `last` means the last *call* or the last *turn* is not stated.
  Capture a two-call turn and compare `last.input_tokens` against the
  reasoning from CLAUDE.md's *Used = one message's four counts summed*. Until
  settled, `used = last.input_tokens + last.cached_input_tokens`.
- `per_model` stays empty. `total` is session-cumulative and monotonic like
  `modelUsage`, but not split by model; one `ModelUsage` entry with the
  thread's model would be a guess. Leave it.
- `ContextCompacted` carries no counts, so after a compaction the ring goes
  to "unknown" until the next `tokenUsage/updated`, which Codex sends on the
  compaction turn's completion. Acceptable: the ring already treats
  `context_compacted` as settling `used` even with no count.

### Subagents

Codex's subagent is a thread. `collabToolCall` with `tool: spawnAgent` names
the new thread in `receiverThreadIds`; the child's own work arrives — *if it
arrives on our connection at all* — as ordinary `item/*` notifications with
`threadId` = the child. `subAgentActivity` items on the parent describe
lifecycle. Whether child-thread items reach us is **the one uncertainty that
decides the subagent design**, and a capture settles it:

- If they do: the reader keeps `HashMap<thread_id, call_id>` from spawn calls
  and fills `Subagent{id: call_id, label: agentNickname}` on the envelope for
  every line whose `threadId` is in the map. `id` = the spawning
  `collabToolCall`'s item id, matching Dray's rule that a subagent is
  correlated by the call that spawned it. Depth beyond one level (a child
  spawning) folds into the nearest known ancestor.
- If they don't: the subagent panel shows only what `subAgentActivity` and
  `agentsStates` say. Thin, but honest, and the same as Claude's subagent
  with no deltas.

Mapping either way:

| Codex | payload |
|---|---|
| `collabToolCall` `spawnAgent` started | `ToolCallStarted{tool_type: SubagentSpawn, name: "spawn_agent", input: {prompt, model}}` + `SubagentStarted{agent_id: receiverThreadId, label: nickname or thread id, prompt}` |
| `subAgentActivity` `started`/`interacted` | `SubagentProgress{agent_id, description: kind}` |
| `collabToolCall` `wait`/`closeAgent` completed | `SubagentCompleted{agent_id, status: agentsStates[id].status, summary: message}` for each id whose state is terminal |
| `collabToolCall` `sendInput`/`resumeAgent` | `ToolCallStarted{tool_type: Other}` + `Completed` |

`events.rs` already says "Codex uses `agent_path`" on `Subagent`. That was
written against `codex exec`; app-server's `SubAgentActivity` carries both
`agentThreadId` and `agentPath`. Use the thread id; the path is display.

### Gaps, both directions

**Codex → Dray, dropped on purpose:** `turn/diff/updated` (design), `sleep`,
safety buffering, moderation, verification, realtime, `fs/*`, `process/*`,
apps, plugins, hooks, goals, memory. None of these draw anything in Dray
today; each costs a parsed-and-`None` so the failure log stays a signal.

**Codex → Dray, no home and worth one later:**

- **Live command output** (`outputDelta`). Claude has no equivalent, so no row
  draws it. A `ToolCallProgress{call_id, text}` variant — emitted, never
  persisted, like `Delta` — is the shape. Slice 4 or later; the committed
  `aggregatedOutput` arrives either way.
- **Plan mode** (`collaborationMode`, experimental) and **review mode**
  (`review/start`). Both are turn *kinds*, not events. Dray's composer has no
  place to pick one. When it does, `enteredReviewMode` → a turn-kind marker;
  until then nothing sends one so nothing arrives.
- **`thread/name/updated`**: Codex can name threads. Dray owns titles. Ignore
  both ways.

**Dray → Codex, expressed differently:**

- **`ApiRetry`**: covered above; count is ours, ceiling unknown.
- **`BackgroundTasksChanged`**: no wire set; §4 synthesized-events note.
- **`PermissionDenied`** (the no-channel refusal): Codex under
  `approvalPolicy: never` doesn't refuse and report — the command runs in the
  sandbox and fails, surfacing as a failed `commandExecution`. No event; the
  row's own error shows it.
- **`Hook`**: `hookPrompt` items exist but describe prompt fragments, not
  hook runs. Drop.
- **Slash commands and `@file`**: neither exists on this wire. Codex has
  `$skill` (with a `skill` input item) and `mention` items for apps/plugins,
  and no file-mention injection. The `/` picker should list `skills/list` for
  Codex and send `$name` plus a `skill` item; the `@` picker either goes dark
  for Codex or inlines the path as text and lets the model read it. Slice 4.
- **Non-image attachments**: Claude's `@/abs/path` convention is Claude's
  parser. For Codex, append a plain line naming the file; images go as
  `localImage {path}` pointing at the archived copy — cheaper than base64 and
  no wire size limit to degrade around.

**No new variant in slices 0–3.** The log-evolution rules make adding one
safe (`Unrecognized` catches it in old builds), but every candidate above is
either not persisted (progress) or a turn kind Dray can't start yet.

## 6. Permissions

### Approvals → `PermissionRequested`

Every server request registers a `PendingRequest` keyed on the JSON-RPC id
(stringified; `RequestId` is int-or-string and Dray's `request_id` is a
string), emits one event, and holds the fully built reply per option. The
frontend picks an id; Rust sends what it built. Nothing about a decision ever
crosses to TypeScript.

**`item/commandExecution/requestApproval`:**

| option id | label | kind | reply |
|---|---|---|---|
| `once` | Allow once | `Once` | `{decision: "accept"}` |
| `session` | Allow for this session | `AlwaysRule` | `{decision: "acceptForSession"}` |
| `rule` | Always allow `<amendment command prefix>` | `AlwaysRule` | `{decision: {acceptWithExecpolicyAmendment: {execpolicy_amendment: proposed}}}` — only when `proposedExecpolicyAmendment` present |
| `net:<host>` | Always allow network to `<host>` | `AlwaysRule` | `{decision: {applyNetworkPolicyAmendment: …}}` — one per proposed amendment |
| `deny` | Deny | `Deny` | `{decision: "decline"}` |

`availableDecisions`, when present (experimental field, so absent for us),
would filter this list. `cancel` is not offered: it ends the turn, which is
what Stop does, and a fifth button on a consent card is one too many. Same
reading as Claude's `interrupt` on deny — present on the wire, not on the
card.

Fields onto the event: `tool_use_id: itemId`, `tool_name: "shell"`, `input:
{command, cwd, commandActions}`, `decision_reason: reason`,
`decision_reason_type: "networkAccess"` when `networkApprovalContext` is set
(then `input` carries `{host, protocol}` instead and the card says so),
`agent_id: threadId` when it's a child thread. Main-thread always, as today.

**`item/fileChange/requestApproval`:** `once` / `session` / `deny`; replies
`accept` / `acceptForSession` / `decline`. `grantRoot` is marked unstable and
its semantics ("session-scoped write access under a root") aren't stated
against a decision value. Dropped until captured; the `AlwaysDirectory` kind is
the obvious home when it is. `input` = the `fileChange` item's `changes`, so
the card can show the paths without the transcript row beside it.

**`item/permissions/requestApproval`:** the request is a profile (write roots,
read roots, network). Options: `once` → grant the whole requested profile with
`scope: "turn"`; `session` → same profile, `scope: "session"`; `deny` → empty
`permissions`. A partial grant would need a checklist card; Dray has none, and
the README's "any permissions omitted are treated as denied" makes the empty
grant a clean refusal. `blocked_path` = first write root; `input` = the
profile.

**`serverRequest/resolved`:** if the id is still pending, remove it and mint
`PermissionDecided{automatic: true}`. Covers the CLI clearing a request on
turn start/complete/interrupt. If we already answered, nothing — the
notification is confirmation, and the card was retired when we replied.

**`ApprovalPolicy` → Codex.** Dray's stance is one closed enum; Codex has two
axes. Mapping:

| `ApprovalPolicy` | `approvalPolicy` | `sandbox` |
|---|---|---|
| `Plan` | `on-request` | `read-only` |
| `Manual` | `untrusted` | `workspace-write` |
| `AcceptEdits` | `on-request` | `workspace-write` |
| `Auto` | `on-request` | `workspace-write` |
| `DontAsk` | `never` | `workspace-write` |
| `BypassPermissions` | `never` | `danger-full-access` |

`AcceptEdits` and `Auto` collapse — Codex applies patches inside
`workspace-write` without asking already, so there is no stance between "ask
about commands" and "ask about commands and edits". Documented, not hidden.
`Settings.approval_policy` on the way back reports the nearest
`PermissionMode`; the index item keeps the user's own pick, same rule as
Claude's `default` ambiguity.

**Mid-session change.** `turn/start` accepts `approvalPolicy`, `sandboxPolicy`,
`model`, `effort` and they become sticky. So `set_model`, `set_permission_mode`
and — unlike Claude — **effort** all apply on the next `turn/start` with no
respawn and no control request. The "Changing effort respawn child" known
issue becomes Claude-only; `send_msg`'s `effort_changed` kill is dispatched on
harness. `thread/settings/update` would apply them *between* turns, but it is
experimental; folding into the next send is the stable route and costs
nothing visible.

### Questions

**`item/tool/requestUserInput` → `QuestionsAsked`.** One to three questions,
each `{id, header, question, isOther, isSecret, options?: [{label,
description}]}`. Map onto `Question{question, header, multi_select: false,
options}`. The card is Dray's existing `QuestionRequest`, unchanged.

The answer shape differs in one way that matters: Codex keys answers by
question `id`, Dray's form names items by question *text* (Claude's rule,
pinned both sides). Keep the frontend as it is and remap in Rust: the pending
entry holds `Vec<(text, id)>` and `answer_questions` builds
`{answers: {id: {answers: [text]}}}`. `isOther: false` means the tool did not
ask for free text; Dray always shows the box (CLAUDE.md: not optional to
render), so the reply may carry text the tool didn't offer. Harmless — it is a
string either way. `isSecret` has no Dray home; render as text and note it in
the failure log so it is counted. `autoResolutionMs` means the server answers
itself after a deadline and sends `serverRequest/resolved`, which retires the
card by the path above.

`tool/requestUserInput` is listed as experimental in the API overview. Whether
the *server request* is gated on the capability, or only the client method
is, is unclear. Capture will show whether it arrives without opt-in.

**`mcpServer/elicitation/request`.** Three modes:

- `form` / `openai/form` with `requestedSchema` — a JSON-schema-driven form.
  Dray has no renderer for one. Refused (`{action: "decline", content: null}`)
  from the reader task, filed `unsupported_request`. **Except** when `meta.
  codex_approval_kind == "mcp_tool_call"`: that is an approval wearing an
  elicitation's clothes, and it maps onto `PermissionRequested` with
  `once`/`session`/`always`/`deny` per `meta.persist`. Reply content shape for
  that case is uncertain — capture it.
- `url` — open `url` with `openUrl`, reply `accept`. Slice 4.

**`requires_user_interaction` has no Codex analogue.** The known-issue about
half-honouring it stays Claude's.

## 7. Worktrees

Codex has no `-w`. Dray already has the other route: `create_worktree(cwd,
name, base)` runs `git worktree add --no-track -B worktree-<name> <path>
<base>` and the child spawns *into* the tree. Built for `dray new --from`, and
it is the whole worktree story for Codex.

**What changes in `send_msg`:** `owned_worktree` becomes true for every Codex
worktree creation, not only when `base_ref` is given. The default base has to
be resolved by Dray, because nothing downstream will: `base_ref_tree` already
resolves the fork point `-w` uses (`origin/<default>`, falling back to local
`HEAD`), and the same resolution hands `create_worktree` its base. It does
**not** fetch first. Say so in the composer's "resolved base" line, and leave
it: a fetch on every worktree session is a network call before the first
token, and the stale-by-one-push case reads as one extra commit in the changes
panel, which the Claude path already has.

What falls out, all better than the `-w` path:

- Baseline is a real `snapshot_tree` of a directory that exists, not
  `base_ref_tree`'s approximation. The known-issue about reflog-recoverable
  baselines is Claude-only.
- No lock on the tree, so `remove_worktree`'s unlock step is a no-op there.
  Its pid check reads nothing and refuses nothing. Fine: only `-p` leaves
  locks.
- Fork in new worktree can take the *parent's branch tip* as base, which
  CLAUDE.md names as the wanted-but-not-done cure. Codex gets it first.
- `thread/start.cwd` = the tree. `workspace-write` writable roots default to
  cwd.

What it misses, or might:

- **The `.git` file.** A linked worktree's `.git` is a file pointing at
  `<project>/.git/worktrees/<name>`, and every git write (`commit`, `add`)
  writes there — outside the sandbox's writable root. Codex's `workspace-write`
  treats `.git` under cwd as read-only by design and escalates git writes to
  an approval; for a linked tree the gitdir isn't under cwd at all. Expect
  either an approval per commit or a sandbox denial. **Verify live.** If it
  bites, the cure is `sandboxPolicy: {workspace-write, writableRoots: [tree,
  <project>/.git/worktrees/<name>]}` on `thread/start`, and that is the case
  for sending `sandboxPolicy` rather than the `sandbox` shorthand.
- **`thread/start` marks the cwd trusted in the user's `config.toml`** when the
  resolved sandbox is workspace-write or full access. One `[projects."<path>"]`
  entry per worktree session, forever. Cosmetic litter in a file the user
  owns. Note it in the fixture README; nothing to do.
- **Path convention.** Trees still land under `<project>/.claude/worktrees/`
  on branch `worktree-<name>`, because `worktree_path`, `session_branch`,
  `remove_worktree`'s shape guard and the `backfill_removed_worktrees` pass
  all key on that shape. Renaming the directory per harness buys nothing and
  splits four functions. Keep it; it is Dray's convention now, not Claude's.
- **AGENTS.md discovery.** Codex walks from cwd to the git root; a linked
  worktree's root is the tree itself, so `<project>/AGENTS.md` is found via
  the checkout, not the main repo. Same as Claude's CLAUDE.md. No gap.

## 8. Sending, steering, queueing

`deliver_prompt` for Codex = `turn/start {threadId, clientUserMessageId:
event.id, input: [{type: text, text}, {type: localImage, path}…]}`, awaiting
the turn id. `clientUserMessageId` = the `UserMessage` event's own id, so the
`userMessage` echo can be asserted against it in tests and ignored in the
mapper.

**Queued prompts become `turn/steer`.** Dray holds a prompt typed mid-turn
until a boundary because Claude injects a buffered prompt at the next tool
result and nowhere sooner. Codex has `turn/steer {expectedTurnId}`, which
appends to the running turn now. So for Codex, `queue_msg` sends a steer
immediately and marks the `UserMessage` `queued: true` (the transcript rule
for "does not abandon open tool calls" still holds — it is the same turn).
Steer is refused for review and compaction turns
(`ActiveTurnNotSteerable`); on that error fall back to the boundary queue.
`expectedTurnId` is the turn id `turn/start` answered with, held on the
session for the turn's lifetime. This is a real improvement over Claude's
path and costs one branch in `queue_msg`.

**Interrupt** = `turn/interrupt {threadId, turnId}`; the `turn/completed
interrupted` that follows closes the tracker. No task fan-out until slice 4.

**Compaction** (`/compact` typed in the composer): Claude expands it as a
prompt; Codex has no slash commands, so `/compact` alone is recognised in
`deliver_prompt` and becomes `thread/compact/start`. The only slash command
with a Codex meaning. Everything else `/` is prose there.

## 9. Fixtures and testing

### What's there is the wrong protocol

`live_simple.jsonl`, `live_tools.jsonl` are `codex exec --json` — a flat
per-item event stream with `thread.started`, `item.completed`. `rollout.jsonl`
is a session replay log. None of the three has a JSON-RPC envelope, a server
request, a delta notification, or a thread id on a line. Delete all three.
`events.rs`'s comment about Codex ("emits no deltas", "uses `agent_path`")
was written against them and is corrected by this document.

### What to capture

Raw stdio of `codex app-server`, **both directions in one file**, each line
wrapped: `{"dir": "in" | "out", "line": <raw JSON>}`. Two reasons the Claude
fixtures' stdout-only shape doesn't work here: a response is meaningless
without the request it answers, and the approval reply *is* the test. Tests
unwrap and feed `out` lines through a fake transport (`tokio::io::duplex`)
into the real `RpcClient`, asserting that each `in` line the client emits
matches the recorded one. That pins the request shapes the way `control.rs`'s
tests do today, from the capture rather than by hand.

Capture tool: a small driver script that spawns `codex app-server`, tees both
pipes into the wrapped file, and plays a scenario. Twenty lines of Node or
Python; lives under `apps/desktop/scripts/`. Every file's first line records
`codex --version`.

Scenarios, one file each, all under `harness/codex/fixtures/`:

| file | pins |
|---|---|
| `handshake.jsonl` | `initialize` response shape, `initialized`, `thread/start` response with `thread.id`, `thread/started` |
| `simple_turn.jsonl` | `turn/start` → deltas → `agentMessage` completed, `reasoning` with summary, `tokenUsage/updated`, `turn/completed` |
| `tools.jsonl` | `commandExecution` with `outputDelta` and `commandActions`, `fileChange` with diff, `mcpToolCall` if any server configured |
| `approve_command.jsonl`, `decline_command.jsonl` | `requestApproval` with `proposedExecpolicyAmendment`, reply, `serverRequest/resolved`, `item/completed` with `completed` / `declined` |
| `approve_file_change.jsonl` | same for `fileChange` |
| `request_permissions.jsonl` | `item/permissions/requestApproval` and the granted-subset reply |
| `request_user_input.jsonl` | `item/tool/requestUserInput` shape, answer keyed by id |
| `interrupt.jsonl` | `turn/interrupt` mid-command, pending approval cleared by `serverRequest/resolved`, `turn/completed interrupted` |
| `failed_turn.jsonl` | `error` then `turn/completed failed` with `codexErrorInfo` — easiest to provoke with a bad API key (`Unauthorized`) |
| `retry.jsonl` | `error {will_retry: true}` — hard to provoke on demand; take whichever session yields one |
| `compaction.jsonl` | `thread/compact/start` as a turn |
| `resume.jsonl` | `thread/resume` response with `turns` populated, restored `tokenUsage/updated` |
| `fork.jsonl` | `thread/fork` response, new `thread/started`, `forkedFromId` |
| `collab.jsonl` | `spawn_agent` with child thread, whether child `item/*` lines arrive on the parent's connection — **decides §5 subagents** |
| `two_call_turn.jsonl` | a turn with two model calls, to read `tokenUsage.last` semantics — **decides the ring** |
| `background_terminal.jsonl` | a command with `process_id` that outlives its item, and `thread/backgroundTerminals/list` after |
| `worktree_git.jsonl` | `git commit` inside a linked worktree under `workspace-write` — **decides §7's `.git` question** |

### Test layers

1. **Wire types**: every `out` line in every fixture deserializes to
   `ServerRequest | ServerNotification | Response`, none to the catch-all.
   The count of catch-all hits is asserted zero per fixture, so a new
   notification in a recaptured fixture fails loudly.
2. **Mapper**: exact event counts per fixture, the way `complex.jsonl` is
   asserted. `BlockRef` continuity: every `TextDelta` has a `BlockStart` before
   it and a committed event after it with the same ref.
3. **Client**: fixture through a duplex transport. Pending map resolves every
   response; every `in` line matches the capture byte-for-byte after
   normalising ids.
4. **Permissions**: option lists built from each `requestApproval` capture,
   and the reply for each option id serialized against the recorded reply.
5. **Event-model compatibility**: unchanged; runs as part of `cargo test`.
   Remember the trap — a filtered `cargo test codex::` rewrites
   `src/types/events.ts` with only what ran. Follow with bare `cargo test`.

Nothing runs a real `codex` binary in CI. The captures are the contract.

## 10. Staging

### Slice 0 — make room (Dray only, no Codex code)

- Lift the post-mapper half of `claude_code::read_stdout` into
  `session::ingest`. Claude's reader calls it; tests unchanged.
- `Session.stdin` → `Transport` enum; every writer dispatches.
- `deliver_prompt` takes `harness`.
- `PendingRequest`'s per-option reply becomes a prebuilt `Value`; Claude's
  `permissions.rs` builds it where it built `updates`.
- `SessionIndexItem.thread_id`, `#[serde(default)]`, written by nobody yet.
- `binpath` learns `codex`.

Ships as its own PR. Every change is pinned by tests that already exist.

### Slice 1 — a Codex session on screen

- `harness/codex/{codex.rs, rpc.rs, parser.rs, mapper.rs}`. `Harness::Codex`
  stops bailing in `Session::init`.
- Spawn, `initialize`, `thread/start` with `approvalPolicy: never` and
  `sandbox: workspace-write` **regardless of the picked mode** — nothing asks,
  nothing stalls, and the permission layer isn't built yet. Record
  `thread_id`.
- Map: turn lifecycle, `agentMessage` + deltas, `reasoning`, `commandExecution`,
  `fileChange` + `FileEdits`, `tokenUsage`, `error`, synthesized
  `ModelRequestStarted`. Everything else parsed → `None`.
- Resume by `thread/resume`. Interrupt by `turn/interrupt`.
- Frontend: a harness picker in the composer toolbar (creation-time only, like
  project and worktree), `models.rs` grows `codex_models()` (static list to
  start; `model/list` later), `list_models` takes a harness, `useSessions`
  stops hardcoding `"claude_code"`. Effort levels per model from the same
  list.
- Fixtures: `handshake`, `simple_turn`, `tools`, `failed_turn`, `resume`.

Done when: a Codex session runs a multi-tool turn, the transcript draws it,
the changes panel shows the diff from snapshots, and reopening the app resumes
it.

### Slice 2 — approvals and questions

- Honour the picked mode through the §6 table. `untrusted`/`on-request`
  send requests; handle all three `requestApproval` kinds and
  `requestUserInput`. `serverRequest/resolved`. Auto-decline for form
  elicitations. Model/effort/mode changes via sticky `turn/start` overrides.
- Fixtures: the four approval files, `request_user_input`, `interrupt`.

### Slice 3 — worktrees, fork, orchestration

- `owned_worktree` for every Codex worktree; default base from
  `base_ref_tree`'s resolution. `thread/fork` on first send with `fork_from`.
  Fork-in-worktree takes the parent's tip as base.
- `dray new --harness codex` already parses; make it work end to end,
  including `--from`. `thread/delete` on session delete.
- Steer for queued prompts, with the boundary-queue fallback.
- Fixtures: `fork`, `worktree_git`, `compaction`.

### Slice 4 — the rest of the vocabulary

- Subagents (`collab.jsonl` decides the shape). Background terminals into the
  tracker and Stop's fan-out. Rate limits. `mcpToolCall` and `mcp_tool_call`
  elicitation approvals. `imageView` archive. `webSearch`. `turn/plan/updated`
  as a plan row. Ring from `two_call_turn`. Retry indicator's zero-ceiling
  tweak. `$skill` picker from `skills/list`. `optOutNotificationMethods` for
  whatever captures show is pure noise.

### Later, and not promised

`review/start` from the handoff row; plan mode via `collaborationMode`;
`ToolCallProgress` for live command output; `thread/settings/update` once it
is stable; `model/list` as the model source; attestation if enterprise use
ever wants it.

## 11. Open questions, and what settles each

| question | settled by |
|---|---|
| Do a spawned child thread's `item/*` lines arrive on the parent's connection? | `collab.jsonl` |
| What does `tokenUsage.last` measure — last call or last turn? | `two_call_turn.jsonl` |
| Does `git commit` inside a linked worktree escalate, deny, or pass under `workspace-write`? | `worktree_git.jsonl` |
| Is `item/tool/requestUserInput` sent without `experimentalApi`? | `request_user_input.jsonl` captured with no capability |
| Reply content shape for an `mcp_tool_call` elicitation approval | a capture with one MCP server configured to prompt |
| Does `thread/resume` for a long thread cost enough (full `turns` array) to want `excludeTurns`? | timing on a 50-turn thread; `excludeTurns` is experimental, so the answer decides whether slice 1 opts in |
| `grantRoot` semantics on file-change approvals | marked unstable upstream; wait |
| Does `initialize` need `clientInfo.name` registered for anything to work on ChatGPT-plan accounts? | first live run on a ChatGPT login |

## 12. What this deliberately does not do

- No Codex-side reading of history. Dray's log is the transcript; `turns` on
  `thread/resume` are received and ignored. Same rule as Claude's replay log.
- No `turn/diff/updated`. The changes panel is snapshot-based by design.
- No second worktree path convention.
- No shared JSON-RPC module until a second JSON-RPC harness exists.
- No new persisted event variants in the first three slices.
- No writes to `config.toml`, no `config/*` calls, no account/login flow —
  the user logs in with `codex login` as they do with `claude`; a missing
  login surfaces as `turn/completed failed` with `Unauthorized`, whose
  `message` is the sentence the row draws.
