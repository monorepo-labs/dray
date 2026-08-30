# pi as a third harness, over `pi --mode rpc`

Architecture plan. Written against pi's own `docs/rpc.md`, `docs/extensions.md`,
`docs/models.md` and `docs/security.md` at `pi-mono@853a80d`, and against Dray
as of `main` at `ca9c268c`.

**Captured live against `@earendil-works/pi-coding-agent` 0.84.4**, with one
capture on 0.74.2 kept deliberately. Six of the eleven captures ran against a
scripted OpenAI-completions provider rather than a real model: the pi process,
the RPC framing, the tool execution and the extension host are all real, only
the tokens are canned. Three reached the network — `live_turn.jsonl` and
`live_models.jsonl` against a working xAI login, `failed_turn_live.jsonl`
against an expired one. The fixtures README says which is which and
`scripts/pi-capture/` re-runs any of them.

The stub was more generous than a real provider in two places and both are
called out where they matter (§7, §8). That is the whole reason the live pair
exists: a design written against the stub alone would have derived the context
ring from streamed usage that a real provider leaves at zero.

No harness code is written yet. This is the design.

## What the live captures corrected

Nine things were taken on trust from the docs before anything ran. Six of them
survived. Three did not, and one of the three inverts a decision.

| | taken on trust | wire says |
|---|---|---|
| deltas | `message_update` carries `text_delta`, `thinking_delta` and `toolcall_delta`, so the streaming-preview trick works out of the box | **True, and worth less than it sounds.** They key on `contentIndex`, there is no message id anywhere, and every `*_end` arrives in a batch *after* every `*_start`. And on a real provider `toolcall_delta` fired **once per call** with the whole argument object — the preview split works and buys 2ms, not the 39.5s it buys on Claude Code |
| tools | `tool_execution_start`/`update`/`end` map onto `ToolCallStarted`/`ToolCallCompleted` | **True**, and the result arrives **twice** — once here, once as a `toolResult` message. One of the two has to be dropped |
| stop | `abort` takes no arguments, simpler than Codex | **True and not enough.** A queued steer is delivered *after* the abort. Stop is `clear_queue` then `abort`, or it does not stop |
| turn boundary | `agent_settled`, not `agent_end` | **True**, and there is a *third* granularity nobody mentioned: `turn_start`/`turn_end` fire once per model call. That is the `ModelRequestStarted` that Codex had to synthesize |
| context ring | `get_session_stats.contextUsage` is a real occupancy figure | **True.** It is also a *command*, not an event — pull, not push — and `tokens.total` sits beside it carrying the cumulative number that fooled us twice already |
| approvals | ride an extension UI sub-protocol, and may depend on an extension being installed | **True, and it is worse than that.** With no extension, pi runs the tool. There is no approval machinery in pi at all |
| session id | pi mints its own, `new_session` takes `parentSession` — "the Codex situation" | **Wrong.** It is neither situation. `--session <path>` lets Dray choose the *file*, and a second spawn on the same path resumes the same session id. **No new index field is needed for the ordinary case** |
| fork | pi has native fork at a chosen message, and clone — better than Claude Code | **Wrong for Dray.** Both hijack the running process, and pi names the new file itself. `--fork cannot be combined with --session`, verbatim. Dray forks by copying the session file, exactly as it copies its own log |
| models | 15+ providers, hundreds of models, `get_available_models` answers at runtime | **Half wrong.** It answers with the models that have *resolvable auth on this machine*. Eleven, across two providers, on the probe box — and it was ten an hour earlier, before a second login. The picker is a menu, not a catalogue |

And four things the docs do not say at all:

- **pi emits nothing on spawn.** No `initialize`, no `init` line, no greeting.
  It is silent until asked. So the handshake is Dray sending `get_state` and
  reading the answer — which doubles as the health probe, and costs no model
  call.
- **The npm package a user gets depends on their Node version.** `latest` is
  `0.84.4`; `legacy-node20` is `0.74.2`, and on Node 22 npm resolves the
  legacy one. `agent_settled` landed in **0.80.6**. So a build that resolves
  `pi` by name alone can get a CLI whose turns never end — the same class of
  trap as the stale `codex` with no `app-server`, and it needs the same cure.
- **An aborted turn reports `stopReason: "error"`**, with
  `errorMessage: "This operation was aborted"`. The docs list `"aborted"` as a
  stop reason. Nothing on the wire produced one.
- **A failed turn is not an event.** There is no error event type. A failure is
  `stopReason: "error"` plus `errorMessage` on the assistant message, and
  `agent_end` closes the run as if nothing happened. The sentence is the thing
  worth drawing: `"No API key for provider: openai-codex"` names its own cure.
- **`usage` on `message_update` is zero for the whole stream** on a real
  provider. The docs hedge — "may remain zero until completion" — and xAI does
  exactly that, on all 54 deltas of a three-call turn. So the context ring
  cannot be derived from streaming, which makes §8's pull-not-push design
  necessary rather than merely tidier.
- **pi streams real reasoning text.** 41 non-empty `thinking_delta` frames in
  one turn. Claude Code streams `thinking_delta` frames carrying `""` — the bug
  CLAUDE.md documents as 53 zero-length reasoning events and 83.8s of blank
  screen. pi's thinking block is worth drawing from the first frame.

## TLDR for human

- **Approvals: pi has none, so Dray ships one.** A five-line pi extension,
  embedded in the binary and written to disk on spawn, hooks `tool_call` and
  calls `ctx.ui.confirm`. That surfaces as `extension_ui_request` on stdout and
  Dray's existing card answers it. Verified working, including denial. There is
  no rule composition and no suggestion list, so for the first time the
  permission options are Dray's own.
- **Session identity: `--session <path>`.** Dray picks the path from its own
  session id, so it stays derivable and index-before-spawn is untouched. One
  new nullable field covers the fork case. Generalising the existing
  `thread_id` instead looked tidier and would strand every Codex session in
  silence — the key on disk is `threadId`, so the alias matches nothing.
- **Models: the list is a property of the machine, so it has to be asked for.**
  A throwaway `pi --mode rpc` child answers `get_available_models` and
  `get_available_thinking_levels` with no model call — the same trick
  `commands.rs` already uses for Claude's slash commands. `ModelId` stops being
  a closed enum and gains an open string form; `default_model_for` starts
  returning `Option`, because for pi the honest default is pi's own.
- Turn boundary is `agent_start` → `TurnStarted`, `agent_settled` →
  `TurnCompleted`, `turn_start` → `ModelRequestStarted`, `agent_end` → nothing.
  Getting this wrong is the single most likely way to strand a session.
- Stop is `clear_queue` then `abort`, and the aborted turn must be suppressed on
  Dray's own knowledge that it asked, not on a stop reason.
- Worktrees are free — the `create_worktree` path Codex already takes, and with
  no sandbox to fight, the linked-worktree `.git` question Codex opened does not
  arise.
- Zero new persisted `AgentEventPayload` variants. Every pi event has a home or
  is dropped on purpose.
- Subagents do not exist in pi. The panel stays hidden.

---

## 1. What RPC mode is, in Dray's terms

Claude Code is a pipe with a control channel bolted on. `codex app-server` is a
JSON-RPC peer. pi is a third thing, and the difference is worth stating because
half this document follows from it.

pi is a **peer that does not speak JSON-RPC**. Commands go in as JSON lines with
an optional `id`; responses come back tagged `type: "response"` carrying that
`id` and a `command` name; events stream out untagged by anything but their own
`type`. There are no methods, no error objects, no batching, no notification
envelope. A response is `{"type":"response","command":"prompt","success":true}`
and a failure is the same line with `success: false` and an `error` sentence.

Three consequences, and they are not Codex's three:

1. **A send has an answer, but the answer is thin.** `prompt` answers
   `success: true` the moment it is *accepted*, and the docs say so outright:
   "failures after acceptance are reported through the normal event and message
   stream, not as a second response for the same request id". So awaiting the
   response proves the prompt was taken, and nothing else.
