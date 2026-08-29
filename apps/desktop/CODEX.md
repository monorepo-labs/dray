# Codex, in plain terms

Dray now runs two agents. This is what you need to know to work on the second
one. The full design, with the alternatives that were rejected and why, is in
[CODEX-PLAN.md](CODEX-PLAN.md).

## The one difference that explains everything else

Claude Code is a **pipe**. We spawn it, write a line, and read lines back. It
never asks us anything except permission, and that arrives on a side channel
bolted onto the same pipe.

Codex is a **peer**. We spawn `codex app-server` and both sides speak JSON-RPC:
we send requests and wait for answers, and *it* sends requests and waits for
ours. Every awkward part of this integration comes from that one fact.

Three consequences:

- **Sending a prompt is now a question, not a shout.** `turn/start` has an
  answer, and a failure — a dead thread, a turn that cannot be steered — comes
  back as an error instead of a prompt that silently vanished.
- **Silence is dangerous.** When Codex asks us something it stops and waits. Not
  answering hangs the turn with nothing on screen saying why.
- **We are not in charge of ids.** Codex mints its own thread id. Dray has always
  minted the session id and had the CLI adopt it.

## How a Codex session runs

```
spawn `codex app-server`
  ↓
initialize  →  ←  {userAgent, codexHome}      handshake, once per connection
initialized →                                  (a notification, not a request)
  ↓
thread/start {cwd, model, approvalPolicy, sandbox, developerInstructions}
  ←  {thread: {id}}                            ← recorded on the index entry
  ↓
turn/start {threadId, input, model, effort, approvalPolicy}
  ←  {turn: {id}}                              ← the id Stop has to name
  ←  turn/started
  ←  item/started      {agentMessage}          ← a block opens
  ←  item/…/delta      …                       ← streamed preview
  ←  item/completed    {agentMessage}          ← the committed text wins
  ←  thread/tokenUsage/updated                 ← the context ring
  ←  turn/completed
```

The code is four files under `src-tauri/src/harness/codex/`:

| file | what it does |
|---|---|
| `rpc.rs` | The JSON-RPC plumbing. One writer queue, a map of what we're waiting on, and a demux that sorts each line by whether it has an id, a method, or both. |
| `parser.rs` | Wire shapes → typed Rust. Hand-written, because nobody publishes a schema. |
| `mapper.rs` | Those → Dray's own `AgentEvent`s, the same vocabulary Claude Code maps onto. |
| `codex.rs` | Spawn, handshake, the read loop, and sending a turn. |

That's the same `parser` / `mapper` split Claude Code uses, so a wire change
touches one file and a vocabulary change touches the other.

## Two ids, and ours stays in charge

Dray's session id keys the log filename, the attachments directory, the index,
and every `dray` command. All of those are written **before** the child starts —
that's deliberate, so a session whose agent fails to launch is still visible.

Codex's thread id can't do that job: it doesn't exist until the child answers.
So it's stored as one field on the index entry, `thread_id`, and read by exactly
one thing: resume.

A fork deliberately does **not** inherit it. A fork is a new conversation on
Codex's side too, so carrying the parent's id would make the fork's first
message write into the conversation it copied.

## The docs are wrong, so everything was checked against a real server

Captured against `codex-cli 0.148.0-alpha.21`. Four things in OpenAI's own
README don't match what the binary does:

| README | actually |
|---|---|
| `sandbox: "workspaceWrite"` | `"workspace-write"` — kebab-case, and camelCase is **rejected outright** |
| `approvalPolicy: "unlessTrusted"` | `"untrusted"` |
| `turn/completed` carries no items | it carries all of them |
| the client works out which approval buttons to show | the server names them, in `availableDecisions` |
| `thread/start` takes an `effort` | it does not — the field is accepted and silently dropped, so effort rides `turn/start` |
| `turn/interrupt` takes a thread | it takes a thread **and a turn**, and refuses `missing field turnId` without one |

And one thing the docs don't mention at all, which is the trap most worth
knowing:

