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

**Slice 1 — done.** Spawn, handshake, `--session`, the discovered model list and per-model effort ladders, the three lifecycles,
deltas, tool calls, failure from `stopReason`, resume, Stop, the system prompt,
`~/.agents/skills/dray/`, and `dray new --harness pi` end to end.

The gap it shipped with — the stance picker hidden, every pi session
ungated — is closed on the half that could be closed. See slice 2.

**Slice 2 — the part that matters is done, and it is not what §14 planned.**
No gate ships, deliberately: pi is extensible, permission extensions already
exist, and Dray renders *the channel* every extension asks over rather than
competing with them. So `select`, `confirm`, `input` and `editor` each draw the
questionnaire card Dray already had, answered in the shape their own method
reads, and an extension-registered tool needs no code at all — it arrives as an
ordinary tool call. §6 is rewritten around this; the embedded gate extension it
used to describe is cut. A Stop answers every card still up before it aborts, because `abort` ends the
agent and does not resolve a promise an extension is awaiting inside its
`tool_call` hook — so a Stop pressed with a card on screen used to leave the
extension waiting and the card offering buttons nothing would answer for. Not
built there: `opts.timeout`, so a card can still outlive the dialog it draws;
and the five fire-and-forget methods, which are dropped rather than shown.

Follows from that: **`Plan` is the only stance pi can honour, and it now
does.** `--tools read,grep,find,ls` at spawn, which pi's own help gives as its
worked example and which applies to extension and custom tools as well as
built-in ones. Verified live: a pi asked to write a file under it answers that
it has no tool that can, and writes nothing.