2. **Almost nothing is a question back.** The only inbound request is
   `extension_ui_request`, and only when an extension asks. Silence still
   stalls — `ctx.ui.confirm` has no default timeout — but the surface is one
   shape wide, not a protocol.
3. **Nothing is scoped.** No thread id, no turn id, no message id, no block id.
   The only correlation keys on the wire are `toolCallId` and, inside a
   streaming message, `contentIndex`. `turn_id` on `AgentEvent` stays `None`
   for pi, and `BlockRef.message_id` has to be minted by the mapper.

The framing has one hard rule, which pi's docs raise before anything else and
which is worth honouring even though Rust makes it easy: **records are split on
`\n` only.** `U+2028` and `U+2029` are legal inside JSON strings, so a reader
that treats them as line breaks corrupts a record that contains one. Rust's
`BufRead::lines` splits on `\n` and is correct here by construction. Naming it
anyway, because the day someone reaches for a "smarter" reader is the day this
breaks silently.

```
   Dray (Rust)                                pi --mode rpc (child, one per session)
   ───────────                                ───────────────────────────────────────
   (spawn)                                 ▶  … silence. pi says nothing at all.
   {"id":1,"type":"get_state"}             ▶
   ◀────────────────────────────────────────  {"id":1,"type":"response","command":"get_state",
                                               "success":true,"data":{model, sessionId,
                                               sessionFile, thinkingLevel, …}}   ← the handshake
   {"id":2,"type":"prompt","message":"…"}  ▶
   ◀────────────────────────────────────────  {"id":2,"type":"response","command":"prompt","success":true}
   ◀────────────────────────────────────────  agent_start                    ← Dray's turn opens
   ◀────────────────────────────────────────  turn_start                     ← one model call opens
   ◀────────────────────────────────────────  message_start   {role:"user"}  ← the echo, dropped
   ◀────────────────────────────────────────  message_end     {role:"user"}
   ◀────────────────────────────────────────  message_start   {role:"assistant"}
   ◀────────────────────────────────────────  message_update  thinking_start / _delta …
   ◀────────────────────────────────────────  message_update  text_start / _delta …
   ◀────────────────────────────────────────  message_update  toolcall_start {id, toolName}
   ◀────────────────────────────────────────  message_update  toolcall_delta …
   ◀────────────────────────────────────────  message_update  thinking_end, text_end, toolcall_end
   ◀────────────────────────────────────────  message_end     {role:"assistant"}  ← committed, wins
   ◀────────────────────────────────────────  tool_execution_start {toolCallId, toolName, args}
   ◀────────────────────────────────────────  extension_ui_request {id, method:"confirm"}   ← if gated
   {"type":"extension_ui_response",…}      ▶
   ◀────────────────────────────────────────  tool_execution_end   {toolCallId, result, isError}
   ◀────────────────────────────────────────  message_start/_end   {role:"toolResult"}  ← second copy, dropped
   ◀────────────────────────────────────────  turn_end                       ← that model call closed
   ◀────────────────────────────────────────  turn_start                     ← the next one opens
                                               …
   ◀────────────────────────────────────────  agent_end                      ← may still retry: not a boundary
   ◀────────────────────────────────────────  agent_settled                  ← Dray's turn closes
   {"id":3,"type":"get_session_stats"}     ▶
   ◀────────────────────────────────────────  {…"contextUsage":{tokens, contextWindow, percent}}
```

## 2. Turn boundaries, and the one thing most likely to go wrong

pi has **three** nested lifecycles and the names are not the ones Dray uses for
them:

| pi | fires | Dray's word for it |
|---|---|---|
| `agent_start` … `agent_settled` | once per prompt | **a turn** |
| `turn_start` … `turn_end` | once per model call | **a model request** |
| `message_start` … `message_end` | once per message | a message |

`no_approvals.jsonl` shows the shape at its plainest: one `agent_start`, four
`turn_start`/`turn_end` pairs, one `agent_end`, one `agent_settled`.

So the `StatusTracker` mapping is:

| pi event | payload | why |
|---|---|---|
| `agent_start` | `TurnStarted(SessionInfo)` | Opens the model call for the tracker. |
| `turn_start` | `ModelRequestStarted` | pi has no "requesting" ping, and this *is* one. Codex had to synthesize this; pi hands it over. Already in the not-persisted set. |
| `agent_end` | `None` | **Not a boundary.** It carries `willRetry`, and it fires again after a retry, after a compaction, and after a queued follow-up is picked up. |
| `agent_settled` | `TurnCompleted{…}` | The docs' own words: "Pi will not continue automatically through retry, compaction retry, or queued follow-up messages." |

Reading `agent_end` as the close ends a turn that is still running — the
composer goes idle mid-task, the changes panel freezes its head early, and a
completion notice fires for work that has not finished. Reading only
`agent_settled` and *not* mapping `agent_start` leaves the session
`in_progress` until something else happens to open a turn. Both are silent.
Both get a test.

`turn_start` must map to `ModelRequestStarted` and **not** to `TurnStarted`,
even though the word matches. `TurnStarted` sets `model_call_open` and flips
the status, so a four-call turn would open four Dray turns inside one prompt,
and `turn_end` closing none of them would leave three open forever.

**And `agent_settled` does not exist below pi 0.80.6.** §3 says what to do
about that. It is not a theoretical version: it is what npm installs on the
Node this repo's author had.

## 3. Process model, and finding the binary

### One `pi --mode rpc` per session

Same shape as both existing harnesses, and for once there is no argument to
have: pi holds one session per process by construction. `switch_session` moves
the process to another session file rather than adding one, and `clone` moves
it into a copy. There is no shared-server option to reject.

Spawn with cwd = the session's tree, `PATH` put back through `agent_path()`,
and `DRAY_SESSION_ID` / `DRAY_ENDPOINT` injected for orchestration, exactly as
the other two get them. pi reads `PI_SESSION_ID`, `PI_PROVIDER`, `PI_MODEL` and
`PI_REASONING_LEVEL` into every shell command it runs, which is pi's business
and needs nothing from us.

Flags at spawn:

```
pi --mode rpc
   --session <~/.dray/pi-sessions/<dray-session-id>.jsonl>   § 4
   --provider <p> --model <id>                               § 7, omitted to take pi's own default
   --thinking <level>                                        § 7
   -e <~/.dray/pi/dray-approvals.ts>                         § 6, omitted for Bypass
   --tools read,grep,find,ls                                 § 6, Plan mode only
```

`--no-session` is never passed: Dray wants the file, because the file is the
resume handle.

### The version gate is not optional

`binpath::pi()` has to ask the binary its version and refuse below **0.80.6**,
the way `binpath::codex()` asks a candidate whether it lists `app-server`. The
failure it prevents is worse than Codex's: a stale `codex` times out loudly at
the handshake, where a 0.74.x `pi` runs a turn perfectly and simply never ends
it. Every session started against one would sit `in_progress` forever, with
Stop as the only exit, and nothing on screen saying why.

`pi --version` prints a bare semver and costs one spawn, cached in the
`OnceLock` like every other resolution. Refusal reaches the reader as the
missing-agent notice §9 describes, with a version in the sentence.

Worth knowing while writing that resolver: the package is `@earendil-works/pi-coding-agent`,
the old `@mariozechner/pi-coding-agent` is deprecated but still publishing, and
`Harness::Pi::install_command()` should name pi's own installer rather than an
npm line — the rule `harness.rs` already states, for the reason it already
states.

## 4. Session identity

### `--session <path>` settles it, and nothing else has to change

pi mints its own session id and there is no way to make it adopt one: passing
`--session /…/019a0000-dead-7000-8000-000000000001.jsonl` writes the session
to exactly that file and still reports a `sessionId` of its own
(`session_id_not_adopted.jsonl`).

But the id is not the handle. **The path is.** A second process spawned with
the same `--session` comes back with the *same* `sessionId` and the whole
conversation — nine messages, in `resume.jsonl`. So:

```
~/.dray/pi-sessions/<dray-session-id>.jsonl
```

Dray already has the id before it spawns anything, so the path is derivable,
and every ordering CLAUDE.md protects survives untouched: the index entry is
written before spawn, the attachments directory is created before send, a
session whose child fails to start is still visible, and resume needs nothing
read back from anywhere.