> **`thread/tokenUsage/updated` reports two numbers.** `total` is cumulative
> across every model call in the turn. `last` is the actual context occupancy.
> On a three-call turn `total` ran 15593 → 31298 → 47083 while `last` ran
> 15593 → 15705 → 15785. **The context ring reads `last`.** Reading `total`
> would show three times the real usage.
>
> This is the same trap CLAUDE.md documents for Claude's `result.usage`. Codex
> also hands over `modelContextWindow`, so unlike Claude there's no per-model
> window table to maintain.

The captures that prove all of this are committed as fixtures and replayed by
tests — see `src-tauri/src/harness/codex/fixtures/README.md`.

## Things that would have bitten silently

- **Codex echoes your prompt back** as a `userMessage` item. Dray already mints
  its own — carrying the tree baseline, images and issue links, none of which
  the echo has. The mapper drops the echo, or every prompt would appear twice.
- **A stale `codex` wins PATH.** There's a `codex-cli 0.29.0` in an nvm bin
  directory on this machine with no `app-server` subcommand at all. It treats
  `app-server` as a *prompt*, opens an interactive TUI, writes terminal escape
  codes to stdout, and never answers — surfacing 30 seconds later as a handshake
  timeout that blames the protocol. So `binpath::codex()` asks each candidate
  whether it lists `app-server` before choosing it.
- **Codex never says "I'm thinking".** Claude sends a `requesting` ping that
  drives the working indicator. Codex sends nothing, so the mapper synthesizes
  one at the start of a turn and after every tool call. Without it the indicator
  fires once and stays quiet for the rest of the turn.
- **Steering works, and not through `turn/steer`.** The server exposes that
  method — it sits beside `turn/start` and `turn/interrupt` in the binary's
  client-method list — and Dray never calls it. A prompt typed mid-turn goes out
  as an ordinary `turn/start`, which the server accepts on a thread that already
  has a turn running and folds into it. Verified live. `start_turn` awaits its
  answer for exactly this reason, so a turn that *cannot* be steered comes back
  as an error rather than a prompt that vanished. Wiring `turn/steer` would
  change behaviour that already works; if it is ever wanted, it needs a capture
  first, like everything else here.
- **An item kind we have not typed vanishes without a trace.** An unknown
  *method* files a parse failure; an unknown **item kind** falls into
  `ThreadItem::Other`, maps to nothing, and files no failure at all. A real
  session made 62 tool calls and Dray drew 34 — `mcpToolCall`, `webSearch`,
  `imageView`, `subAgentActivity` and `collabAgentToolCall` all drew nothing,
  and the only way that surfaced was reading Codex's own rollout beside our log.
  `tool_kinds.jsonl` and `every_captured_tool_kind_draws_a_row` exist so the
  next one fails a test instead.
- **Web search arrives two different ways.** A plain `app-server` session emits
  a native `webSearch` item; a session under the ChatGPT connectors emits
  `extension` with `kind: "web.search"`, carrying the same query and results.
  Both were captured live. CODEX-PLAN.md planned only the first, so building to
  the plan would have drawn half the searches a reader makes.
- **A Codex tool name is not a Claude tool name, and the label table is keyed by
  name.** `toolLabel` returns the raw name on a miss, so `shell` and
  `apply_patch` rendered as lowercase wire tokens beside Claude's "Bash" and
  "Edited" until both were added to `TOOL_VERBS`. Any tool name a new mapper arm
  invents needs a row there in the same change.
- **The server sends about eighty notifications and Dray draws nine.** Growing
  the "seen, drawn as nothing" list one failure at a time makes the failure log
  useless, because every ordinary turn files gaps that are not gaps — an
  interrupted command narrates itself on
  `item/commandExecution/terminalInteraction`, which is how this was found. The
  list in `parser.rs` is taken from the server's own `ServerNotification` enum
  instead, read straight out of the `codex` binary:

  ```
  strings -a <codex> | grep -o 'ServerNotificationthread/started.*setupCompleted'
  ```

  What stays *unknown* is the rule. Surfaces Dray never opens — realtime voice,
  fuzzy file search sessions, the Windows sandbox, config import — are left out
  deliberately, so one arriving is real news rather than more chatter.

## What works today

A Codex session runs, streams, and resumes. The transcript draws agent messages,
reasoning, shell commands with their output, and file changes with real unified
diffs. The context ring fills. The changes panel works — it diffs tree
snapshots, so it never needed anything harness-specific.