So the picker is back, offering the two stances that mean something — `plan`,
enforced by the flag, and `bypassPermissions`, which is what pi does with no
permission extension loaded. `manual` and `auto` are not offered, and a session
arriving on one (a spawned session takes its parent's) is recorded as bypass,
because the index has to say what actually happened.

**Slice 3 — fork is done; two things left.** Worktrees and orchestration work,
and pi is forkable — by copy, which is the cheapest of the three routes and is
verified live: a pi spawned on a copied session file reports the new path,
counts the parent's messages and quotes its first prompt back. `fork_needs_cli`
on the capability table is what tells the two mechanisms apart, and it is what
stopped `SessionIndexItem::fork` writing pi an instruction nothing would carry
out.

One bug fell out of that and was worth the trip: **a fork into a new worktree
was keyed on `fork_from`**, so a fork with no instruction to leave — pi's, on
the first shape of this — was spawned straight into a directory nobody had
made. Settled by having *every* fork record its parent and filtering the
instruction on `fork_needs_cli` at the spawn, so the field's second fact ("this
fork has not spawned yet") is available to both harnesses. Probing the
directory instead was tried and is the wrong fix as a *gate*: a tree deleted by
hand reads the same way, and remaking it runs `worktree add -B`, which resets
the branch and takes its commits with it.

The same probe is right one step in, though, and it closed a second hole. The
tree is made before the child spawns and `fork_from` is only cleared after it,
so a spawn that fails leaves the instruction standing and the next send arrives
at the same branch — where `worktree add` on a path that exists refuses
outright, and a fork that failed to start once could never start at all. So the
creation is skipped when the directory is already there. Adopting it costs
nothing: it belongs to this fork, whose first send is what this is, so there is
no work in it to be surprised by.

**A pi fork requires its parent's transcript, and says so.** The copy used to
answer "nothing to do" for a missing source, which is the ordinary state for
every other harness and a broken fork for pi: the copied Dray log puts the whole
parent conversation on screen while pi opens on an empty context. It is asked
for by harness now rather than by probing the path, so a missing file is an
error exactly where it means one.

**Steering is wired, and it removed code rather than adding it.** A prompt
typed into a running pi turn goes straight out with
`streamingBehavior: "steer"`, so pi holds it and drains it at the next
tool-call boundary inside the run — before the model call after it, verified
live. Dray's own queue exists because Claude Code offers neither the boundary
nor the hold, and pi needs neither half of it. The trade is
`queue_and_flush`'s: no window to cancel in, in exchange for a boundary pi
guarantees rather than one this side races for.

**`--from` reduces to the path an ordinary pi worktree session already takes**,
and there is nothing pi-specific left in it. pi creates no tree of its own, so
*every* pi worktree session resolves a base ref and has Dray build the tree —
`--from` only changes which ref that is. The routing is pinned by
`only_claude_code_makes_its_own_worktree`, the tree-at-an-arbitrary-ref by
`create_worktree`'s own tests, and the spawn goes in with `worktree_name: None`
either way.

Checked live to close the last of it: a linked worktree created at an arbitrary
commit runs pi, which spawned, opened a run and settled inside it. The turn
itself errored, on a shared `openai-codex` refresh token being used by another
process — not a path this touches, and the failure surfaced exactly as the
harness's own sentence, which `a_failed_turn_carries_its_own_sentence` already
pins.

**Slice 4 — retries, compaction and the rest of pi's vocabulary.** `auto_retry_start`
drives the retry indicator and `compaction_start`/`compaction_end` drive the
compacting one, both of which already existed for Claude Code. Field names came
off pi's own `agent-session.d.ts`, not from a capture, and two would have failed
*silently*: pi sends `maxAttempts` where Claude Code sends `maxRetries`, and a
compaction's trigger rides the event as `reason` rather than sitting in
`result`. `#[serde(default)]` turns either mistake into an absent field, so the
indicator draws "attempt 1 of 1" forever and every compaction reads as
untriggered — both pinned by test now.

Six more event types were read out of the same file and modelled: `entry_appended`,
`bash_execution_update`, `session_info_changed`, `user_bash` and the three
`summarization_retry_*`. All drawn as nothing, all high-volume or meaningless
here, and all modelled for `tool_progress`'s reason — the parse-failure file is
only useful while everything in it is a real gap. `extension_error` is the one
of the group that draws a row: nothing else on screen would say a permission
extension had stopped gating, which looks exactly like it working.

**An attached image now reaches the model, and before this it did not.** The
prompt carried the text alone, so the transcript drew the screenshot the reader
attached and pi was never given it — silent at both ends, because `prompt`'s
`images` is optional. It is sent ungated on `accepts_images`: pi resolves the
model itself where Dray names none, so the app's copy of that answer can be
absent or wrong, and a provider refusing an image is a sentence the reader can
act on where dropping one is not.

**The `/` picker reads `get_commands`, and building it turned up a bug older
than pi.** Every picker was filled from Claude Code's `initialize` whatever the
session ran on — so a pi session offered `/compact`, `/dataviz` and 145 others
pi has never heard of, and typing one sent it as a prompt, because pi expands no
command it does not know. Codex had the same picker and answers none of them
either. `list_slash_commands` takes a harness now, and the hook keys its cache on
one. Verified live: pi answered in **0.25s** with 10 commands, all of them from
the reader's own extensions and skills.

**A non-image attachment is named in prose now, not as an `@path`.** Claude
Code's own parser expands one into the file's contents before the model turn,
with no tool call on the wire — which is what makes a 40MB CSV cost a path
rather than a context window. Neither other harness has that parser, so the same
string reached the model as punctuation it had to guess the meaning of.
`expands_at_mentions` on the capability table decides, so Codex was fixed by the
same line.

**The tray says when a model takes no images, and says rather than stops.** Some
pi models report `input: ["text"]` and mean it. The image is still sent, because
the harness's own refusal names what was wrong where a guess made here could
not — and Dray's copy of what a model accepts can be stale, or absent where pi
picked the model itself. Absence reads as capable, so a warning is never drawn
on a guess.

**A pi dialog is answered off its own desk, never through the session map**, and
that came out of an adversarial review. pi answers a `prompt` only after
`_tryExecuteExtensionCommand`, `emitInput` and `emitBeforeAgentStart` have run,
and each of those can call `ctx.ui.confirm`. On a *new* session that is before
the first `send_msg` returns, which is the only thing that puts it in the map;
on a live one it is under the map's own lock, so the answer that would release pi
waited on the lock the send held while it waited on the answer — and that is one
lock for the whole app, so every other session's controls waited with it. Both
drew a card whose buttons did nothing until the prompt timed out thirty seconds
later. `harness/pi/desk.rs` registers the four handles an answer needs — pending
map, client, id, sequence — the moment the reader starts, and `answer_questions`
looks there first.

Project trust looked like a third route and is not, which is worth recording
because the source reads that way until the last step. `resolveProjectTrusted`
does call `ctx.ui.select`, but only past `if (!hasUI) return false`, and
`main.js` sets `hasUI` to `isInitialRuntime && trustPromptMode ===
"interactive"` where `trustPromptMode` is the app mode. Under `--mode rpc` it is
`"rpc"`, so pi never asks — it answers *untrusted*, and a project holding `.pi`
resources with no stored decision silently does not load them. Worth knowing as
pi behaviour; not a Dray defect, and nothing here can change it.

**A desk is ended by its own reader, and only ever its own.** The reader ending
is the one signal covering every way a child can go — asked to, killed, crashed,
or never past the handshake — so retirement and closure happen there and nowhere
else. `Session::kill` used to close ahead of `shutdown`, which meant every
explicit kill reached the reader with nothing left to retire and left its cards
up for good.

Ending is keyed on a **token**, not on the session id. `shutdown` waits for the
child but nobody joins the stdout task, so a respawn opens the next desk under
the same id while the previous reader is still on its way out — and keyed on the
id alone that teardown retired the *new* pi's dialog and unregistered its desk,
leaving the new pi waiting on an answer nothing could send.

The click race is closed by a flag set **inside** the pending lock, immediately
before the drain, and read inside the lock the answer takes its entry from. That
is what makes the two total rather than merely narrow: whichever critical section
runs first decides, so either the click took its entry while the child was alive,
or teardown had begun and the click is refused. Flagged outside the lock they are
separate steps, and a click reading the flag a moment before it was set still
claims a delivery into a writer that is already breaking. `Session`'s own pi arm
is gone rather than left as a fallback that would recreate exactly that false
answer through a dead client.

**Stop's refusal window closes on the outgoing prompt, not on the inbound
`agent_start`.** Keyed on the inbound line it was open across exactly the
preflight above, so the next run's own legitimate question was auto-cancelled —
the bug it exists to prevent, pointed the other way. And the check that reads it
sits *under* the pending lock with the registration: `begin_stop` stores the flag
before Stop takes that lock to drain, so either the insert lands first and is
drained, or the flag is visible and the insert is refused. Checked before taking
the lock they are two steps on two threads, and a dialog landing between them
outlives a Stop that has already reported itself done — pinned by a threaded test
that fails within a dozen rounds on the old ordering.

**A worktree name is refused where its branch exists**, which is a hazard older
than pi. `create_worktree` runs `worktree add -B`, which *resets* an existing
branch, and the name resolver checked only the directory — so a tree removed by
hand, leaving `worktree-<name>` with commits and no session row naming it, could
have that name handed out again and the first send would move the branch off its
own commits. `-B` stays, because it is what stops a leftover branch making a name
fail forever; the resolver simply never hands out a name that would meet one.

**A dialog's title reaches the reader.** The card draws no `header` — that slot
is a chip-sized label `AskUserQuestion`'s model writes — so a `confirm`'s title
put there was a title nobody saw: `confirm("Overwrite?", "file exists")` drew
"file exists" over Yes and No. Which field carries the substance is not knowable
from the wire, so both are shown, on two lines. The card also takes focus into
its free-text box where it has no choices, which pi's `input` and `editor` never
do — without it focus stayed in the composer, and typing edited a prompt while
the agent sat blocked behind the card.

Still not started there: fork at a chosen message.

**A new session gets a row before the backend answers for it**, and that is what
finally draws the card. Holding the event was not enough, and the reason is worth
stating because it looked like a fix: the merge that would have shown it runs on
the very reply that is doing the waiting. `send_msg` does not resolve until pi
accepts the prompt, and pi does not accept it until its `input` and
`before_agent_start` handlers have run — either of which can raise the blocking
question. So the shell is written before the call, beside the optimistic status
and working writes already there, out of the values that call is already being
passed. The three the backend alone resolves — worktree name, truncated title,
recorded branch — arrive with the snapshot and replace them, and the whole row
goes again if the send fails.

`upsertSession` therefore **merges by event id** rather than replacing. A
snapshot's events come from the log, and the log carries no permission request,
so replacing a row that had been taking live events dropped exactly the card the
reader was being asked to answer.

**An event that arrives before its session does is held, not dropped.**
`useSessions`' listener wrote into sessions it already had, and a new one reaches
that array only when its first `send_msg` resolves — by which time its child has
been streaming for a while. For most events that cost nothing, since the snapshot
carries the log; for a blocking question it cost everything, because a permission
request is never *written* to the log, so the one event that could draw the card
was the one event the snapshot could not replace. Held in a capped module-level
map now and merged **by event id**, which is exact: a persisted event carries the
same id in the snapshot as it did on the wire, so the buffer can hold everything
and still duplicate nothing. Deciding by payload type instead would have been a
second copy of which events the log carries, free to disagree with the one in
Rust.

Held **in a map keyed by event id**, not a list, and that is not tidiness. The
hold happens inside a `setSessions` updater, which is the only place with a true
reading of which sessions are here — and StrictMode invokes every updater twice
in development, so a list took each event twice and drew two cards under one
React key. Both dimensions are capped: per session against a burst, and across
sessions because a failed send leaves an entry under an id nothing will ever
claim and every retry mints a fresh one.

**`PiClient::close` is synchronous now, and it had to be.** It only *enqueued* a
`Close`, so a line sent after it landed behind that marker, answered `Ok`, and
was dropped when the writer broke — an answered dialog took that `Ok` as
delivery and retired its card claiming a reply had reached a pi that never saw
it. A flag set before the marker is queued, and read by `send`, is what makes the
refusal true rather than merely likely.

One gap left in the dialog channel: `opts.timeout` rides `select`, `confirm` and
`input`, and Dray ignores it — so a card can outlive the dialog it draws and
answer into a promise pi has already resolved to its default.

Both smaller things are done: a deleted session takes pi's own transcript with
it, and the root README credits pi's mark, which its icon's doc comment had
been promising it did.

**Both rules that were only remembered now have something behind them.** Never
kill a pi is read off the source: a test counts `child.kill()` in `pi.rs` and
fails on a second one, so a fourth teardown path regresses loudly instead of
leaking the auth lock onto the next spawn (see *A pi must be asked to leave* in
§3).

The other is bounded rather than fixed, and the difference is worth stating. An
unmodelled inbound request still hangs the session — `#[serde(other)]` needs a
unit variant, so `PiEvent::Unknown` cannot carry the id an answer would have to
name. What changed is that it no longer hangs *silently*: `describe_line` files
the type by name and says outright that the turn may be blocked when the line
carries an `id`. Answering it automatically was considered and refused — the
reply shape would be a guess, and a wrongly shaped one is dropped in silence,
which is the same hang with a wrong fix in front of it.

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

**Captured now, not assumed, and it is worse for Dray than the two reasons
below.** Driving `fork {entryId}` against a real four-turn session:

- It **rebinds the running process** (`rebindSession()` on the RPC side), which
  is the hijack this section assumed and had not seen.
- It **writes a new file pi names itself**, in the process's cwd, as
  `<timestamp>_<uuid>.jsonl`. The file `--session` named is left **byte for byte
  unchanged** — 11 records before and after — so nothing branches *within* a
  session file. A session file is a linear chain, not a tree to pick a leaf from.
- The new file carries **only what follows the fork point**. Resumed, it reports
  `messageCount: 2` and knows the word taught on the branch and nothing from its
  parent. So pi's fork does not mean "continue this conversation from an earlier
  message"; it means "start a session there and keep only what comes after".

That last one settles the design for a fork-at-a-chosen-message picker whenever
it is wanted: it is **Dray-side, and pi's `fork` is not part of it**. Copy the
session file and truncate after the chosen entry, which is the same move the
whole-session fork already makes with the truncation point at the end.

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

**Verified live, end to end at the file level.** A parent taught a codeword; a
copy of its session file, resumed, answered that codeword without being told — so
the conversation carries. The fork then learned a second word, and the parent,
reopened afterwards, still knew its own and answered *no* to the fork's. Two
independent continuations of one conversation, which is the whole of what fork
promises.

So **Dray forks by copying the session file**, which is what it already does
with its own log. Verified: pi spawned on a copy reports the new path as its
`sessionFile`, counts the parent's messages, and quotes the parent's first
prompt back. The copy keeps pi's own session id inside it, so two files name one
pi session — which collides with nothing, since that id is not an address
anything in Dray uses. `SessionManager::fork` copies `~/.dray/sessions/<parent>.jsonl`,
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

## 6. Permissions — and why Dray ships no gate

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

### The gate is an extension's job, and several already exist

An earlier draft of this section had Dray ship its own gate: an extension
embedded in the binary with `include_str!`, written under `~/.dray/pi/` on
spawn, passed as `-e <path>`, hooking `tool_call` and raising a consent card.
It was designed in full and **not built**, and the reason it was not is the
whole shape of this section.

pi is extensible on purpose, and permissions are one of the things people
extend it with. `@gotgenes/pi-permission-system` and
`@hank-warren/pi-auto-permissions` are both published; so are `pi-web-access`
and `pi-mcp-adapter`, which add capabilities rather than gate them. A gate
Dray shipped would compete with whichever of those the reader installed —
two hooks on one `tool_call`, two cards for one call, and load order deciding
which one's rewrite of `event.input` actually runs.

So Dray renders **the channel** instead. Every extension's UI goes through
`extension_ui_request`, and a card that draws one works for every package
anyone installs, including ones nobody has written yet, with no Dray change
per extension. It is the same bargain `permission_suggestions` already make
for Claude Code: the options are the harness's, and Dray draws what it is
given.

The honest default falls out of it. No permission extension means no gate,
and Dray says so rather than implying one — see *The modes cannot be honoured*
below.

### The whole extension UI surface, read out of the RPC bridge

Everything below is `createExtensionUIContext` in `dist/modes/rpc/rpc-mode.js`,
so it is what pi *does* rather than what its docs say. Nine methods reach the
wire, all as `extension_ui_request`, and they split in a way Dray has to respect
because five of them must not be answered:

| method | fields | answered with | on cancel/timeout |
|---|---|---|---|
| `select` | `title`, `options`, `timeout?` | `{value}` | `undefined` |
| `confirm` | `title`, `message`, `timeout?` | `{confirmed}` | `false` |
| `input` | `title`, `placeholder`, `timeout?` | `{value}` | `undefined` |
| `editor` | `title`, `prefill` | `{value}` | `undefined`, **no timeout** |
| `notify` | `message`, `notifyType` | **nothing** | — |
| `setStatus` | `statusKey`, `statusText` | **nothing** | — |
| `setWidget` | `widgetKey`, `widgetLines`, `widgetPlacement` | **nothing** | — |
| `setTitle` | `title` | **nothing** | — |
| `set_editor_text` | `text` | **nothing** | — |

`custom` is not among them: it is declared and returns `undefined` in RPC mode
without emitting anything. `onTerminalInput`, `setWorkingMessage`,
`setWorkingVisible`, `setWorkingIndicator`, `setHiddenThinkingLabel`,
`setFooter`, `setHeader` and the theme and editor-component accessors are
TUI-only and no-op the same way, so Dray never has to care about any of them.

Four things follow that are easy to get wrong:

- **The five announcements are fire-and-forget.** pi mints an id for them and
  registers no waiter, so a response is dropped — but treating them as blocking
  requests to be refused files five ordinary UI messages as coverage gaps, and
  loses a line the reader was meant to see. They are output, not questions.
  Getting the split wrong is silent in both directions, which is why it is
  stated once as two lists in `dialog.rs` and the read loop is pinned by test to
  hold no opinion of its own.
- **`editor` blocks and carries no deadline.** The other three are built by
  `createDialogPromise`, which honours `opts.timeout` and `opts.signal`;
  `editor` registers its waiter by hand and passes neither, so an unanswered one
  holds its tool call for the life of the process. It looks like an
  announcement and is not one.
- **The other dialogs carry their own deadline.** `opts.timeout` rides the
  request and pi resolves the promise to the default above when it fires, so a
  card left up past it is answering a question pi has already closed — the same
  shape as Claude Code's `control_cancel_request`, arriving as a field rather
  than a line.
- **`opts.signal` aborts the same way**, which is how a cancelled tool call
  takes its dialog back. It clears `pendingExtensionRequests`; an `abort`
  command does not, so a dialog raised as a run is being stopped stays
  outstanding on pi's side until Dray answers it. Stop therefore cancels the
  dialogs it drains *and* refuses any that arrive before the next run begins,
  since the drain is a snapshot and pi is several lines ahead of it.

### It is a question, not a consent card

`dialog.rs` turns the four blocking methods into one
`AgentEventPayload::QuestionsAsked` each, which is the payload Dray already
draws a form for. Not `PermissionRequested`, and that is the honest reading
rather than reuse of convenience: nothing is being consented to, the call runs
either way, and the answer *is* the reply. `QuestionsAsked`'s own doc comment
says exactly that, written for `AskUserQuestion` before pi existed.

An Allow/Deny pair over "Which framework?" would describe the wrong act, and
picking Allow would send the string `"allow"` to an extension expecting one of
its own labels.

Three consequences, each pinned by a test:

- **`Question` grew `free_text`.** `AskUserQuestion` promises the user a box
  and tells the model not to offer an "Other" option because of it, so the box
  is not optional there. pi's `select` is a closed list and its `confirm` is a
  boolean, so a typed sentence is an answer neither can be given — the
  extension is handed a string it has no branch for. `input` and `editor` are
  the two pi dialogs that take one.
- **Each method is answered in its own shape.** `confirm` reads `confirmed`,
  the other three read `value`. `PendingRequest` carries the method for this
  alone; the id the answer names is the request id the entry is already filed
  under. A reply in the wrong shape is dropped in silence and the turn stays
  blocked, which is why the method is remembered rather than guessed at from
  what came back.
- **A skip sends `cancelled: true`**, which every dialog understands and
  resolves to the default it was constructed with. Not an empty string:
  `confirm` would read `""` as `false` and act on a decision nobody made.

`confirm` has no labels on the wire, so its two buttons are Dray's own — `Yes`
and `No` — and mapping back to the boolean happens in the same file that wrote
them.

### An extension's own tools need nothing at all

`extension_tool_and_dialogs.jsonl` settles what an earlier draft left open. A
tool registered with `pi.registerTool` reaches the wire as an ordinary
`tool_execution_start` under the name its author gave it, with its arguments in
the same field a built-in's use, and completes the same way:

```
tool_execution_start {"toolName":"probe_tool","args":{"note":"hello"},"toolCallId":"call-f3f7…"}
tool_execution_end   {"toolName":"probe_tool","result":{"output":"probe_tool ran with note=hello"}}
```

So a transcript draws it already. It classifies as `ToolType::Other`, which is
deliberate and not a shortfall: only the author knows whether their tool edits
a file, and a wrong type draws a diff viewer over something that is not a diff.
The only gap was a `TOOL_VERBS` entry, and an unknown name falling through to
itself is the right answer there too.

The capture and the probe extension that produced it are committed together
(`fixtures/extension_tool_and_dialogs.probe.js`), because no shipped extension
can be relied on to be installed on the machine running the tests.

### What the earlier `extension_approvals` capture still settles

That capture was taken against a five-line gate extension, and the gate is
gone. What it establishes about the *channel* holds regardless:

- **A denial lands where a tool error already lands.** `isError: true` with the
  reason as the text, so the transcript row draws the refusal without any new
  vocabulary. Dray's own rule — "a settled request draws no row either way:
  approval is visible in the tool simply running, refusal in the tool's own
  error" — holds exactly.
- **Requests arrive one at a time, and Dray should still not rely on that.**
  pi's docs say sibling tool calls from one assistant message "are preflighted
  sequentially, then executed concurrently", and `tool_call` is the preflight.
  `buildTranscript`'s `pendingAsks` is already a list and stays one, because
  the serialisation is pi's behaviour rather than a guarantee it publishes.
- **A reply for an id that is gone is ignored in silence** — the driver
  re-sent answered ids and nothing broke. Same property Claude's
  `control_response` has, and the same consequence: a regression here presents
  as a hung turn, not an error.
- **`cancelled: true` on a `confirm` reads as `false`.**
- **An extension sees pi's normalized input, not the model's.** The stub sent
  `edit` as `{path, oldText, newText}`; the hook received
  `{path, edits: [{oldText, newText}]}`.

### The modes cannot be honoured, so pi runs ungated and says so

Every other harness takes a stance as a flag. pi has none, and with no gate of
Dray's own there is nothing left to implement one with — so `send_msg` sends
`bypassPermissions` for pi and the composer hides the mode picker
(`offersPermissionModes`). A picker offering four stances that all behave
identically is a control that cannot do anything.

`--tools read,grep,find,ls` at spawn would give a genuine read-only agent and
is the one stance pi *can* enforce, which makes Plan mode the natural first
thing to add back. It is not built, and it is not built rather than half-built:
one honoured stance beside three that are not reads as a picker that works.

Two things worth saying plainly whenever a stance does come back:

- **`Auto` would be a weaker promise than it is elsewhere.** On Codex, "approve
  for me" is backed by an OS sandbox: a command that steps outside the
  workspace fails whether or not anyone was asked. pi has no sandbox, so an
  approved `bash` can do anything the user can. The same word for a different
  guarantee belongs in the mode picker's own copy, not only in this document.
  It is also the one place where "run pi in a container" — pi's own advice — is
  the real answer.
- **A stance change means a respawn**, because `--tools` is fixed for the
  process. Same conclusion Codex reached for a different reason, so
  `send_msg`'s existing respawn path covers it.

### What is not built

- **`opts.timeout` is ignored.** A card can outlive the dialog it draws, and
  answering a closed one is a reply pi drops in silence — so the card stays up
  offering buttons that do nothing. The cure is the one Claude Code's
  `control_cancel_request` already has: retire the card automatically and mint
  `PermissionDecided { automatic: true }`. The field is on the wire; nothing
  reads it.
- **The five announcements draw nothing.** They are dropped quietly, which is
  the honest interim — refusing them would file five ordinary UI messages as
  coverage gaps — but a reader is meant to see them.
- **A method on neither list is refused**, with `cancelled: true` and an
  `unsupported_request` line. That is the truthful answer to one nobody has
  looked at, and the wrong one to a method that only drifted out of the lists —
  which is why the split is stated once and pinned by test.
- **Load order is unexamined.** `event.input` is mutable and later handlers see
  earlier mutations, so two permission extensions installed together can
  disagree about what runs. That is between them and the reader now that Dray
  ships none.

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
one). `context_window` has no reader on `Model`: the ring takes its
denominator from the handshake's own `get_state` answer, not from the model
table — one number, read where it is already being asked for.

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