Against Codex, this is the easy case. Against Claude Code it is very nearly the
same case — `--session-id` there, a path here.

### One index field, and it must be a new one

```rust
/// Where pi keeps this session's own log, when that is not the path Dray
/// derived from the session id. `None` is the ordinary case and means the
/// derived path — so resume reads this only for a session whose file pi named
/// itself, which today is a fork at a chosen message (§5).
#[serde(default)]
pub pi_session_path: Option<String>,
```

`None` for every session that has one, which is nearly all of them. Resume
reads `pi_session_path` if set and the derived path otherwise, so a session
created before the field existed resumes on the derivation and needs no
migration at all.

**The rename was the first proposal and it is a bug.** `thread_id` already
exists and is documented as "the id the harness knows this session by, where
that is not our own" — which reads like it was written for exactly this, so
generalising it to `agent_handle` with `#[serde(alias = "thread_id")]` looked
free.

It is not free, and the reason is one attribute two lines above the field:

```rust
#[serde(rename_all = "camelCase")]
pub struct SessionIndexItem {
```

So the key on disk is **`threadId`**, not `thread_id`, and an alias naming the
snake_case spelling matches nothing. Checked against the real index rather than
reasoned about: 240 entries, 240 carrying `threadId`, none carrying
`thread_id`.

What that costs is the whole point. `SessionIndexItem` carries
`#[serde(flatten)] unknown`, so the unmatched `threadId` would not error — it
would be swallowed into the unknown-keys map and written straight back out. The
data would sit on disk, intact, and be invisible to resume. **Every existing
Codex session would answer "no thread to resume" while its thread id was right
there in the file.** That is the exact failure `unknown` was added to prevent,
reintroduced by the field that was supposed to be tidier.

Spelling the alias `threadId` fixes the match and leaves a worse hazard: after
the rename, an older build writing the same index puts `threadId` back beside
the new `agentHandle`, and a field with an alias reads a duplicate key as an
error rather than a preference. Two builds share `~/.dray` by design — that is
why `unknown` exists — so this is an ordinary state, not an edge.

A second nullable field costs one line and cannot do any of that. Each field
then means exactly one thing, which is what the rest of this struct already
manages.

**What each feature does under this choice:**

| feature | what happens |
|---|---|
| log filename, attachments dir | Dray id, unchanged |
| `DRAY_SESSION_ID`, `dray send`, `--from` | Dray id, unchanged — one address space across three harnesses |
| resume | spawn with `--session <derived path>`; `get_state` confirms the id |
| resume where the file was never written | pi starts a fresh session at that path. Not an error, and the right behaviour: a session whose first send died leaves nothing to resume and should simply work next time |
| delete | delete the session file beside the attachments, best effort. pi's sessions live under Dray's own directory, so unlike Codex's rollouts there is no vendor store left behind |
| orchestration `create_session` | returns the Dray id immediately, unchanged |

## 5. Fork, and why pi's own fork is the wrong tool

pi has the primitive Dray has wanted: `fork {entryId}` branches at a chosen
user message, and `get_fork_messages` lists the points. Claude Code cannot do
this and Codex cannot do this.

It is still not usable for Dray's fork, for two reasons that were both
measured:

- **`clone` hijacks the running process.** After a `clone`, the same connection's
  `get_state` names a new session id and a new file. The parent session Dray
  thought it was talking to is gone from under it. `fork` is the same command
  family and is assumed to do the same, which is the one assumption in this
  section written against a pattern rather than a line.
- **pi names the new file.** `--fork` and `--session` are refused together, in
  as many words: `--fork cannot be combined with --session`. So a pi-side fork
  cannot land at a path Dray chose.

So **Dray forks by copying the session file**, which is what it already does
with its own log. `SessionManager::fork` copies `~/.dray/sessions/<parent>.jsonl`,
the attachments directory, and now `~/.dray/pi-sessions/<parent>.jsonl` to the
fork's own path; `fork_from` on the index entry is not needed for pi at all,
because there is no CLI-side fork to perform lazily. First send is an ordinary
spawn on a file that already holds the conversation. That is *simpler* than
Claude's lazy fork, not harder.

The same fork guard applies — refused while the parent's turn is in flight,
because copying a file another process is appending to yields half a turn.
`turn_in_flight()` already answers it.

**Fork at a chosen message is reachable and costs one thing.** Spawn a
throwaway child on the copy, send `fork {entryId}`, read
`get_state.sessionFile`, record *that* on `pi_session_path`, kill the child. The
cost is that the fork's path is pi's rather than derivable, which is exactly
what the field is for. Not in the first three slices; named because it is the
one capability pi has that neither other harness does, and because the field
that would carry it is being added anyway.

## 6. Permissions — the sharp edge

### pi has no permission system. At all.

This is not "pi has a different model". `docs/security.md` says it outright:
"Pi does not include a built-in sandbox. Built-in tools can read files, write
files, edit files, and run shell commands with the permissions of the pi
process." Grepping the whole `coding-agent` and `agent` packages for
`approval` returns two hits, one about Hugging Face model gating and one about
a filesystem errno.

And `no_approvals.jsonl` is the capture: four tool calls — a read, a shell
command, an edit and a write — and not one request of any kind. pi ran them.

`--tools`/`--no-tools` at spawn is the only gate pi ships, and it is an
allowlist fixed for the process, not a question.

### So Dray ships the gate

pi's extension API has exactly the seam needed. `pi.on("tool_call", …)` fires
after `tool_execution_start` and **before the tool runs**, it can `await`, and
returning `{ block: true, reason, terminate? }` stops the call. In RPC mode
`ctx.ui.confirm()` emits `extension_ui_request` on stdout and blocks until an
`extension_ui_response` with the matching id comes back on stdin.

That is the whole mechanism, and `extension_approvals.jsonl` is it working end
to end against a five-line extension:

```
out  {"type":"extension_ui_request","id":"6d40…","method":"confirm",
      "title":"Allow read?","message":"{\"path\":\"notes.txt\"}"}
in   {"type":"extension_ui_response","id":"6d40…","confirmed":true}
…
out  {"type":"extension_ui_request","id":"a33b…","method":"confirm","title":"Allow bash?", …}
in   {"type":"extension_ui_response","id":"a33b…","confirmed":false}
out  {"type":"tool_execution_end","toolCallId":"call_bash_1","toolName":"bash",
      "result":{"content":[{"type":"text","text":"Denied by Dray"}]},"isError":true}
```

Five things that capture settles:

- **A denial lands where a tool error already lands.** `isError: true` with the
  reason as the text, so the transcript row draws the refusal without any new
  vocabulary. Dray's own rule — "a settled request draws no row either way:
  approval is visible in the tool simply running, refusal in the tool's own
  error" — holds exactly.
- **Requests arrive one at a time, and Dray should still not rely on that.**
  The capture shows them strictly serialised — `read` answered at t=11008,
  `bash` asked at t=11032 — and pi's docs say why: sibling tool calls from one
  assistant message "are preflighted sequentially, then executed concurrently",
  and `tool_call` is the preflight. So the gate is a queue by construction.
  `buildTranscript`'s `pendingAsks` is already a list and stays one, because
  the serialisation is pi's behaviour rather than a guarantee it publishes.
  (An earlier draft claimed the capture showed two open at once. It does not —
  the driver answered each request before the next was asked, so the capture
  could not have shown overlap whether or not pi allows it.)
- **A reply for an id that is gone is ignored in silence** — the driver
  re-sent answered ids and nothing broke. Same property Claude's
  `control_response` has, and the same consequence: a regression here presents
  as a hung turn, not an error.
- **`cancelled: true` on a `confirm` reads as `false`.** So Dray's card needs no
  third button and the window-closed case is a denial.
- **The extension sees pi's normalized input, not the model's.** The stub sent
  `edit` as `{path, oldText, newText}`; the hook received
  `{path, edits: [{oldText, newText}]}`. The card should draw what the hook
  saw, because that is what will run.