Stop names the turn as well as the thread, which is not optional: a
`turn/interrupt` carrying only a thread id is refused outright with `missing
field turnId`. So the running turn's id is tracked — recorded when `turn/start`
answers, overwritten by `turn/started`, cleared by `turn/completed` — and with
no turn running, Stop is a no-op rather than an error.

You pick the agent in the composer, left of the model picker. It's
creation-time only, like the project and branch pickers: the harness *is* the
child process. The model list follows your pick, since a Codex model and a
Claude model are not interchangeable.

## Permission modes, and the second knob

Claude has one setting: when does it ask you. Codex has two, and they are
independent:

- **`approvalPolicy`** — when it asks. `untrusted` / `on-request` / `never`.
- **`sandbox`** — what a command is *allowed to do*, enforced by the OS whether
  or not anyone was asked. `read-only` / `workspace-write` /
  `danger-full-access`.

The sandbox is not a policy the model can talk its way past — commands run
inside it, so a write outside the workspace fails outright. That is why
"approve for me" works the way it does: the agent runs freely *inside* the
sandbox and only stops to ask when it needs to step outside.

Codex's own UI names three combinations. Dray's stances land on them:

| Dray | Codex | wire |
|---|---|---|
| Ask every time | Ask for approval | `untrusted` + `workspace-write` |
| Auto | Approve for me | `on-request` + `workspace-write` |
| Bypass permissions | Full access | `never` + `danger-full-access` |

`Don't ask` has no Codex label of its own — it is "approve for me" with the
asking turned off, still inside the same sandbox. **Plan is hidden for Codex**:
it maps onto read-only-and-ask, which is close, but it is a stance Codex never
names. It is still mapped, because a spawned session inherits its parent's.

`acceptEdits` was a sixth Dray stance and is gone. It applied edits without
asking while still asking about commands — a promise too narrow to fit on a
button beside Auto. Sessions started under it read back as Auto; the alias in
`ApprovalPolicy` is what keeps their index entries loading.

**The card is wired.** When Codex asks, the same permission card Claude raises
appears, and the buttons are **the server's own**: Codex sends
`availableDecisions`, and each button carries one of those values back
untouched. A decision this build cannot put into words is dropped rather than
drawn as a button nobody can predict.

One thing the real capture taught: a request can offer **no refusal at all**.
The captured one offered `accept`, an execpolicy amendment and `cancel` — so a
card built only from what was named would have had no way to say no. `decline`
is always a legal answer, so it is added when the server names none.

## Turn boundaries, and why the transcript ignores them

Codex gives Dray what Claude Code cannot: real `turn/started` and
`turn/completed` lines, a `duration_ms` on the close, and a final summary
message. Codex's own app uses them to collapse a whole turn behind one
"Worked for 19s" header, from the moment you send.

Dray keeps its own grouping instead, deliberately. The transcript infers turns
for Claude and segments them at **queued prompts**, so a message typed mid-turn
stays where it was typed — and *when* the reader said something is part of what
they said. Codex's single group loses that. The duration is mapped and
persisted on `turn_completed`; nothing draws it today. Both are available if the
collapse label ever wants them.

## A subagent is a second thread on the same connection

Claude Code files a subagent's work under the tool call that spawned it, and the
envelope carries the join. Codex has no envelope. The subagent gets its **own
thread id**, and everything it does — `turn/started`, its items, its deltas, its
`thread/tokenUsage/updated`, its `turn/completed` — arrives on the same socket
as the main conversation, distinguished by `threadId` and nothing else.

So the mapper keeps a map of subagent thread → run, and stamps
`AgentEvent.subagent` from it. Three things go wrong at once without it, and all
three are silent:

- the subagent's answer is drawn as though the primary agent said it;
- its `turn/completed` **settles the session** while the main turn is still
  running, so the composer goes idle mid-task;
- its `thread/tokenUsage/updated` overwrites the context ring, which then
  describes a conversation the reader is not having.

The last two are why the guard drops the subagent's turn and usage events
outright rather than merely labelling them: an event filed under a run is still
an event, and `session.rs` reads turn boundaries off the payload.

