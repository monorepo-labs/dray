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
called out where they matter (§7, §9). That is the whole reason the live pair
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
  cannot be derived from streaming, which makes §9's pull-not-push design
  necessary rather than merely tidier.
- **pi streams real reasoning text.** 41 non-empty `thinking_delta` frames in
  one turn. Claude Code streams `thinking_delta` frames carrying `""` — the bug
  CLAUDE.md documents as 53 zero-length reasoning events and 83.8s of blank
  screen. pi's thinking block is worth drawing from the first frame.

## TLDR for human

- **Approvals: pi has none, so Dray ships one.** A small pi extension, embedded
  in the binary and written to a content-hashed path on spawn, hooks
  `tool_call` and asks with `ctx.ui.select` — not `confirm`, whose bridge
  collapses every reply to a boolean and would drop a remembered grant on the
  floor. That surfaces as `extension_ui_request` and Dray's existing card
  answers it. For the first time the permission options are Dray's own, because
  pi composes none. **The gate fails open with no sandbox under it**, so the
  extension announces itself on load and a gated session refuses to start until
  it has.
- **Session identity: `--session <path>`.** Dray picks the path from its own
  session id, so it stays derivable and index-before-spawn is untouched. One
  new nullable field covers the fork case. Generalising the existing
  `thread_id` instead looked tidier and would strand every Codex session in
  silence — the key on disk is `threadId`, so the alias matches nothing.
- **Models: the list is a property of the machine, so it has to be asked for.**
  A throwaway `pi --mode rpc` child answers `get_available_models` and
  `get_available_thinking_levels` with no model call — the same trick
  `commands.rs` already uses for Claude's slash commands. `ModelId` becomes a
  `ModelId(String)` newtype — the shape it already serializes as — and
  `default_model_for` starts returning `Option`, because for pi the honest
  default is pi's own. **A shipped 0.9.x opened beside this build rewrites every
  pi model id to `"unknown"`**, which cannot be fixed from this side and is
  written down rather than papered over.
- Turn boundary is `agent_start` → `TurnStarted`, `agent_settled` →
  `TurnCompleted`, `turn_start` → `ModelRequestStarted`, `agent_end` → nothing.
  Getting this wrong is the single most likely way to strand a session.
- Stop answers every outstanding permission request, then `clear_queue`, then
  `abort` — release what the child is blocked on before telling it to stop. The
  aborted turn is suppressed on Dray's own knowledge that it asked, not on a
  stop reason.
- **A third harness is what makes the seam worth lifting.** `session.rs` branches
  on harness in eight places and six of them are equality tests a new variant
  slips past silently. One per-harness driver, in slice 0.
- **Dray's own rules have to reach the agent.** Both existing harnesses inject
  them at spawn and none of this document did; without
  `--append-system-prompt` and a skill directory pi reads, a pi session runs and
  cannot be orchestrated.
- Worktrees are free — the `create_worktree` path Codex already takes, and with
  no sandbox to fight, the linked-worktree `.git` question Codex opened does not
  arise.
- Zero new persisted `AgentEventPayload` variants. Every pi event has a home or
  is dropped on purpose.
- Subagents do not exist in pi. The panel stays hidden.

---

## Where the build is

Kept here rather than in a second file: the slice lists are in §14, and a status
doc that lived apart from them would drift the first time one changed. Update
this section in the same commit that moves a line of it.

Branch `pi-harness-plan`, Linear **DRA-102**. Verified live against pi **0.84.4**:
a multi-tool turn reaches the transcript with reasoning, tool call, result,
answer, token usage and `completed`.