### Where the extension comes from

Embedded in the Rust binary with `include_str!` and written to
`~/.dray/pi/dray-approvals.ts` on spawn, then passed as `-e <path>`. This is
the `dray skill install` pattern and it is chosen for that pattern's reason:
the extension and the code that answers its requests travel in the same binary,
so one describing a protocol the other does not speak is impossible.

Not `~/.pi/agent/extensions/` — that is the user's own directory and a globally
installed extension would gate their terminal sessions too. `-e` is explicitly
documented to work even under `--no-extensions`, which is what lets Dray load
its own gate and nothing else.

### The options are Dray's own, for the first time

Claude sends `permission_suggestions` and Codex sends `availableDecisions`.
CLAUDE.md's rule — "options the user sees are the CLI's, not ours" — has no
counterpart here, because pi composes nothing. So the card's list is written in
Rust and honest about being narrow:

| option id | label | kind | what happens |
|---|---|---|---|
| `once` | Allow once | `Once` | `{confirmed: true}` |
| `tool` | Always allow `<tool>` | `AlwaysRule` | `{confirmed: true}`, and the tool name goes into a per-session allow set |
| `deny` | Deny | `Deny` | `{confirmed: false}` → `{block: true, reason: "Denied in Dray"}` |

**The allow set lives in the extension, not in Rust**, and that is a real
decision rather than an implementation detail. If Rust held it, Rust would have
to answer the next `extension_ui_request` for that tool without asking — which
works, but means every remembered grant still costs a full round trip through a
process boundary, and means the *extension* cannot tell an allowed call from an
ungated one. Held in the extension, a remembered grant means no request is ever
emitted. So Dray sends the grant down once, inside the response
(`{confirmed: true, remember: "tool"}` — a field the extension reads and pi
passes through untouched), and the rule never leaves the pair of processes that
own it. The frontend still answers with an option id and nothing else, which is
the invariant that actually matters.

Per-session, never persisted. A standing grant that outlives the window is a
promise pi gives Dray no way to keep — there is no rule store to write to and
no policy for a next session to read.

`AlwaysDirectory` and `SwitchMode` are not offered: pi has no path scoping and
no mode to switch into mid-session.

### The modes map onto *what gets gated*, not onto a setting

Every other harness takes a stance as a flag. pi has no flag, so Dray's
`ApprovalPolicy` becomes an instruction to the extension and to the spawn:

| `ApprovalPolicy` | how it is achieved |
|---|---|
| `Plan` | `--tools read,grep,find,ls` at spawn, and the extension loaded. Genuinely read-only, enforced by pi not by prose |
| `Manual` | extension loaded, gate **every** tool call |
| `Auto` | extension loaded, gate everything **except** a named read-only set (`read`, `grep`, `find`, `ls`). Reads run |
| `DontAsk` | extension loaded, gate nothing, but keep the hook so a future rule has somewhere to live |
| `BypassPermissions` | no `-e` at all |

**`Auto`'s gate is an allowlist of what may skip the card, never a blocklist of
what must raise one.** Naming `bash`, `write` and `edit` was the first draft and
it fails open on the one thing pi is built around: **extensions register their
own tools**, and any of them can write files or run commands under a name this
table has never seen. A blocklist lets every one of those through silently under
a stance the reader chose because it asks about changes. The allowlist gets that
wrong in the safe direction — an unknown read-only tool costs one card.

`Plan` is the same rule one layer down, and it is stronger because pi enforces
it: `--tools` is itself an allowlist, so an extension tool is not merely ungated
there, it is not loaded.

This wants a capture before slice 2 lands — an extension registering a mutating
tool, confirming that its call reaches `tool_call` under the same name it
registered. Nothing in the current fixtures exercises a custom tool at all.

Two more things fall out and both are worth saying plainly.

**Plan mode works better here than on Codex.** Codex hides it because
read-only-and-ask is a stance Codex never names. pi's `--tools` allowlist is
exactly a read-only agent, fixed at spawn, and cannot be talked past. So the
composer *shows* Plan for pi.

**`Auto` is a weaker promise than it is elsewhere.** On Codex, "approve for me"
is backed by an OS sandbox: a command that steps outside the workspace fails
whether or not anyone was asked. pi has no sandbox, so an approved `bash` can
do anything the user can. The composer's label is the same word for a different
guarantee, and that difference belongs in the mode picker's own copy for pi,
not only in this document. It is also the one place where "run pi in a
container" — pi's own advice — is the real answer, and Dray has nothing to say
about it yet.

**And a stance change means a respawn.** `--tools` is fixed for the process and
the extension is loaded at spawn, so nothing about a mode applies in place.
That is the same conclusion Codex reached for a different reason, so
`send_msg`'s existing respawn path covers it.

### Questions

pi's `extension_ui_request` also carries `select`, `input` and `editor`, each
blocking for a value. Those are a natural home for `QuestionsAsked` — a
`select` with `options` is Dray's `Question` almost field for field — but
**nothing in pi sends one unless an extension does**, and Dray's own extension
will not. So `QuestionsAsked` is unreachable for pi in the first three slices,
and the four dialog methods that are not `confirm` are answered from the reader
task with `{cancelled: true}` and filed as `unsupported_request` — the same
stage and the same reasoning Claude's refusals use, because it is the only
stage that changes what the agent does.

The fire-and-forget methods (`notify`, `setStatus`, `setWidget`, `setTitle`,
`set_editor_text`) get no reply, by protocol. Parsed and dropped, so the
failure log stays a signal — the `tool_progress` treatment.

## 7. Models — the biggest question

### What is actually true

`get_available_models` returns a full `Model` per entry:

```json
{"id":"gpt-5.5","name":"GPT-5.5","api":"openai-codex-responses",
 "provider":"openai-codex","baseUrl":"https://chatgpt.com/backend-api",
 "reasoning":true,"thinkingLevelMap":{"xhigh":"xhigh","minimal":"low"},
 "input":["text","image"],"contextWindow":272000,"maxTokens":128000,
 "cost":{"input":5,"output":30,"cacheRead":0.5,"cacheWrite":0}}
```

Four properties decide the design:

- **A model is `(provider, id)`, not an alias.** `anthropic/claude-sonnet-4-5`,
  `ollama/llama3.1:8b`, `stub/stub-1`. `set_model` takes both halves.
- **The list is a property of the machine, not of pi.** It answers with the
  providers that have resolvable auth, and it moves under you. The probe box
  answered **ten models from one provider**, then **eleven across two** an hour
  later when a second provider was logged into — no restart, no config change
  that Dray could see. A deliberately keyless third provider configured in
  `models.json` never appeared at all. So the picker is a menu of what the
  reader can actually run, and it is a menu with no fixed length.
- **A model may take no images.** `openai-codex/gpt-5.3-codex-spark` reports
  `input: ["text"]` where every other model on that box reports
  `["text","image"]`. Real, not hypothetical, and the first time Dray's image
  tray has had a reason to ask.
- **Effort is per model and pi already folds it.**
  `get_available_thinking_levels` answers for the *current* model:
  `["off","minimal","low","medium","high"]` for a reasoning model and `["off"]`
  for one without. `thinkingLevelMap` shows pi mapping levels per model on the
  way out, so Dray sending one of its own five is safe.
- **`set_thinking_level` on a model with no levels answers `success: true`.**
  Accepted and ignored — the same trap `--effort` on Haiku already documents,
  and the same cure: this drives the UI and keeps the persisted value honest
  rather than preventing a crash.

### `models.rs` cannot hold this, and the reason is one line

`ModelId` is a **closed enum, and it is persisted** — on the index entry, and
on `dray new --model`. There is no set of variants that covers hundreds of
models across fifteen providers, and even if there were, the right set differs
per machine.

### Proposal: open the id, discover the list, and let pi pick the default

**One.** `ModelId` gains an open form and loses `Unknown`:

```rust
/// What `--model` receives, and what an index entry records.
///
/// Closed for the single-vendor harnesses, whose aliases are a short fixed
/// list where a typo is worth reporting. Open for pi, whose model set is a
/// property of the machine rather than of the CLI.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ModelId {
    Known(KnownModel),  // today's unit variants, serializing exactly as today
    Named(String),      // "anthropic/claude-sonnet-4-5"
}
```