**Its deltas are dropped in the frontend, for the same reason one layer up.**
There is one streaming preview per session, so a correctly stamped subagent
delta still streamed into the main transcript, ran to the end, vanished when the
committed message filed itself under the run, and left the primary agent's reply
to start streaming into the space. Claude Code sends no deltas for subagent
output at all, which is why the preview never needed the check before.

**The join is `agentThreadId`, never the activity's own id.** The lifecycle
arrives as two `subAgentActivity` items on the main thread:

```
kind=started    id=call_THudg…                        agentThreadId=01a04c84-8c9b…
kind=completed  id=subagent-completed-01a04c84-8cda…  agentThreadId=01a04c84-8c9b…
```

`started` carries the spawning call's id; `completed` mints a synthetic one.
Joining on `id` leaves the run open forever — and quietly, since an unclosed run
just keeps shimmering.

**`subAgentActivity{started}` *is* the spawn row.** There is no
`collabAgentToolCall` for it — the only one of those in the capture is `wait`,
the tool the model calls to block on the agent it already started. Without an
arm for the activity there is no row for the run at all, so the transcript shows
a `wait` on something that never appeared.

**`wait` itself draws nothing.** It carries `prompt: null` and names no
receiver, so its row read `wait wait` — the same word twice, about a run whose
own row and panel entry sit directly above it. The gate is on having something
to say rather than on the name, so a call that hands a brief to a named agent
still draws. A call that drew no row is not answered either: the result is keyed
by call id, and a stray one closes a row nobody opened, which a group header
counts as a call that is not there.

**The panel's spawn row is gated the same way.** It exists to show the brief,
and Codex's spawn carries only the agent's name — so drawing it printed
`spawn_agent read_footer` under a header already reading `Read footer`. The rule
reads off the call (`input.prompt`), not off the harness.

**The name is written as prose.** `agentPath`'s last segment is an identifier
(`read_footer`) and the card is a sentence beside a running orb, so separators
become spaces and the first letter is raised. Nothing else is touched — a name
already carrying deliberate capitals comes through as it was.

`item/started` and `item/completed` both carry the identical activity, so it is
acted on once, on `started`.

**The completion emits two events, and the second is stamped by hand.** Closing
the spawning tool call settles the transcript row; the panel reads `done` off a
`SubagentCompleted`, which has to carry the run's envelope or it matches no run.
The activity rides the *main* thread, so the mapper's automatic stamping leaves
it `None` — and an unstamped one is silent: the subagent shimmers for the rest
of the session. Its usage is deliberately left off, since that reading was
dropped rather than folded into the ring.

The name comes off `agentPath` (`/root/count_to_three`), which is the agent's
own name and not a filesystem path — `/root` is the namespace they all share, so
the last segment is the name.

## What doesn't, yet

Not wired: fork for Codex (it refuses before it copies anything, rather
than forking into the parent's own conversation) and images in prompts.

A card left on screen when its turn is interrupted stays there — Codex sends no
"never mind" for an approval the way Claude's `control_cancel_request` does, so
the buttons answer a turn that has gone. Harmless (the reply is ignored) but
untidy.

Model, effort and permission mode **do** change mid-session, by replacing the
child rather than steering it. Codex takes model, effort and approval policy as
`turn/start` overrides, so two of the three could apply in place — but a stance
is two settings and `sandbox` has no turn-level form, so applying one in place
would move the approval policy and leave the sandbox where it was. Respawning
settles both at once; `thread/resume` carries the conversation across it.

Worktrees **do** work, by a different route. Claude gets a `-w` flag and makes
its own tree; Codex has none, so Dray creates the tree first — resolving the
same `origin/HEAD` base the CLI would have — and starts Codex inside it. That is
the route `dray new --from` already took, so a Codex session's tree is on disk
and clean before the first turn, which makes its changes baseline exact rather
than the approximation a `-w` session starts with.

## Testing it

```bash
cd apps/desktop/src-tauri
cargo test codex                    # fixtures replayed through parser + mapper
cargo test --lib handshake_against_a_live_server -- --ignored --nocapture
```

The second one drives a **real** `codex app-server` — handshake and
`thread/start`, no model call, so it costs nothing. Run it after touching
`rpc.rs` or the handshake. It's the test that caught the stale-binary bug, which
the fixtures could not: they replay a recording, this holds a conversation.