**That is not what shipped, and the reason is the reader.** A request is
settled by a line off stdout, and the read loop is what reads them — so
awaiting `get_session_stats` from inside it waits on itself and gives up
thirty seconds later, every turn. Asking from a spawned task escapes the
deadlock and loses the ordering: `TurnCompleted` is emitted and logged before
the answer lands, and there is no second event carrying occupancy for the
ring to read.

So the fallback below is the implementation. `message_end.message.usage`
carries `totalTokens`, which **is** the occupancy — one model call's prompt
plus its answer, so the turn's last call describes what the turn left behind —
and it agrees with pi's own figure exactly: 2139 in `live_turn.jsonl`, 2840 in
`no_approvals.jsonl`, against the `get_session_stats` answer captured in each.
The denominator is `get_state`'s `model.contextWindow`, taken at the handshake
that already runs, held in an `AtomicU64` the mapper reads at `agent_settled`.
The window is re-read on `model_changed`, since Dray respawns for a model
change but a pi extension calling `setModel` does not.

Three states carry no reading rather than a wrong one, and the last two are
what pi's own `getContextUsage` does: a window Dray never learned, a turn that
**failed or was aborted** — its message describes a call that did not land —
and a turn closing **after a compaction**, whose held total describes the
context that compaction just threw away. The ring settles on the newest event
carrying a figure, so a stale total there lands after `context_compacted`'s own
count and jumps the ring back up for the rest of the session. In all three the
previous reading stands, which is the safe direction. Pinned by `the_turn_carries_pis_own_occupancy_figure`, which
reads both numbers out of the captures rather than restating them.

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
`TurnCompleted`, where `message_end.message.usage` — which *is* populated — is
what the ring reads, for the reason above. Its `cost` field has no home in Dray
at all and is dropped: pi is the first harness to report money, and a surface
for it is a product decision, not a mapping one.

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
| image tray | **done** — `prompt.images` takes base64 with a mime type, the same shape Claude takes, and an attached screenshot rides it. Still to do: gate the composer's tray on the picked model's `input` including `image`. **Non-image attachments have no route**: Claude's `@/abs/path` convention is Claude's own parser, and pi expands no mentions inside an RPC prompt (below), so a dropped CSV would silently attach nothing. Codex answered this by appending a plain line naming the file, and pi should do the same |
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

Cost reporting. A fork-at-a-chosen-message picker, which `get_fork_messages`
already lists the points for — but built by copying the session file and
truncating after the chosen entry, **not** by calling pi's `fork`, for the
reasons §5 now records. Anything to
do with running pi in a container, which is pi's own answer to the sandbox
question and currently outside what Dray says anything about.

## 15. Open questions, and what settles each

| question | settled by |
|---|---|
| Do other providers through pi fragment tool arguments, or report usage mid-stream? xAI does neither | one capture each against Anthropic and OpenAI. Neither changes a mapping — only how much the streaming preview buys |
| ~~Does `fork {entryId}` hijack the running process the way `clone` does?~~ | **Settled.** Yes — `rebindSession()`. It also writes a file pi names itself, leaves the one `--session` named untouched, and keeps only what follows the fork point. See §5 |
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