`#[serde(other)]` comes off `KnownModel` for this to work, and losing it is a
gain rather than a cost. Today a retired alias reads back as `Unknown`, which
`find_model` rejects — the string is thrown away, so nothing can say *which*
model a stranded session wanted. With the untagged fallthrough it reads back as
`Named("opus-4-1-20250805")`, `find_model` rejects it for exactly the same
reason, and the sentence can name it. The existing test keeps its guarantee and
changes its name.

The real cost is that **`ModelId` stops being `Copy`.** It is passed by value
in a dozen places. Mechanical, tedious, and slice-0 work.

**Two.** `Model` grows what a discovered entry knows and a static one can leave
empty:

```rust
pub struct Model {
    pub id: ModelId,
    pub label: String,
    pub efforts: Vec<Effort>,
    pub default_effort: Option<Effort>,
    /// pi's provider half. `None` for the single-vendor harnesses, where the
    /// harness *is* the provider.
    pub provider: Option<String>,
    /// From the harness, where it reports one. Nothing needs it yet; the
    /// context ring reads occupancy from the session, not from here.
    pub context_window: Option<u32>,
    /// Whether the composer's image tray can send to this model at all.
    pub accepts_images: bool,
}
```

`accepts_images` earns its place immediately: pi is the first harness where a
picked model may not take images, and a real one on the probe box
(`gpt-5.3-codex-spark`) says so with `input: ["text"]`. The tray should degrade
an image to a path mention there rather than send bytes a provider will reject.

Efforts come from `get_available_thinking_levels`: `["off"]` alone → `efforts:
vec![]`, which is already Dray's convention for a model with no levels.
Anything else → the intersection with Dray's five. `off` and `minimal` are
dropped rather than added to `Effort` — `off` is what an empty list already
means, and `minimal` is folded to `low` by `thinkingLevelMap` on the models
that have it.

**That command describes the *current* model, so one call does not fill a
list.** `models_and_steering.jsonl` is the proof: the same connection answered
five levels, then `["off"]` after a `set_model` to a non-reasoning one. So the
probe has to `set_model` and query per model — N round trips on one child that
is already running, still with no model call in any of them. Reading it once
and applying the answer to every row would give every model the *default*
model's ladder, and be wrong precisely for the model a reader switched to
because it was different.

If N ever gets large enough to matter, the cheap approximation is `reasoning:
true` → the five levels, `false` → none, which matched every model on the probe
box. It is an approximation and should be named as one: `thinkingLevelMap`
varies per model (`gpt-5.5` carries `{xhigh: "xhigh", minimal: "low"}`), so
pi clearly does not treat every reasoning model alike.

**Three.** The list is discovered, and there is a precedent for exactly how.

`models.rs` says today that a static list is kept "rather than read from
`model/list`, which app-server does answer: the picker has to be built before a
session exists, and there is no child to ask until one does." That reasoning is
sound and it is already contradicted elsewhere in this repo:
`harness/claude_code/commands.rs` spawns a throwaway child, writes one
`initialize` request, reads the reply and kills it — 1.5s, 147 commands, no
model call — precisely because the slash-command picker has to exist before a
session does.

pi's probe is cheaper than that one. `pi --mode rpc`, `get_available_models`,
`get_available_thinking_levels`, kill. No handshake to wait through, no model
call, and the answers are the whole picker.

So `list_models` takes a harness and, for pi, returns a probed list rather than
a constant. Cached per process on the Rust side and across mounts on the
frontend, keyed by directory — because `models.json` can be project-scoped and
`.pi/settings.json` is project-scoped and trust-gated. Neither cache
invalidates, so a provider configured while Dray is open needs a restart. That
is the same bargain the command cache already makes, and it should be written
down in the same words.

**Four.** `default_model_for` starts returning `Option`.

```rust
pub fn default_model_for(harness: Harness) -> Option<ModelId>
```

`None` for pi, meaning: pass no `--model` and let pi's own `settings.json`
decide. This is the only honest answer — any constant Dray names might not
exist on the machine, and a spawn that fails with `Model not found` for a model
the reader never picked is the worst possible first experience. It is also the
*right* answer: a pi user has already told pi which model they want, and
overriding that from a third-party wrapper is presumptuous.

`get_state` reports what pi chose, and that is what the composer displays and
what the index entry records. Which means the composer's model picker for pi
starts on a value it *read* rather than one it seeded — a first for that
component, and one `usableModel` needs to be taught.

**And `None` needs somewhere to live, because the index entry is written
first.** `SessionIndexItem.model` is `ModelId`, not `Option<ModelId>`, and it
is written before spawn — so "let pi decide" has to be a value that field can
hold for the window between the entry landing and `get_state` answering.
Today that window is covered by `ModelId::default()` returning `Unknown`, and
this proposal deletes `Unknown`.

So `ModelId` keeps a `Default`, and it becomes `Named(String::new())`: not yet
known, the CLI's own default. One value, one meaning, and it is already what
the empty string reads as everywhere it could reach — `find_model` rejects it
and `as_arg` yields nothing to pass. The real model is written when `get_state`
answers, through a `set_session_model` beside the `set_session_thread_id` that
already exists for exactly this shape of after-the-fact record.

Making the field `Option<ModelId>` is the alternative and it is worse: it is a
persisted schema change on a field every session has, to express a state that
lasts a few hundred milliseconds.

**Five.** `runs_on(id, Harness::Pi)` answers `matches!(id, Named(_))`.

It cannot do better without asking the machine, and it does not need to: the
real check is pi's own `Model not found: nope/nope`, a sentence naming exactly
what was wrong, arriving on a `set_model` response that Dray is already
awaiting. The function's job is only to stop a Claude alias reaching a pi spawn,
and it does that.

### What this does not solve

Model *identity across machines*. A session created by `dray new --model
anthropic/claude-sonnet-4-5` on one machine and opened on another where that
provider has no key will fail at the spawn with a readable sentence and no
fallback. That is correct — silently running a different model is the thing
`from_arg`'s strictness exists to prevent — but it means a pi session's model
is meaningfully less portable than a Claude one's, and orchestration inherits
it. Worth a line in the `dray` skill.

## 8. Event mapping

`turn_id` stays `None` — pi has no turn identifier on the wire and Dray's
transcript groups by user message anyway, which is the reasoning Claude Code
already documents. `subagent` is always `None` (§9). `harness: Pi`.

### `BlockRef` has to be minted

pi's deltas carry `contentIndex` and nothing else. There is no message id — the
assistant message has `timestamp` and an optional provider-supplied
`responseId`, neither of which is a usable key. So the mapper keeps a counter,
increments it on `message_start{role: "assistant"}`, and `BlockRef` becomes
`{message_id: format!("{session}:{n}"), index: contentIndex}`.

**And blocks overlap.** The captured order inside one message is:

```
thinking_start(0)  thinking_delta(0)…  text_start(1)  text_delta(1)…
toolcall_start(2)  toolcall_delta(2)…  toolcall_start(3)  toolcall_delta(3)…
thinking_end(0)  text_end(1)  toolcall_end(2)  toolcall_end(3)
```

Every `*_end` arrives in a batch at the end, after every `*_start`. So a mapper
that treats an end as "the current block closed" closes the wrong one, and a
frontend that assumes one open block at a time is wrong for pi even though it
happens to be right for Claude. `BlockRef` carries the index, so the model
holds; the assumption to avoid is in any code that keeps a single "current
block" variable.

### Items → payloads