**Slice 0 — done**, except one item deliberately dropped and one not needed yet.
`ModelId` is a newtype, `Model` carries `arg`/`provider`/`accepts_images`,
`default_model_for` answers `Option`, `list_models` takes a harness (and is now
async, since pi's list is a read). The eight scattered `harness ==` sites are one
capability table. `binpath` finds pi. **No version floor** — see §3, the model
probe asks the real question. **`pi_session_path` not added**: the derived path
is enough until fork needs pi's own, so the field lands with slice 3.

**Slice 1 — done, with one gap that matters.** Spawn, handshake, `--session`,
the discovered model list and per-model effort ladders, the three lifecycles,
deltas, tool calls, failure from `stopReason`, resume, Stop, the system prompt,
`~/.agents/skills/dray/`, and `dray new --harness pi` end to end.

The gap: **the stance picker is hidden and every pi session runs ungated.** §14
called for Plan and Bypass, where Plan is `--tools read,grep,find,ls` — a flag,
no extension, genuinely read-only. Only Bypass shipped, so a reader who wants a
pi session that cannot write has no way to ask for one. Slice 2 is what fixes
this properly; Plan is the cheap half and should not wait for it.

**Slice 2 — not started.** No approvals, no extension, no gate.

**Slice 3 — half.** Worktrees and orchestration work. Fork is refused outright,
`--from` is untested against pi, and steering is not wired.

**Slice 4 — not started.**

Smaller things known missing, none of them blocking: the pi session file is not
deleted with its session, pi's lowercase tool names (`bash`, `read`, `edit`)
have no `TOOL_VERBS` entry so rows draw the raw name, and pi's mark has no
credit in the root README.

**Two rules that are only remembered, and both fail silently.** Never kill a pi
— every teardown goes through `pi::shutdown`, and a fourth path reaching for
`child.kill()` regresses with no test firing (see *A pi must be asked to leave*
in §3). And an unmodelled inbound request hangs the session forever:
`PiEvent::Unknown` is a unit variant, so a request type pi adds later loses its
id and cannot be refused, where `extension_ui_request` is answered.

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

### A pi must be asked to leave, never killed

Found while wiring the spawn, and it is the sharpest edge in this whole
document because everything about it fails *silently and one process late*.

pi takes `~/.pi/agent/auth.json.lock` — a mkdir lock — while it runs. A clean
exit releases it. A `SIGKILL` does not, and the next pi to start waits that
stale lock out for **~30s** before it answers a single command. Measured, on
0.84.4: no lock 0.22s, stale lock 29.33s, and a clean exit restores 0.25s.

So the cost of killing a pi is never paid by that pi. It is paid by the next
one, which is a different session, usually a different feature, and looks
exactly like Dray hanging. Three things fell out of one first draft that killed
its children:

- The model probe killed its child on every picker read, so the session spawned
  right after the picker opened took 30s.
- A spawn whose handshake timed out killed its child, so the *retry* inherited
  a fresh stale lock and failed the same way. A loop that feeds itself.
- The 10s handshake bound could never be met with a lock in the way, which is
  what turned a slow start into a session that could not be started at all.

Two rules, and both are needed. Every path that stops a pi goes through
`pi::shutdown` — close stdin, wait, kill only if it overstays. And the first
command's bound is **45s**, wide enough that a lock left by something Dray does
not control (a crash, the reader's own pi in a terminal) costs a slow start
rather than a failure they can do nothing about.

`DRAY_PI_TRACE=1` echoes every line read off pi. A line that reaches the mapper
and draws nothing is otherwise invisible — not a parse failure, so not in
`parse_failures.jsonl`; not a mapped event, so not in the session log.

### The version gate is not optional

`binpath::pi()` has to ask the binary its version and refuse below **0.80.6**,
the way `binpath::codex()` asks a candidate whether it lists `app-server`. The
failure it prevents is worse than Codex's: a stale `codex` times out loudly at
the handshake, where a 0.74.x `pi` runs a turn perfectly and simply never ends
it. Every session started against one would sit `in_progress` forever, with
Stop as the only exit, and nothing on screen saying why.

`pi --version` prints a bare semver and costs one spawn, cached in the
`OnceLock` like every other resolution. Refusal reaches the reader as the
missing-agent notice §10 describes, with a version in the sentence.

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
returning `{ block: true, reason, terminate? }` stops the call. In RPC mode a
`ctx.ui` dialog emits `extension_ui_request` on stdout and blocks until an
`extension_ui_response` with the matching id comes back on stdin.

That is the whole mechanism, and `extension_approvals.jsonl` is it working end
to end against a five-line extension. The capture uses `confirm`, because it
was probing whether the channel works at all; the shipped gate uses `select`
for the reason two subsections down:

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

Embedded in the Rust binary with `include_str!` and written under `~/.dray/pi/`
on spawn, then passed as `-e <path>`. This is the `dray skill install` pattern
and it is chosen for that pattern's reason: the extension and the code that
answers its requests travel in the same binary, so one describing a protocol
the other does not speak is impossible.

Not `~/.pi/agent/extensions/` — that is the user's own directory and a globally
installed extension would gate their terminal sessions too.

**The filename carries a hash of the contents**
(`dray-approvals-<hash>.ts`), written temp-then-rename and never rewritten once
it exists. A fixed name breaks the "same binary" claim outright: two Dray builds
share `~/.dray` by design, so whichever spawned last owns the file, and a
release binary answering a dev build's extension is exactly the disagreement
this section says is impossible. The `dray-dev.sock` split is the same problem
already solved once, and the precedent to follow rather than repeat.

**The gate fails open, and there is no sandbox underneath.** If `-e` fails to
load — a syntax error, a pi release that renames `tool_call`, a half-written
file — pi runs every tool with nothing asking, under a stance whose whole
promise is that it asks. Codex could survive the same failure because
`workspace-write` was still enforced by the OS. pi has nothing.

So loading has to be *observed*, not assumed: the extension fires a
fire-and-forget `notify` marker as it registers, and `pi.rs` refuses to deliver
the first prompt under any gated stance until it has seen it, with a readable
timeout naming the extension path. One marker, one line, and it turns a silent
ungated session into a session that will not start.

The `#[ignore]`d live test in §13 is not a substitute. It catches drift on the
machine of whoever runs it; the handshake catches it on the reader's.

### The options are Dray's own, for the first time

Claude sends `permission_suggestions` and Codex sends `availableDecisions`.
CLAUDE.md's rule — "options the user sees are the CLI's, not ours" — has no
counterpart here, because pi composes nothing. So the card's list is written in
Rust and honest about being narrow:

**The gate asks with `select`, not `confirm`, and that is forced.** A three-way
question needs a three-way answer, and pi's `confirm` bridge cannot carry one:

```ts
confirm: (title, message, opts) =>
  createDialogPromise(opts, false, {…}, (r) =>
    "cancelled" in r && r.cancelled ? false : "confirmed" in r ? r.confirmed : false),
```

Every response is collapsed to a boolean before the extension sees it, so any
extra field Dray added — a `remember` flag, say — is discarded in the bridge
and never reaches the handler. `select` is built the other way: its bridge
returns `r.value`, the chosen string, verbatim. So the option strings are the
transport.

| option id | label | kind | the `value` sent back |
|---|---|---|---|
| `once` | Allow once | `Once` | `"allow-once"` |
| `tool` | Always allow `<tool>` | `AlwaysRule` | `"allow-tool"` |
| `deny` | Deny | `Deny` | `"deny"` → `{block: true, reason: "Denied in Dray"}` |

Cancelled or timed out → `undefined` → denied, the same fail-closed reading
`confirm` gives.

**The allow set lives in the extension, not in Rust**, and that is a real
decision rather than an implementation detail. If Rust held it, Rust would have
to answer the next request for that tool without asking — which works, but
means every remembered grant still costs a full round trip through a process
boundary, and means the *extension* cannot tell an allowed call from an ungated
one. Held in the extension, a remembered grant means no request is ever
emitted. The frontend still answers with an option id and nothing else, which
is the invariant that actually matters; Rust maps that id to one of the three
strings above.

An earlier draft put the grant in a field on the reply. It could not have
worked, and it would have failed in the quietest way available: the grant is
dropped in pi's bridge, the extension asks again on the next call, and "always
allow" reads as a button that does nothing.

Per-session, never persisted. A standing grant that outlives the window is a
promise pi gives Dray no way to keep — there is no rule store to write to and
no policy for a next session to read.

`AlwaysDirectory` and `SwitchMode` are not offered: pi has no path scoping and
no mode to switch into mid-session.

### The whole extension UI surface, read out of the RPC bridge

Everything below is `createExtensionUIContext` in `dist/modes/rpc/rpc-mode.js`,
so it is what pi *does* rather than what its docs say. Six methods reach the
wire, all as `extension_ui_request`, and they split in a way Dray has to respect
because half of them must not be answered:

| method | fields | answered with | on cancel/timeout |
|---|---|---|---|
| `select` | `title`, `options`, `timeout?` | `{value}` | `undefined` |
| `confirm` | `title`, `message`, `timeout?` | `{confirmed}` | `false` |
| `input` | `title`, `placeholder`, `timeout?` | `{value}` | `undefined` |
| `notify` | `message`, `notifyType` | **nothing** | — |
| `setStatus` | `statusKey`, `statusText` | **nothing** | — |

`onTerminalInput`, `setWorkingMessage`, `setWorkingVisible`,
`setWorkingIndicator` and `setHiddenThinkingLabel` are TUI-only and no-op in RPC
mode, so nothing reaches the wire for them and Dray never has to care.

Three things follow that are easy to get wrong:

- **`notify` and `setStatus` are fire-and-forget.** pi mints an id for them and
  registers no waiter, so a response is dropped — but treating them as blocking
  requests to be refused files two ordinary UI messages as coverage gaps, and
  loses a line the reader was meant to see. They are output, not questions.
- **The dialog carries its own deadline.** `opts.timeout` rides the request and
  pi resolves the promise to the default above when it fires, so a card left up
  past it is answering a question pi has already closed — the same shape as
  Claude Code's `control_cancel_request`, arriving as a field rather than a
  line.
- **`opts.signal` aborts the same way**, which is how a cancelled tool call
  takes its dialog back.

**So there is one channel, and every extension shares it.** That is the whole of
what "support what people add to their pi" needs: a card that can draw a
`select`, a `confirm` and an `input` and answer it works for
`@gotgenes/pi-permission-system`, for `@hank-warren/pi-auto-permissions`, and
for extensions nobody has written yet — with no Dray change per extension. It is
the same bargain Claude Code's `permission_suggestions` already make here: the
options are the CLI's, and Dray draws what it is given.

**Which makes Dray's own gate extension worth deleting rather than building.**
It duplicates packages that already exist, it competes with whatever the reader
installed, and it earns nothing the generic card does not. The honest default is
pi's own: no permission extension means no gate, and Dray says so instead of
implying one. Not yet done — §6 above still describes the embedded extension,
and this paragraph is the argument for cutting it.

**Still unverified:** whether a tool an extension registers reaches the wire as
an ordinary `tool_execution_start` under its registered name. If it does, Dray
already draws it (as `ToolType::Other`) and the only gap is a `TOOL_VERBS`
entry. Settled by installing `pi-web-access`, running one turn, and reading the
capture.

### Not every request is Dray's

`extension_ui_request` carries no extension identity — an `id`, a `method` and
the dialog's own fields, and nothing saying who asked. The user's own
extensions can call `ctx.ui.confirm` too; pi's docs use "Trust project?" as
their worked example. Drawn through Dray's card that arrives as a consent
prompt offering "Always allow \<tool\>" for a question that is not about a tool.

Two decisions follow, and the first is a real trade:

- **User extensions load.** `--no-extensions` would settle the identity problem
  by leaving Dray's the only one — and it would also silently disable whatever
  the reader has installed, which is their configuration, not ours. It would
  also make `Auto`'s allowlist argument moot by removing the tools it exists to
  catch. So they load, and the ambiguity is handled rather than avoided.
- **Dray's own requests are recognised by their option strings**, which the
  three values above already make unique. A `select` carrying them is a consent
  card; anything else — a foreign `confirm`, a foreign `select` — draws a
  generic question card with that extension's own title and options, and no
  "always allow". Recognition by shape, since shape is the only thing on the
  wire.

**And a later extension can rewrite what the card approved.** `event.input` is
mutable, handlers run in extension load order, and later handlers see earlier
mutations — so an extension loaded after Dray's can change the command between
the approval and the run. Dray's should load first, which `-e` ordering ought to
control and which wants a capture before slice 2 rather than an assumption.

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

pi's `extension_ui_request` also carries `confirm`, `input` and `editor`
alongside the `select` Dray's own gate uses, each blocking for a value. A
foreign `select` or `confirm` is a natural home for `QuestionsAsked` — a
`select` with `options` is Dray's `Question` almost field for field — and it
arrives only when an extension the reader installed asks something.

For the first three slices those draw a generic question card (above) rather
than being refused, because refusing them blocks an extension the reader chose
to run. `input` and `editor` have no card yet and are answered from the reader
task with `{cancelled: true}`, filed as `unsupported_request` — the same stage
and the same reasoning Claude's refusals use, because it is the only stage that
changes what the agent does.

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

### An older build erases pi's model ids, and nothing can stop it

§4 works through what happens when two Dray builds share `~/.dray`, and then
fails to apply its own conclusion one field over. `#[serde(flatten)] unknown`
preserves unknown **keys**. `model` is a known key, so what it protects is
nothing here.

Every shipped build carries `#[serde(other)] Unknown` on `ModelId`, and that
variant serializes as `"unknown"`. So a released 0.9.x opened beside a pi build
reads `"xai/grok-4.6"` as `Unknown` and writes `"unknown"` back on the next
whole-index rewrite. The pi build then reads `"unknown"` as an id naming no
model, `find_model` rejects it, and `send_msg` bails before the spawn — for
every pi session at once.

This is the `thread_id` erasure of 0.8.2 exactly, one field over, and it cannot
be fixed from this side: the destroying build already shipped.

What can be done is degrade honestly. `"unknown"` and `""` read as the same
sentinel — *this build cannot name the model* — and a pi session holding one
resumes with no `--model` at all, taking pi's own default rather than refusing
to start. The reader loses their model pick and keeps their session, which is
the right way round.

Written down here rather than only in code, because the cure for the reader is
"don't run an old Dray beside this one", and nothing in either build can say so
at the moment it matters.

### `models.rs` cannot hold this, and the reason is one line

`ModelId` is a **closed enum, and it is persisted** — on the index entry, and
on `dray new --model`. There is no set of variants that covers hundreds of
models across fifteen providers, and even if there were, the right set differs
per machine.

### Proposal: open the id, discover the list, and let pi pick the default

**One.** `ModelId` becomes a newtype over the string it already is on disk:

```rust
/// What `--model` receives, and what an index entry records. Every value the
/// index has ever held is a bare string, so this is the shape it was always
/// serializing as — the enum was a validation layer wearing a type's clothes.
///
/// Validity is `find_model`'s question, not this type's: an id names a model
/// this build can run, or it does not, and only the model table knows which.
#[derive(Clone, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
pub struct ModelId(pub String);
```

The alias table moves onto `Model` as an `arg` field — which it half is
already, since `as_arg` exists precisely because the persisted spelling and the
wire spelling differ (`gpt56_sol` on disk, `gpt-5.6-sol` on the command line).
`find_model` and `runs_on` stay exactly the gate they are.

**An untagged enum was the first proposal and it has a bug in it.** The shape
was `Known(KnownModel) | Named(String)`, keeping the closed half for the
single-vendor harnesses. Two spellings of one value then exist —
`Known(Opus)` and `Named("opus")` are identical on the wire and *unequal* under
the derived `PartialEq` — and that equality is not decorative:

```rust
// session.rs:655 — decides whether to replace the child
&& (s.model != model || s.permission_mode != permission_mode))
// session.rs:748 — decides whether to send set_model
if s.model != model {
```

So a model that reached one side through the index and the other through the
composer would compare unequal and respawn a live session, or fire a `set_model`
for a model already running. Silent, intermittent, and impossible to reproduce
from the wire, where the two are the same eight bytes.

A `ModelRef { harness, provider, id }` struct was the other candidate and is
worse: it rewrites what all 240 existing entries carry, to add a field that is
`None` for every one of them.

`ModelId` stops being `Copy` under any of these. It is ~12 sites
(`store.rs`, `session.rs`, `orchestration.rs`, `lib.rs`, `codex.rs`), the
compiler names every one, and ts-rs emits `string` either way.

**Two things come off `Model` that the first draft added.** `provider`
duplicates the id — pi's `set_model` takes the halves separately, so the split
belongs at the call site, on the **first** `/` (OpenRouter ids carry more than
one). `context_window` has no reader: the ring takes occupancy from
`get_session_stats`, not from the model table.

**Two.** `Model` grows what a discovered entry knows and a static one can leave
empty:

```rust
pub struct Model {
    pub id: ModelId,
    pub label: String,
    pub efforts: Vec<Effort>,
    pub default_effort: Option<Effort>,
    /// What `--model` receives, where that differs from the persisted id.
    /// `as_arg`'s table, moved onto the row it describes.
    pub arg: String,
    /// Whether the composer's image tray can send to this model at all.
    pub accepts_images: bool,
}
```

`accepts_images` is real and is the one field pi genuinely adds: a picked model
may not take images, and one on the probe box (`gpt-5.3-codex-spark`) says so
with `input: ["text"]`. It lands with the tray gate in slice 4, not in slice 0 —
nothing reads it before then, and a field with no reader is a field with no test.

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

pi's probe is cheaper than that one. `pi --mode rpc --no-session`,
`get_available_models`, then `set_model` + `get_available_thinking_levels` per
model, kill. No handshake to wait through, no model call, and the answers are
the whole picker.

Four conditions on it, each of which is a bug if left implicit:

- **`--no-session` is mandatory**, or every probe writes a session file into the
  reader's `~/.pi/agent/sessions/` and their session list fills with empty runs
  Dray started. The capture scenarios pass it; an earlier draft of this section
  did not.
- **`set_model` on the probe must not reach `settings.json`.** §16 promises Dray
  writes nothing under `~/.pi/agent/`, and stepping a probe child through every
  model is exactly the call that would break it. Unverified — it is in the
  open-questions table, and if it does persist, the ladder comes from
  `reasoning` instead.
- **`get_state` needs a timeout**, for the reason Codex's `initialize` has one:
  a binary that answers nothing wedges the picker, and pi says nothing on spawn
  so silence is indistinguishable from a slow start.
- **The cache needs a way to expire.** Nothing invalidates it, so a provider
  logged into after Dray started is unpickable — while `runs_on` still accepts
  its ids from `dray new`, so the CLI can start a session on a model the picker
  will not show. A freshness window like `usePrMarks`', or a refresh on the
  picker opening, rather than the command cache's never.

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

So `ModelId::default()` becomes the empty string, reading as *this build cannot
name the model* — the same sentinel `"unknown"` maps to above, since both mean
the same thing and two spellings of one state is how they drift. `find_model`
rejects it and the spawn omits `--model`.

Making the field `Option<ModelId>` is the alternative and it is worse: it is a
persisted schema change on a field every session has, to express a state that
lasts a few hundred milliseconds.

**In practice that sentinel should be rare, because the composer already knows.**
`send_msg` calls `find_model` *before* the spawn and needs the effort ladder for
`resolve_effort`, so the probe has to have run by then anyway — which means
every composer path and every `dray new` can record a real model on the entry
from the start. The sentinel narrows to one case: the probe itself failed. Worth
stating because it changes what the frontend must handle — and the frontend must
never draw the empty string as a model name.

**Five.** `runs_on(id, Harness::Pi)` answers "not one of the other two
harnesses' aliases" — with the newtype, a lookup against the static tables
rather than a variant match.

It cannot do better without asking the machine, and it does not need to: the
real check is pi's own `Model not found: nope/nope`, a sentence naming exactly
what was wrong, arriving on a `set_model` response that Dray is already
awaiting. The function's job is only to stop a Claude alias reaching a pi spawn,
and it does that.

### The composer's list is the reader's shortlist, not pi's

A flat picker is right for four models and wrong for forty, and pi is the first
harness on the wrong side of that line. Claude Code offers four, Codex three —
small enough that the list *is* the menu. `live_models.jsonl` answered **11
across two providers** on an ordinary machine, and it grew by one the moment a
second provider was logged into. One OpenRouter key puts hundreds behind a
single provider name. At that size a menu stops being a picker and becomes a
list to be searched, which is not what a composer control is for.

So the composer's model list for pi is **what the reader has starred**, and
discovery moves to a dialog of its own.

- **The picker groups by provider**, since a bare model name is ambiguous
  across them and pi's own ids are `provider/model` already. The group header
  is the provider; the row is the model.
- **With nothing starred it offers one row — "Choose models…"** — which opens
  the dialog. An empty menu is a control that reads as broken; a row naming the
  cure is the same shape the missing-agent notice already uses.
- **The dialog is search plus a starred toggle**, over every model pi reported,
  grouped by provider. Discovery is its whole job, so it is the one surface
  here that may be long.

Three rules that are not obvious and each of which is a bug if left implicit:

- **A session's own model is drawn whether or not it is starred.** Stars are a
  menu preference; the model a session is *running* is a fact about that
  session. A resumed session whose model the reader never starred must still
  name it, or the composer shows one model while the child runs another. This
  is the one that would ship broken.
- **A star for a model pi no longer offers is kept, not dropped.** Logging out
  of a provider should not silently forget the shortlist — it is not a
  correction, and logging back in should restore it. It is filtered out of the
  composer's list (nothing can run it) and shown unavailable in the dialog,
  which is where the reason belongs.
- **Stars are the reader's, not the session's.** They live in local storage
  beside `ade.openWith` and `ade.diffStyle`, for those keys' reason: which
  models you use is a fact about you. Not on `SessionIndexItem`, which records
  what a session *ran*.

Claude and Codex keep their flat lists. The dialog is offered where the list is
long enough to need it, which today is pi alone — gating on harness rather than
on a count, because a count makes the control appear and disappear as providers
come and go.

### What this does not solve

Model *identity across machines*. A session created by `dray new --model
anthropic/claude-sonnet-4-5` on one machine and opened on another where that
provider has no key will fail at the spawn with a readable sentence and no
fallback. That is correct — silently running a different model is the thing
`from_arg`'s strictness exists to prevent — but it means a pi session's model
is meaningfully less portable than a Claude one's, and orchestration inherits
it. Worth a line in the `dray` skill.

## 8. The seam, and where a third harness actually lands

This document spent seven sections on the wire and none on the file that has to
carry it. `session.rs` branches on harness in **eight** places, and pi touches
every one:

| line | what branches |
|---|---|
| 1108 | `Transport`, whose `lines()` bails for anything not Claude |
| 1172 / 1187 | `Session::init`, one arm per harness |
| 1641 | `deliver_prompt` — the write itself, and the `harness` it stamps |
| 1345 | `interrupt` |
| 1321 | `set_model`, Claude-only |
| 654 | the respawn rule, spelled `s.harness == Harness::Codex` |
| 874 | the fork guard |
| 439 | the worktree route, spelled `(Harness::Codex, true, None)` |

Two of those are match arms that a third variant makes the compiler check. The
other six are equality tests against a named harness, and a third one slips past
every one of them **silently, in the wrong direction**: line 439 keeps treating
"make the tree myself" as Codex's alone, so a pi worktree session bails inside
`init` with its index row already written — the empty-row failure §10's
missing-agent notice exists to prevent, reached by a different road.

**So the third harness is the second user, and the thing to lift is a driver.**
CLAUDE.md's rule is create the shared thing when the second user exists; three
arms scattered across eight `if`s is past that. One trait per harness answering:
spawn, deliver a prompt, steer, interrupt, apply settings, fork policy, worktree
route, resume handle. Each of those is a question `session.rs` already asks in
prose, and the compiler cannot check prose.

This is slice-0 work and it is pinned by tests that already exist — Claude's and
Codex's behaviour through the same seam is what proves the lift did not change
either.

**And `harness/pi/rpc.rs` is not "nothing shared with Codex".** An earlier draft
claimed pi's framing is a line reader and a response map and shares nothing.
Half true: the framing differs, the *correlation* does not. Both have outbound
requests carrying an id and a response arriving later on the same pipe, which is
the pending-map CODEX-PLAN.md §4 said would lift "when a second JSON-RPC harness
exists". pi is not JSON-RPC, but it is the second correlated harness, and the
id counter plus pending map plus demux is the part worth sharing. The typing
stays per harness.

That matters immediately for one thing: §9's "`get_session_stats` folded into
`TurnCompleted` before it is emitted" **cannot be an `await` inside the reader
task**, because the reader is the only thing that will ever see the response
line. It deadlocks. The turn has to settle into a pending state, and close when
the stats response arrives — which is exactly what a pending map is for.

## 9. Event mapping

`turn_id` stays `None` — pi has no turn identifier on the wire and Dray's
transcript groups by user message anyway, which is the reasoning Claude Code
already documents. `subagent` is always `None` (§10). `harness: Pi`.

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
| `tool_execution_start` | `ToolCallStarted{call_id: toolCallId, name: toolName, tool_type, input: args}` | `tool_type` from the name: `read`/`ls` → `FileRead`, `bash` → `Shell`, `write`/`edit` → `FileEdit`, `grep`/`find` → `Search`, else `Other`. **Every one of those names also needs a `TOOL_VERBS` row in the same change** — `toolLabel` returns the raw name on a miss, which is how Codex's `shell` and `apply_patch` shipped as lowercase wire tokens beside Claude's "Bash" and "Edited" |
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
  output of a running command, and Codex leaves the same gap with `outputDelta`.
  An earlier draft read that as CLAUDE.md's "second user earns the shared thing"
  and concluded the variant should land now. That is the rule inverted: there
  are two *producers* and still **zero consumers** — no row draws live output
  for any harness. The second user of a variant is the second thing that reads
  it. So slice 4, when a row exists, and then in pi's accumulated shape rather
  than Codex's delta: replace-on-update is idempotent, so a dropped or
  reordered frame costs a stale frame instead of a corrupted buffer.
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

## 10. What the composer has to change

| control | pi |
|---|---|
| harness picker | one more entry, one more mark (below), and one more agent for `agent_availability` to report on |
| model picker | **discovered, not constant** (§7). Async for the first time, and seeded from what pi reports rather than from a Dray default |
| effort picker | driven by the picked model's `get_available_thinking_levels`. A model with `["off"]` shows none, which is the existing empty-`efforts` path |
| permission mode | **Plan is shown** (§6) — unlike Codex. `acceptEdits` stays gone, as everywhere. `Auto` means something weaker than it does elsewhere and its copy should say so |
| project / branch pickers | unchanged |
| worktree toggle | unchanged (§11) |
| image tray | images work — `prompt.images` takes base64 with a mime type, the same shape Claude takes. New: gate on the picked model's `input` including `image`. **Non-image attachments have no route**: Claude's `@/abs/path` convention is Claude's own parser, and pi expands no mentions inside an RPC prompt (below), so a dropped CSV would silently attach nothing. Codex answered this by appending a plain line naming the file, and pi should do the same |
| `/` picker | **better than Claude's.** `get_commands` answers on the live connection, so no throwaway child. Sources are `extension`, `prompt` and `skill` — and pi reads `~/.agents/skills`, which is the same directory Claude reads, so a reader's skills are already there |
| `@` picker | dark (§9) |

### The mark

`AgentIcon` draws one mark per harness and branches on two, so a third harness
needs a third — and the picker is where it is the subject rather than a bullet,
so it is the one surface that would show a gap.

pi's press kit (<https://pi.dev/press-kit>) offers two: a **primary logo** for
editorial use and a **badge** for favicons. The badge is the wrong one — it
carries its own `#09090b` rounded plate, which is a second surface inside a row
of chrome that already has one, and it is exactly what `LinearIcon`'s
`currentColor` rule exists to refuse. The primary logo is two paths of flat
geometry with no fill of its own, which is what that rule wants.

Native viewBox is `0 0 800 800` and it should stay that way — the coordinates
are exact multiples of the grid the mark is drawn on, and rescaling to 24 to
match the other two buys nothing but rounding. `className` sizes it either way.

```
<svg viewBox="0 0 800 800" fill="currentColor" role="img" aria-label="pi">
  <path fill-rule="evenodd" d="M165.29 165.29H517.36V400H400V517.36H282.65V634.72H165.29ZM282.65 282.65V400H400V282.65Z" />
  <path d="M517.36 400H634.72V634.72H517.36Z" />
</svg>
```

`fill-rule="evenodd"` on the first path is load-bearing: the P's counter is a
hole cut by a second contour in the same path, and the default `nonzero` fills
it in — which reads as a slightly wrong solid blob rather than as a bug, so it
would ship.

**No brand colour.** Claude's mark gets `CLAUDE_RUST` because Anthropic's is a
coloured mark; pi's is monochrome by design, the way OpenAI's is, so `brand`
leaves it on `currentColor` and the row still reads as one set.

Licensed **MIT**, credited to *Earendil Inc. & Contributors* — so it goes in the
root README beside the ported themes, whose credit rule already covers exactly
this and already has a test failing without one.

### Subagents

pi has none. `docs/extensions.md` describes sub-agents as something an
extension provides, and no built-in tool spawns one. So:

- `AgentEvent.subagent` is always `None` for pi.
- The Subagents panel's tab hides, the same way the PR tab hides with no PR.
- If a reader installs an extension that provides subagents, its work arrives
  as ordinary tool calls with no envelope and no id to join on — pi's wire
  carries nothing to correlate them by. Drawn inline as tool calls, which is
  honest, and better than a panel that shows a run nothing can close.

`ToolType::SubagentSpawn` is therefore unreachable for pi. Dray's own
orchestration is a separate question and the next section is why it is not
unaffected.

### Dray's own rules have to reach the agent, and nothing here sent them

Both existing harnesses inject Dray's instructions at spawn — Claude through
`--append-system-prompt` (`claude_code.rs:86`), Codex through
`developerInstructions` on `thread/start` (`codex.rs:304`). That text is what
tells an agent the `dray` CLI exists, how to link an issue, and what to do
instead of asking a question the harness cannot ask. Six sections of this
document described pi's wire and none of them sent it.

Left as written, a pi session would run and would not be part of the product:
`dray new` and `dray send` unknown to it, so it can neither fan work out nor
report back; issue linking never happening, so the Issue tab never appears; and
no instruction to answer in the reply when it wants to ask something.

pi takes `--append-system-prompt`, and it takes it as text or a file path. So
this is one flag and one file — `harness/pi/system_prompt.md`, pi's own, not
Claude's shared: Claude's names `AskUserQuestion` and the Agent tool, and Codex
needed its own for exactly that reason. Pinned by the same tests that pin
Codex's.

**And `dray skill install` writes to two directories, neither of which is
pi's.** It writes `~/.claude/skills/dray/` and `~/.codex/skills/dray/`
(`cli/src/main.rs:161`), because the CLI cannot know which agent the reader
runs and writes both. pi reads skills from `~/.agents/skills` — observed in a
capture, where `get_commands` listed a skill from there — so a third directory
is needed, and the CLI's "write them all" rule already says which.

Both belong in slice 1. A session that runs but cannot be orchestrated is not a
harness Dray supports; it is a demo.

### The missing-CLI notice

`Harness::Pi` needs `label()`, `install_command()` and `docs_url()`, and
`every_agent_names_its_own_cure` will fail until it has all three — which is
what that test is for. The install command is pi's own installer, not an npm
line, for `harness.rs`'s stated reason.

**And the version gate needs a second sentence.** `agent_availability` today
answers "can this run here". For pi there is a third state: installed, runnable,
and too old (§3). The notice has to say *upgrade*, not *install*, or the reader
runs an install command for something they already have.

## 11. Worktrees

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

## 12. Sending, steering, stopping

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

**Measured end to end, against a real model**, because the paragraph above was
a quote from pi's own doc comment and `abort_and_queue.jsonl` never settles it
— that capture clears the queue before the turn can deliver anything.

Prompt: run `sleep 25 && echo done`, then say DONE. Steered 2s into the tool
call with "ignore the command and reply with exactly BANANA".

```
 3.80s  queue_update  steering: ["…BANANA"]      ← queued, tool still running
26.81s  tool_execution_end
26.82s  turn_end / turn_start                    ← same run, next model call
26.82s  queue_update  steering: []               ← dequeued here
26.82s  message_end   role=user                  ← delivered as a user message
28.53s  agent_settled
```

The answer was `BANANA`, and the original instruction was dropped — so it is
*delivered and acted on*, not merely dequeued. Three things that follow, each
of which someone will otherwise assume the other way round:

- The boundary is **inside the run**, between two `turn_start`/`turn_end`
  pairs. It is not "the queue flushes when the turn ends" — by Dray's
  vocabulary the turn had not ended, and `agent_settled` was still 2s away.
- **`steer` and `follow_up` are two queues, not one.** `follow_up` is the one
  that waits for the whole run ("delivered only when the agent has no more tool
  calls or steering messages"). Reaching for it where `steer` was wanted costs
  a whole run of latency.
- **No extension is involved.** The only extension rule here is that a
  `/`-prefixed *extension command* cannot be queued, which errors rather than
  waiting.

`{"type":"steer","message":"…"}` is a top-level command in its own right, as
well as `prompt` carrying `streamingBehavior`. Either works; the standalone one
is what the capture above used.

### Stop is three commands, and two of them are not optional

`abort` takes no arguments — simpler than Codex, which refuses `turn/interrupt`
without a `turnId`. But `abort` alone does not stop a session that has anything
queued: pi's own docs say "abort continues queued messages when they remain in
the session", and `models_and_steering.jsonl` shows it — an abort, then a
`turn_start` for the steer that was waiting.

**And it says nothing about a `tool_call` hook that is currently awaiting an
answer.** That hook is an `await` inside pi, blocking the turn on a reply only
Dray can send, and nothing in the docs or the captures says `abort` unblocks it.
The likely shape is the worst one: Stop acknowledges, the turn stays parked on
the question, and the card is still on screen — so pressing Allow runs the tool
*after* Stop, which is the one thing Stop exists to prevent.

So Stop **answers every outstanding request first**, each with
`{cancelled: true}` — already the fail-closed reading — then `clear_queue`,
then `abort`. Each answered request retires its card with
`PermissionDecided{automatic: true}`, the path `control_cancel_request` already
built for Claude and `serverRequest/resolved` for Codex.

Ordering is load-bearing and it is the same reasoning both times: release what
the child is blocked on before telling it to stop, or the stop lands on a
process that cannot act on it.

`clear_queue` returns the text it dropped, which Dray should put back in the
composer draft rather than discard — `useDraft` already keys by session and this
is the same restore the docs describe.

This is structurally the same conclusion Claude's Stop reached: an interrupt
plus a fan-out, because the interrupt alone left the session held open by
something else. Different mechanism, same shape, and the same failure if it is
missed — a Stop that acknowledges and changes nothing.

### Compaction

`{"type": "compact"}`, and `/compact` typed in the composer is recognised in
`deliver_prompt` and becomes that command. Everything else beginning with `/`
is a real pi command, expanded by pi itself from `get_commands` — so unlike
Codex, `/` is not prose here.

## 13. Fixtures and testing

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

## 14. Staging

### Slice 0 — make room (no pi code)

- `ModelId` becomes a newtype (§7). `Copy` comes off; the compiler names the
  ~12 callers. `Unknown` goes; `""` and `"unknown"` both read as the sentinel.
- `Model` grows `arg`. **Not** `provider` or `context_window` — neither has a
  reader — and `accepts_images` waits for the tray gate in slice 4.
- `default_model_for` returns `Option<ModelId>`; `send_msg` omits `--model`
  on `None`.
- `list_models` takes a harness.
- `SessionIndexItem.pi_session_path`, `#[serde(default)]`. **Not** a rename of
  `thread_id` — see §4 for why that loses every Codex session's handle.
- **The per-harness driver (§8).** Eight scattered `harness ==` sites become one
  trait, so the compiler asks the third variant every question the second one
  was asked. This is the largest piece of slice 0 and the reason it is worth
  shipping alone.
- `Harness::Pi` with its label, install command and docs URL; `binpath` learns
  `pi` and its version floor.

**Slice 0 is not quite pi-free, and the two places it leaks need deciding
here.** `list_models` cannot probe without pi's parser, so it takes a harness
now and grows the pi arm in slice 1. And `Harness::Pi` exists while
`Session::init` still bails on it — which is the empty-indexed-row failure §10
exists to prevent, unless `agent_availability` reports pi unavailable until
slice 1 lands. It should, and that is one line rather than an open question.

Its own PR, and **three tests have to be written before it is shippable.** The
existing suite does not cover this slice, and an earlier draft claimed it did:

- **A whole-index round trip.** Every field of a real `SessionIndexItem` out and
  back with no loss, including `threadId` and the `unknown` map. This is the one
  that would have caught the rename (§4), and nothing like it exists — the
  `store.rs` tests build items and assert on behaviour, never on the bytes.
- **`ModelId` round-tripping every shipped alias**, byte-identical, over a real
  index rather than a constructed one. `model_ids_serialize_as_bare_aliases`
  covers the Claude half of the serialize direction only.
- **`every_agent_names_its_own_cure` over every variant.** It iterates a
  hardcoded `[ClaudeCode, Codex]`, so a third harness with no install command
  passes it. It should iterate the variants rather than a literal, which turns
  it into the test its doc comment already claims to be.

The rest of the slice — the `Copy` removal, `list_models` taking a harness — is
pinned by the compiler and by tests that do exist.

### Slice 1 — a pi session on screen

- `harness/pi/{pi.rs, parser.rs, mapper.rs}`, over the pending-map core lifted
  from Codex's client (§8). The framing differs; the correlation does not.
- Spawn, `get_state` handshake, `--session` path, the probe behind
  `list_models`.
- **Plan and Bypass only**, and the composer offers no other stance for pi.
  Plan is `--tools read,grep,find,ls` — a flag, no extension, genuinely
  read-only — so the slice ships with one honest gated stance instead of none.
- `harness/pi/system_prompt.md` through `--append-system-prompt`, and
  `~/.agents/skills/dray/` from `dray skill install` (§10). Without these a pi
  session cannot be orchestrated at all.
- Map: the three lifecycles, deltas, `tool_execution_*`, the two echoes
  dropped, failure from `stopReason`, `get_session_stats` on settle,
  `TOOL_VERBS` rows for pi's tool names.
- Resume by respawning on the same path. Stop as answer-pending +
  `clear_queue` + `abort`. Session file deleted with the session.
- Composer: harness picker with pi's mark and its README credit (§10),
  discovered model list, discovered effort levels.
- Fixtures: `no_approvals`, `abort_and_queue`, `resume`, `failed_turn_live`.

**Slice 1 must not ship with the stance picker unrestricted.** An earlier draft
had it spawn under `BypassPermissions` whatever the reader picked, which is what
Codex's slice 1 did — but Codex did it *inside* `workspace-write`, so the worst
case was an unasked command that still could not leave the workspace. pi has no
sandbox, so the same shortcut means a reader who picks "Ask every time" gets an
agent that asks nothing and can do anything. Restricting the picker costs one
stance for one slice.

Done when a pi session runs a multi-tool turn, the transcript draws it with a
streaming preview, the ring fills, Stop stops it, and reopening the app resumes
it.

### Slice 2 — approvals

- The embedded extension, content-hashed filename, loaded with `-e`, with the
  registration handshake that refuses to start a gated session without it.
- `PermissionRequested` from `confirm`, the three options, the per-session
  allow set, `{cancelled: true}` for the other dialog methods.
- The mode table: `--tools` for Plan, gate sets for the rest, no `-e` for
  Bypass. Mode change respawns. The full stance picker comes back here.
- Stop answers every outstanding request before `clear_queue` + `abort`.
- Foreign `extension_ui_request`s draw a generic question card.
- Fixtures: `extension_approvals`, plus the three §15 wants first — a custom
  tool from an extension, `-e` ordering, and a Stop with a request open.

### Slice 3 — worktrees, fork, orchestration

- `owned_worktree` for every pi worktree; base from `base_ref_tree`.
- Fork by copying the session file. Guard on `turn_in_flight`.
- `dray new --harness pi` end to end, including `--from`. An older app meeting
  `--harness pi` refuses readably and names `dray update` as the cure.
- Steering for queued prompts.

### Slice 4 — the rest

- `/` picker from `get_commands`. Compaction events. `auto_retry_*` into the
  retry indicator. `ToolCallProgress` for live tool output — when a row exists
  to read it, in pi's accumulated shape. `accepts_images` and the tray gate.
  Non-image attachments as a named line. Fork at a chosen message.

### Later, and not promised

Cost reporting. Reading `get_entries` for a fork-at-message picker. Anything to
do with running pi in a container, which is pi's own answer to the sandbox
question and currently outside what Dray says anything about.

## 15. Open questions, and what settles each

| question | settled by |
|---|---|
| Do other providers through pi fragment tool arguments, or report usage mid-stream? xAI does neither | one capture each against Anthropic and OpenAI. Neither changes a mapping — only how much the streaming preview buys |
| Does `fork {entryId}` hijack the running process the way `clone` does? | one capture; assumed yes, written against the pattern |
| Does a tool registered by an extension reach `tool_call` under its registered name? §6's `Auto` allowlist assumes so | a capture with an extension registering a mutating tool. Wanted before slice 2 |
| Can two `extension_ui_request`s ever be outstanding at once? The docs say preflight is sequential | a capture that leaves the first unanswered while a sibling call preflights |
| What does an unanswered `extension_ui_request` do to the turn — block forever, or is there a floor timeout? | a capture that answers nothing and waits |
| **Does `abort` release a `tool_call` hook that is awaiting an answer?** If not, Stop leaves a card whose Allow still runs the tool (§12) | a capture that sends `abort` with a request open, then answers it |
| Does `-e` load before the reader's own extensions? A later handler can rewrite `event.input` after the card approved it | a capture with two extensions, both logging their load order and mutating |
| Does `set_model` on a probe child write through to the reader's `settings.json`? §16 promises it does not | a probe run against a copied agent dir, diffed after |
| Does pi's `--append-system-prompt` accept a path as well as text, and does it survive a resume the way `developerInstructions` does not? | one capture with a codeword, resumed |
| Does `--tools read,grep,find,ls` really refuse a write, or does the model get a tool that errors? | a capture under Plan mode asking for a write |
| Is `~/.dray/pi-sessions/<id>.jsonl` safe as a session path when `--session-dir` is not passed, or does pi expect its own layout? | it worked in every capture here; confirm against a resumed session with compaction history |
| How long does the model probe take on a machine with several providers configured? | timing on a real multi-provider install; if it is slow, the picker needs the command cache's freshness window rather than a plain `OnceLock` |
| Does pi's own `settings.json` default model change under the reader while Dray holds a cached list? | the same restart bargain the command cache makes; confirm it reads acceptably |

## 16. What this deliberately does not do

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