| pi | `AgentEventPayload` | notes |
|---|---|---|
| `get_state` response (after spawn) | `SettingsChanged(Settings{model, approval_policy, …})` | The handshake. pi emits nothing on spawn, so this is the only place a session's configuration is reported |
| `agent_start` | `TurnStarted(SessionInfo{cwd, model, harness_version})` | §2 |
| `turn_start` | `ModelRequestStarted` | §2. Not persisted |
| `turn_end` | `None` | The assistant message and tool results it carries have both already arrived as their own events |
| `agent_end` | `None` | §2. **Not** a boundary |
| `agent_settled` | `TurnCompleted{status, stop_reason, final_text, usage, head}` | §2. `status` and `final_text` from the turn's last assistant message — see *Failure* below |
| `message_start` `role: user` | `None` | The echo. Dray mints its own `UserMessage` with `baseline`, `images` and `issues`, none of which the echo carries — the same drop Codex needs |
| `message_start` `role: assistant` | `Delta(BlockStart)` per block, as blocks open | pi opens blocks with `*_start` deltas, not here; this event only advances the message counter |
| `message_update` `thinking_start` | `Delta(BlockStart{block_type: Thinking})` | |
| `message_update` `thinking_delta` | `Delta(TextDelta)` | `TextDelta` carries thinking text too — the shapes are identical and `BlockStart` already said which kind. **These carry real text**, unlike Claude Code's, so the thinking block draws from its first frame rather than sitting blank until commit |
| `message_update` `text_start` / `text_delta` | `Delta(BlockStart{Text})` / `Delta(TextDelta)` | |
| `message_update` `toolcall_start` | `Delta(BlockStart{ToolUse{id, name}})` | Carries `id` and `toolName`, so the streaming preview can name the tool at 0ms and stream the path in — the split CLAUDE.md's *tool call drawn before its arguments arrive* describes, working here with nothing new on the wire |
| `message_update` `toolcall_delta` | `Delta(InputDelta{partial_json})` | Keyed by `contentIndex` alone — the delta carries no tool id |
| `message_update` `*_end` | `Delta(BlockStop)` | Order is not nesting order; see above |
| `message_end` `role: assistant` | `Reasoning{block, text}` + `AssistantText{block, text}` per content block | Committed wins. `thinkingSignature` dropped. Tool calls in `content` are **not** mapped here — `tool_execution_start` is the one that draws the row |
| `message_end` `role: toolResult` | `None` | **The second copy.** `tool_execution_end` already carried it, with `isError` beside it. Mapping both draws every tool result twice |
| `tool_execution_start` | `ToolCallStarted{call_id: toolCallId, name: toolName, tool_type, input: args}` | `tool_type` from the name: `read`/`ls` → `FileRead`, `bash` → `Shell`, `write`/`edit` → `FileEdit`, `grep`/`find` → `Search`, else `Other` |
| `tool_execution_update` | `None` | `partialResult` is accumulated, not a delta. Parsed and dropped, so the failure log stays a signal. Same gap Codex's `outputDelta` leaves — see *No home* |
| `tool_execution_end` | `ToolCallCompleted{result: {text: flattened content, is_error: isError}}` | A blocked call arrives here with `isError: true` and the reason as its text (§6) |
| `bash_execution_update` | `None` | Output of the RPC `bash` command, which Dray never sends |
| `queue_update` | `None` | Dray owns its own queue and draws it; a second opinion would need reconciling |
| `compaction_start` | `ContextCompactionStarted` | `reason` is `manual`/`threshold`/`overflow` |
| `compaction_end` | `ContextCompacted{trigger: reason, pre_tokens: result.tokensBefore, post_tokens: result.estimatedTokensAfter}` | `result` is **absent**, not null, on the failure path — captured. `errorMessage` there → a second `Error{fatal: false}` |
| `auto_retry_start` | `ApiRetry{attempt, max_retries: maxAttempts, reason: errorMessage}` | pi reports a real ceiling, unlike Codex. The retry indicator needs no zero-ceiling tweak |
| `auto_retry_end` `success: false` | `Error{source: Harness, fatal: false, message: finalError}` | |
| `auto_retry_end` `success: true` | `None` | The next event *is* the proof it worked, which is the rule the indicator already uses |
| `summarization_retry_*` | `None` | A retry inside compaction. The compaction indicator is already up and says the true thing |
| `extension_error` | `Error{source: Harness, fatal: false}` | One row. Our own extension throwing is the case worth seeing |
| `extension_ui_request` `confirm` | `PermissionRequested{…}` | §6 |
| `extension_ui_request` others | `None`, and refused from the reader task | §6 |

### Failure, and the abort trap

pi has no error event. A failed model call is an assistant message with
`stopReason: "error"` and `errorMessage`, and `agent_end` closes the run
normally. So `TurnCompleted.status` is read off the turn's last assistant
message:

- `stopReason: "stop"` / `"toolUse"` / `"length"` → `Success`
- `stopReason: "error"` → `Error`, `final_text: errorMessage`

`final_text` is what the row draws, which is CLAUDE.md's rule already: the
harness's own sentence, never the wire token. `rawStopReason` goes on
`stop_reason` and is never drawn.

**The trap is abort.** A user Stop produces `stopReason: "error"` with
`errorMessage: "This operation was aborted"` — not the `"aborted"` the docs
list, and captured twice. Mapped naively, every Stop draws a failed turn saying
"This operation was aborted", which is noise about something the reader just
did.

The cure is the one Claude already uses: **Dray knows it asked.** Claude
suppresses `aborted_streaming` and `aborted_tools` because they are the
reader's own Stop; here the session records that it sent `abort` and the mapper
suppresses the next `error` turn on that flag rather than on the sentence.
Matching the sentence would work today and break the day it is reworded, in the
direction that draws a failure — the wrong direction to be wrong in.

### Context occupancy is a pull, not a push

`get_session_stats.contextUsage` is `{tokens, contextWindow, percent}` and it
is the figure pi computes for its own footer. `tokens.total` sits beside it and
is session-cumulative — the exact trap `result.usage` and `tokenUsage.total`
both set. In `resume.jsonl` they read 2840 and 8960 for the same session.

**The ring reads `contextUsage`.** But it is a command, so Dray has to ask: one
`get_session_stats` on `agent_settled`, folded into `TurnCompleted.usage`
before the event is emitted. One round trip per turn, no model call, and the
number is exact rather than derived — no summing of four disjoint counts, no
per-model window table.

Two edges the docs name and a capture should confirm: `contextUsage` is
**omitted** when no model or window is available, and its `tokens`/`percent`
are **null** immediately after a compaction until a fresh assistant response
lands. Both are already `Option` on `ContextWindow`, and the ring already reads
`context_compacted` as settling `used` even with no count — so both degrade the
way the existing design expects.

**And deriving it from the stream is not an option.** On a real provider,
`usage` on `message_update` was `{input: 0, output: 0, cacheRead: 0}` for all
54 deltas of a three-call turn — pi's docs hedge that it "may remain zero until
completion when a provider does not report usage during streaming", and xAI is
such a provider. The scripted provider populated it, which is exactly the shape
of mistake the live capture exists to catch: a ring built against the stub
would read zero on a real session and show an empty gauge with nothing saying
why.

So the per-message `usage` feeds `UsageUpdate` (emitted, never persisted) and
nothing else, and `message_end.message.usage` — which *is* populated — is the
fallback if `get_session_stats` ever proves too slow to ask on every turn. Its
`cost` field has no home in Dray at all and is dropped: pi is the first harness
to report money, and a surface for it is a product decision, not a mapping one.

### Gaps, both directions

**pi → Dray, dropped on purpose:** `queue_update`, `bash_execution_update`,
`tool_execution_update`, `turn_end`, `agent_end`, the `toolResult` message
echo, the `user` message echo, and every fire-and-forget extension UI method.
Each costs a parsed-and-`None` so the failure log stays a signal.

**pi → Dray, no home and worth one later:**

- **Live tool output.** `tool_execution_update.partialResult` is the accumulated
  output of a running command. Codex leaves the same gap with `outputDelta`, so
  this is now two harnesses wanting one variant — `ToolCallProgress{call_id,
  text}`, emitted and never persisted, like `Delta`. CLAUDE.md's rule for
  `packages/` applies: the second user is what earns the shared thing, and it
  has arrived.
- **Cost.** pi reports it per message and per session. No surface.
- **The session tree.** `get_entries` returns an append-only tree with stable
  ids, including pre-compaction history and abandoned branches. Dray's log is
  the transcript and this is deliberately not read — the same rule Codex's
  `turns` and Claude's replay log already follow — but it is what a
  fork-at-message picker would be built from.

**Dray → pi, expressed differently or absent:**

- **`PermissionDenied`** — the no-channel refusal. pi never refuses a tool on
  its own, so this cannot arrive. Under `BypassPermissions` there is nothing to
  refuse; under every other stance the refusal is ours and arrives as a blocked
  tool result.
- **`BackgroundTasksChanged`** — pi has no background task set. `bash` is
  synchronous in the agent loop and `abort_bash` stops it. So the set stays
  empty, `has_outstanding_work` reads the model call alone, and Stop needs no
  fan-out. Simpler than Claude, and worth knowing: a dev server started by a pi
  session is a child pi is blocked on, not a task it reports.
- **`Hook`** — pi's extension events are not hook runs. Nothing to map.
- **`FileEdits`** — pi's `edit` tool reports `{path, edits: [{oldText,
  newText}]}` in its arguments, which is very nearly `FileEdit` already. Not
  mapped in the first slices: the `ToolType::FileEdit` row draws a diff from
  the arguments the way Claude's does, and `FileEdits` exists for a harness
  that reports changes as a first-class item, which pi does not.
- **`@file` mentions.** pi expands `@files` as a *CLI argument*, not inside an
  RPC `prompt`. The docs list only skill commands and prompt templates as
  expanded on that path. So the composer's `@` picker **goes dark for pi**
  until a capture says otherwise. A picker that inserts a mention the agent
  silently ignores is worse than no picker — the reader believes they attached
  something.

**No new persisted variant in slices 0–3.** Every candidate above is either
not persisted, or a surface Dray does not have.

## 9. What the composer has to change

| control | pi |
|---|---|
| harness picker | one more entry, and one more agent for `agent_availability` to report on |
| model picker | **discovered, not constant** (§7). Async for the first time, and seeded from what pi reports rather than from a Dray default |
| effort picker | driven by the picked model's `get_available_thinking_levels`. A model with `["off"]` shows none, which is the existing empty-`efforts` path |
| permission mode | **Plan is shown** (§6) — unlike Codex. `acceptEdits` stays gone, as everywhere. `Auto` means something weaker than it does elsewhere and its copy should say so |
| project / branch pickers | unchanged |
| worktree toggle | unchanged (§10) |
| image tray | works — `prompt.images` takes base64 with a mime type, the same shape Claude takes. New: gate on the picked model's `input` including `image` |
| `/` picker | **better than Claude's.** `get_commands` answers on the live connection, so no throwaway child. Sources are `extension`, `prompt` and `skill` — and pi reads `~/.agents/skills`, which is the same directory Claude reads, so a reader's skills are already there |
| `@` picker | dark (§8) |

### Subagents

pi has none. `docs/extensions.md` describes sub-agents as something an
extension provides, and no built-in tool spawns one. So:

- `AgentEvent.subagent` is always `None` for pi.
- The Subagents panel's tab hides, the same way the PR tab hides with no PR.
- If a reader installs an extension that provides subagents, its work arrives
  as ordinary tool calls with no envelope and no id to join on — pi's wire
  carries nothing to correlate them by. Drawn inline as tool calls, which is
  honest, and better than a panel that shows a run nothing can close.

`ToolType::SubagentSpawn` is therefore unreachable for pi, and Dray's own
orchestration is unaffected: `dray new` spawns *sessions*, not subagents, and a
pi session can spawn them exactly as a Claude one can.

### The missing-CLI notice

`Harness::Pi` needs `label()`, `install_command()` and `docs_url()`, and
`every_agent_names_its_own_cure` will fail until it has all three — which is
what that test is for. The install command is pi's own installer, not an npm
line, for `harness.rs`'s stated reason.

**And the version gate needs a second sentence.** `agent_availability` today
answers "can this run here". For pi there is a third state: installed, runnable,
and too old (§3). The notice has to say *upgrade*, not *install*, or the reader
runs an install command for something they already have.

## 10. Worktrees

Free, and freer than for Codex.

pi has no `-w`, so Dray takes the route it already built for `dray new --from`:
`create_worktree(cwd, name, base)` runs `git worktree add --no-track -B
worktree-<name> <path> <base>`, and the child spawns *into* a tree that already
exists. `owned_worktree` is true for every pi worktree creation, and the default
base comes from `base_ref_tree`'s resolution, exactly as it does for Codex.

Everything that falls out for Codex falls out here: the baseline is a real
`snapshot_tree` rather than an approximation, there is no CLI lock so
`remove_worktree`'s unlock step is a no-op, and fork-in-worktree can take the
parent's branch tip as its base.

One thing that does *not* fall out, and it is a relief. CODEX-PLAN.md §7 flags
a linked worktree's `.git` file as a real risk: the gitdir lives outside the
sandbox's writable root, so every commit might escalate to an approval or be
denied outright. **pi has no sandbox**, so there is nothing to escalate to and
nothing to deny. `git commit` inside a linked worktree is an ordinary child
process. The open question Codex still carries does not exist for pi.

The path convention is unchanged — `<project>/.claude/worktrees/` on branch
`worktree-<name>` — because `worktree_path`, `session_branch`,
`remove_worktree`'s shape guard and `backfill_removed_worktrees` all key on
that shape. It is Dray's convention now, not Claude's, and a third harness is
not a reason to split four functions.

## 11. Sending, steering, stopping

### Send

`{"id": <n>, "type": "prompt", "message": "…", "images": [{type, data, mimeType}]}`,
awaiting the response. `success: false` means rejected before acceptance and is
worth surfacing; `success: true` means accepted and nothing more.

### Steering is real, and Dray's queue should use it

Claude holds a mid-turn prompt until a boundary because it injects a buffered
prompt at the next tool result and nowhere sooner. pi takes it directly:

```
{"type":"prompt","message":"…","streamingBehavior":"steer"}
```

delivered "after the current assistant turn finishes executing its tool calls,
before the next LLM call" — which is the same boundary Claude's queue flushes
at, reached without Dray holding anything. A bare `prompt` sent mid-turn is
refused, with a sentence naming the cure:

> `Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.`

So `queue_msg` for pi sends immediately with `streamingBehavior: "steer"` and
marks the `UserMessage` `queued: true`. The transcript rule that a queued
prompt does not abandon open tool calls still holds — it is the same turn.

`set_steering_mode` defaults to `one-at-a-time`, which matches how Dray's queue
already behaves. Left alone.

### Stop is two commands, and one is not optional

`abort` takes no arguments — simpler than Codex, which refuses `turn/interrupt`
without a `turnId`. But `abort` alone does not stop a session that has anything
queued: pi's own docs say "abort continues queued messages when they remain in
the session", and `models_and_steering.jsonl` shows it — an abort, then a
`turn_start` for the steer that was waiting.

So **Stop is `clear_queue` then `abort`**, in that order, which is also the
order pi's docs recommend for a client's Esc key. `clear_queue` returns the
text it dropped, which Dray should put back in the composer draft rather than
discard — `useDraft` already keys by session and this is the same restore the
docs describe.

This is structurally the same conclusion Claude's Stop reached: an interrupt
plus a fan-out, because the interrupt alone left the session held open by
something else. Different mechanism, same shape, and the same failure if it is
missed — a Stop that acknowledges and changes nothing.

### Compaction

`{"type": "compact"}`, and `/compact` typed in the composer is recognised in
`deliver_prompt` and becomes that command. Everything else beginning with `/`
is a real pi command, expanded by pi itself from `get_commands` — so unlike
Codex, `/` is not prose here.

## 12. Fixtures and testing

`harness/pi/fixtures/` holds eleven captures, wrapped both directions:
`{"dir": "in"|"out"|"err", "t": <ms>, "line": "<raw>"}`. The wrapper is the
Codex convention and `t` is added, because it is what shows that a `*_end`
delta lands after two later blocks have started.

The fixtures README maps each file to what it pins and says which ran against
the scripted provider. `scripts/pi-capture/` re-runs any of them.

### Test layers

1. **Wire types.** Every `out` line in every fixture deserializes to
   `PiEvent | PiResponse`, none to the catch-all, and the catch-all count is
   asserted zero per fixture — so a new event type in a recapture fails loudly
   rather than silently drawing nothing.
2. **Mapper.** Exact event counts per fixture, the way `complex.jsonl` is
   asserted. Plus two structural assertions pi specifically needs: every
   `TextDelta` has a `BlockStart` before it with the same ref and a committed
   event after it, and **`no_approvals.jsonl` closes exactly one turn** — the
   assertion that catches a mapper reading `agent_end` as a boundary.
3. **Approvals.** `extension_approvals.jsonl` through the reader: each
   `extension_ui_request` registers a pending entry and emits one event, each
   option id serializes to the recorded reply, and the blocked call's
   `tool_execution_end` retires the row.
4. **Stop.** `abort_and_queue.jsonl` asserts that a Stop emits `clear_queue`
   before `abort`, and that the `error` turn following it draws nothing.
5. **The extension is tested by being run**, not by being read. A `#[ignore]`d
   test spawns a real pi against the stub provider, gates one tool call and
   denies it — the counterpart to Codex's `handshake_against_a_live_server`,
   and the one that would catch pi renaming `tool_call` or changing the block
   return shape. Fixtures replay a recording; this holds a conversation.
6. **Event-model compatibility.** Unchanged. And the existing trap applies: a
   filtered `cargo test pi::` rewrites `src/types/events.ts` with only what
   ran. Follow with a bare `cargo test`.

Nothing runs a real model in CI.

## 13. Staging

### Slice 0 — make room (no pi code)

- `ModelId` opens (§7). `Copy` comes off; callers follow. `Unknown` goes, and
  its test keeps its guarantee under a new name.
- `Model` grows `provider`, `context_window`, `accepts_images`.
- `default_model_for` returns `Option<ModelId>`; `send_msg` omits `--model`
  on `None`.
- `list_models` takes a harness and may probe.
- `SessionIndexItem.pi_session_path`, `#[serde(default)]`. **Not** a rename of
  `thread_id` — see §4 for why that loses every Codex session's handle.
- `Harness::Pi` with its label, install command and docs URL; `binpath` learns
  `pi` and its version floor.

Its own PR, and **three tests have to be written before it is shippable.** The
existing suite does not cover this slice, and an earlier draft claimed it did:

- **A whole-index round trip.** Every field of a real `SessionIndexItem` out and
  back with no loss, including `threadId` and the `unknown` map. This is the one
  that would have caught the rename (§4), and nothing like it exists — the
  `store.rs` tests build items and assert on behaviour, never on the bytes.
- **`ModelId` round-tripping every shipped alias.** The untagged enum must
  deserialize `"opus"` to the closed half and `"anthropic/claude-…"` to the open
  one, and `Default` must be the empty `Named`. `model_ids_serialize_as_bare_aliases`
  covers the Claude half of the serialize direction only.
- **`every_agent_names_its_own_cure` over every variant.** It iterates a
  hardcoded `[ClaudeCode, Codex]`, so a third harness with no install command
  passes it. It should iterate the variants rather than a literal, which turns
  it into the test its doc comment already claims to be.

The rest of the slice — the `Copy` removal, `list_models` taking a harness — is
pinned by the compiler and by tests that do exist.

### Slice 1 — a pi session on screen

- `harness/pi/{pi.rs, parser.rs, mapper.rs}`. No `rpc.rs`: pi's framing is a
  line reader and a response map, which is smaller than Codex's client and
  shares nothing with it.
- Spawn, `get_state` handshake, `--session` path, `BypassPermissions`
  regardless of the picked mode — nothing asks, nothing stalls, and the
  permission layer is not built yet.
- Map: the three lifecycles, deltas, `tool_execution_*`, the two echoes
  dropped, failure from `stopReason`, `get_session_stats` on settle.
- Resume by respawning on the same path. Stop as `clear_queue` + `abort`.
- Composer: harness picker, discovered model list, discovered effort levels.
- Fixtures: `no_approvals`, `abort_and_queue`, `resume`, `failed_turn_live`.

Done when a pi session runs a multi-tool turn, the transcript draws it with a
streaming preview, the ring fills, Stop stops it, and reopening the app resumes
it.

### Slice 2 — approvals

- The embedded extension, written on spawn, loaded with `-e`.
- `PermissionRequested` from `confirm`, the three options, the per-session
  allow set, `{cancelled: true}` for the other dialog methods.
- The mode table: `--tools` for Plan, gate sets for the rest, no `-e` for
  Bypass. Mode change respawns.
- Fixtures: `extension_approvals`.

### Slice 3 — worktrees, fork, orchestration

- `owned_worktree` for every pi worktree; base from `base_ref_tree`.
- Fork by copying the session file. Guard on `turn_in_flight`.
- `dray new --harness pi` end to end, including `--from`.
- Steering for queued prompts.
- Session file deleted with the session.

### Slice 4 — the rest

- `/` picker from `get_commands`. Compaction events. `auto_retry_*` into the
  retry indicator. `ToolCallProgress` for live tool output, shared with Codex
  since the second user now exists. Image gating on the model's `input`.
  Fork at a chosen message.

### Later, and not promised

Cost reporting. Reading `get_entries` for a fork-at-message picker. Anything to
do with running pi in a container, which is pi's own answer to the sandbox
question and currently outside what Dray says anything about.

## 14. Open questions, and what settles each

| question | settled by |
|---|---|
| Do other providers through pi fragment tool arguments, or report usage mid-stream? xAI does neither | one capture each against Anthropic and OpenAI. Neither changes a mapping — only how much the streaming preview buys |
| Does `fork {entryId}` hijack the running process the way `clone` does? | one capture; assumed yes, written against the pattern |
| Does a tool registered by an extension reach `tool_call` under its registered name? §6's `Auto` allowlist assumes so | a capture with an extension registering a mutating tool. Wanted before slice 2 |
| Can two `extension_ui_request`s ever be outstanding at once? The docs say preflight is sequential | a capture that leaves the first unanswered while a sibling call preflights |
| What does an unanswered `extension_ui_request` do to the turn — block forever, or is there a floor timeout? | a capture that answers nothing and waits |
| Does `--tools read,grep,find,ls` really refuse a write, or does the model get a tool that errors? | a capture under Plan mode asking for a write |
| Is `~/.dray/pi-sessions/<id>.jsonl` safe as a session path when `--session-dir` is not passed, or does pi expect its own layout? | it worked in every capture here; confirm against a resumed session with compaction history |
| How long does the model probe take on a machine with several providers configured? | timing on a real multi-provider install; if it is slow, the picker needs the command cache's freshness window rather than a plain `OnceLock` |
| Does pi's own `settings.json` default model change under the reader while Dray holds a cached list? | the same restart bargain the command cache makes; confirm it reads acceptably |

## 15. What this deliberately does not do

- **No sandbox, and no pretending.** pi does not have one and Dray will not
  build one. The approval gate is a gate on *asking*, not on *capability*, and
  §6 says so where a reader will see it.
- **No reading pi's session file.** Dray's log is the transcript. `get_entries`
  and `get_messages` are received and ignored, the same rule Claude's replay
  log and Codex's `turns` already follow.
- **No writing to `~/.pi/agent/`.** Not the extension, not `models.json`, not
  settings. That directory is the reader's, and a wrapper that edits it changes
  their terminal sessions too.
- **No `bash` RPC command.** pi will run a shell command and fold the output
  into context. Dray has a handoff row for asking the *agent* to do things, and
  a second route that bypasses the agent is a second thing to explain.
- **No model catalogue.** Dray offers what the machine can run and nothing
  more. Listing models the reader has no key for is a picker full of failures.
- **No session names.** pi has them, Dray owns titles, and neither should learn
  about the other's.
- **No npm install path.** `Harness::Pi::install_command()` names pi's own
  installer, for the reason `harness.rs` already gives: running someone else's
  install for them makes a failure inside it ours to debug.
