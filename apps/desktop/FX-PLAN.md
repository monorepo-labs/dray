# fx as a fourth harness, over `fx acp`

Architecture plan. Written against `fx.sh/docs/using-fx/{cli,acp,fx-ask,sessions}`
and `configure-fx/{permissions,configuration}`, and against Dray as of `main`
at `3f6b67d2`.

**Captured live against `fx 0.0.9`** (`/Users/yogesh/.local/bin/fx`, Codex
subscription as the active provider, a Vercel AI Gateway login beside it).
Every wire value below was read off a running `fx acp`, not the docs. Captures
under `harness/fx/fixtures/`; the README there says which probe produced each.

## Why ACP, and why nothing else

`fx ask --json` is one JSON object *after* the turn — no stream, no permission
channel (non-interactive mode auto-reviews), no cancel. A transcript drawn from
it is a spinner and then a wall of text. `fx acp` is the editor interface, the
one Zed and JetBrains drive fx through, on the same binary. It is ACP v1:
newline JSON-RPC 2.0 over stdio, a peer that sends requests of its own — the
exact shape `codex app-server` already is. Nothing in Dray speaks ACP today;
nothing about it is new either, the framing is Codex's `rpc.rs` verbatim and
only the method vocabulary differs.

## What the wire says

| | docs say | wire says |
|---|---|---|
| session id | "cannot be chosen" | **True.** `session/new` answers a 12-char id (`P9Dapsj2piYP`). Recorded on `SessionIndexItem.thread_id`, the slot Codex's minted id already lives in |
| modes | `ask`, `auto`, `full-access` | ACP exposes **two**: `ask` (permissionMode `ask`) and `code` (permissionMode `auto`). `FX_PERMISSION_MODE=full-access` is ignored by `fx acp`; `fx --full-access acp` is refused as an unknown subcommand; `fx acp --full-access` is refused by `acp`'s own usage. **Bypass is unreachable** |
| `ask` mode | "prompt before unresolved sensitive tool calls" | **Sensitive is narrow.** `write_file`, `edit_file`, `shell rm -rf` and `curl` inside the workspace all ran with no request. A write to `/tmp/…` outside it plus `git init` raised one |
| permission request | — | `session/request_permission {sessionId, toolCall{toolCallId,name,title,kind,rawInput}, options[{optionId,name,kind}]}`, kinds `allow_once`, `allow_always`, `reject_once`. Reply `{"outcome":{"outcome":"selected","optionId":…}}`. Server request ids start at 1, own id space |
| settings | `--model` at spawn | **True**, and everything is also settable in place: `session/set_config_option {sessionId, configId: model\|effort\|provider, value}` answers the whole `configOptions` list back; `session/set_mode {sessionId, modeId}` answers `null`. Neither needs a respawn |
| model list | `fx models` | **Per active provider, discovered.** `session/new`'s `configOptions` carry the list *and the effort ladder for that provider*: codex = 5 models, `auto low medium high xhigh max ultra`; gateway = 247 models, ladder stops at `xhigh`; grok = refused with `fx needs a Grok subscription login for this model. Run fx login grok.` |
| model validation | — | **None.** `set_config_option model nope/nothing` is accepted and echoed back as `currentValue`. The failure lands on the first prompt |
| provider switch | — | Works in place, **and writes `~/.fx/settings.json`**: after a switch to gateway the file gained `"models":{"gateway":"anthropic/claude-fable-5.1"}`. `provider` itself stayed put once switched back. A Dray session moving provider may move the reader's fx defaults — a cost to state, not a blocker |
| stream | — | `session/update` notifications keyed on `update.sessionUpdate`: `agent_message_chunk {messageId, content{type:text,text}}`, `agent_thought_chunk {content}` (no messageId), `tool_call {toolCallId,name,title,kind,status:pending,rawInput}`, `tool_call_update {toolCallId,status,content?[{type:content,content{type:text,text}}],command_result?}`, `session_info_update {title,updatedAt}`, `usage_update {used,size,cost}`, `available_commands_update {availableCommands:[]}` |
| tool kinds | ACP: read, edit, delete, move, search, execute, think, fetch, switch_mode, other | Seen: `read_file`/`glob_files` → `read`, `write_file`/`edit_file` → `edit`, `shell` → `execute` |
| `edit_file` | ACP has a `diff` content block | **Not sent.** `rawInput` carries `{path, old_string, new_string}` — the pair `diff.ts` already reads for Claude's `Edit`. The completion is text: `edited greet.py (64 bytes)` |
| `shell` result | — | Streams stdout as `in_progress` updates, one per line. The `completed` update carries a JSON blob as text **and** `command_result {exit_code, signal, duration_ms, stdout_bytes, output_file…}` beside the content. `exit_code` and `duration_ms` map straight onto `ToolResult` |
| turn end | — | The `session/prompt` **response**: `{stopReason, usage{inputTokens,outputTokens,cacheReadTokens,cacheWriteTokens,reasoningTokens}}`. `end_turn`, `cancelled`, `refused` seen. No `turn/started` notification — the turn opens when the request is written |
| title | — | `session_info_update.title` after the first turn, model-written (`Create hello.txt and report its size`). Free, so `title.rs` need spawn nothing for fx |
| context ring | — | `usage_update.used` / `.size` (7567 / 272000). An occupancy, not a cumulative — the trap Codex's `total` and Claude's `result.usage` both set is absent |
| stop | `session/cancel` | A **notification**, not a request. The running shell died on signal 15, its `tool_call_update` came back `failed`, the prompt answered `stopReason: cancelled` |
| resume | `session/resume`, `session/load` | Both work. `resume` replays nothing and the next prompt remembers the first; `load` replays history as `user_message_chunk`/`tool_call`/… updates (unneeded — Dray's own log is the replay). One process can hold several sessions; `session/close` works |
| images | `promptCapabilities.image: true` | A `{type:image, data, mimeType}` block on the Codex provider answered `stopReason: "refused"`, usage `{}`. Not wired in v1 |
| slash commands | — | `available_commands_update` is empty. Nothing to pick from |
| bad cwd | — | `session/new` with `/nonexistent/dir` succeeds silently |
| skills | — | The first turn's first `agent_message_chunk` was a `skill discovery warning: …` paragraph, drawn as assistant text. fx's, not ours; noted so nobody files it as a mapper bug |

## Decisions

- **In place, all four.** `Capabilities { applies_model_in_place: true, applies_effort_in_place: true, applies_permission_in_place: true }` — the first `true` effort in the table, so `an_effort_change_always_replaces_the_child` becomes a test that fx is the exception. `Session::set_effort` is new and reaches fx alone.
- **Discovered models, pi's UI — through `fx models --json`, not `fx acp`.** A `session/new` with no prompt is still **persisted**: `fx sessions` listed nine empty rows from one afternoon of probing, so a probe through ACP would litter `~/.fx/sessions` on every cache miss. `fx models --json` makes no session and names the source on every row, which is the provider. Cost: no effort ladder on that answer, so `ladder_for` is a two-row table by provider read off the captures (codex to `ultra`, everything else to `xhigh`). Cached 120s like pi's. `SHORTLISTED` gains `fx`; `DEFAULT_MODEL_FOR.fx = UNSET`, fx's own `settings.json` picks.
- **The model rides the spawn as `--model`, a process-level override fx saves nowhere** — verified: `settings.json` byte-identical after, and a later `set_config_option model` on the same session still moved it. Effort and mode are set in place after `session/new`.
- **Provider is a composer control, creation-time only, and it is fx's global setting.** `set_fx_provider` runs `fx provider <name>` and forgets the list; the row says "Changes fx's provider everywhere". A live session keeps its provider — a cross-provider `set_config_option model` on a running session is unverified, and the in-session `provider` switch writes `settings.json` too.
- **Stances: `manual` → `ask`, `auto` → `code`.** `HONOURED.fx = ["manual", "auto"]`. `stanceFor` today falls to `bypassPermissions` for an unhonoured stance; fx cannot run that, so the fallback becomes per-harness — fx's is `auto`, the widest it has.
- **Diffs off `rawInput`.** `edit_file` maps to `ToolType::FileEdit` with input `{file_path, old_string, new_string}` (`path` renamed so `toolSummary` and `diff.ts` read it unchanged). `write_file` maps to `{file_path, content}`. No `FileEdits` event — nothing on the wire carries a unified diff, and the existing row already draws the pair.
- **Not forkable.** fx has no fork and its resume handle is a server-minted id, not a file. `session recover <id>` copies a session but is a CLI command against `~/.fx/sessions`; later, maybe.
- **Worktrees are Dray's** (`creates_own_worktree: false`), the Codex/pi route.
- **Title from the wire.** `session_info_update` → `store::set_session_title` + `session_title` event, through the same path `title.rs` emits on. `title.rs`'s fx arm bails, as pi's does; the wire answers first anyway.
- **Stop = `session/cancel`**, a notification, and the reader reports the end through the prompt's own response.

## Mapping

| ACP | `AgentEventPayload` |
|---|---|
| `session/prompt` written | `TurnStarted`, `ModelRequestStarted` (synthesized — fx sends no "requesting" ping) |
| `agent_message_chunk` | `Delta::BlockStart` on a new `messageId`, `Delta::TextDelta`; on the next different `messageId` or turn end, `BlockStop` + committed `AssistantMessage` |
| `agent_thought_chunk` | `Reasoning` (no id — one block per run, closed by the next non-thought update) |
| `tool_call` | `ToolCallStarted { call_id: toolCallId, name, tool_type: kind→ToolType, input: rawInput (renamed), title }` |
| `tool_call_update completed\|failed` | `ToolCallCompleted { text: content joined, is_error: failed, exit_code, duration_ms: command_result }` |
| `tool_call_update in_progress` with content | accumulated per call and used as the completed row's text — the closing update carries only fx's replay blob |
| `session/request_permission` | `PermissionRequested` with the server's options carried whole; `Reply::Rpc(id)` |
| `session_info_update` | `session_title` (side channel, not a transcript event) |
| `usage_update` | `UsageUpdate` and folded onto the turn's `TurnCompleted.usage.contextWindow` |
| prompt response | `TurnCompleted { status: Success (end_turn, cancelled — a Stop, the reading Codex's interrupted makes) \| Error (refused, max_tokens, max_turn_requests) }` |
| `available_commands_update`, `user_message_chunk` (load replay) | ignored, modelled |

## Layout

```
harness/fx/
  fx.rs           spawn, handshake, session/new|resume, read loop, cancel, in-place setters
  parser.rs       session/update + request_permission → typed FxEvent
  mapper.rs       FxEvent → AgentEvent
  permissions.rs  options → card, same bargain as codex/permissions.rs
  models.rs       throwaway probe → Vec<Model>, ProbeCache
  fixtures/       live captures + README
```

`RpcClient` and `Incoming` are imported from `harness/codex/rpc.rs` as-is — it
is plain JSON-RPC — with one addition, `request_detached`, for the one request
whose answer is a turn rather than an acknowledgement. `Transport` gains
`Fx(FxSession)`; `Reply::Rpc` is reused, the decision carried being the whole
ACP outcome envelope.

Frontend: `Harness` union (generated), `AGENT_LABELS`, `AgentIcon`,
`HARNESS_ORDER`, `DEFAULT_MODEL_FOR`, `SHORTLISTED`, `HONOURED`, the per-harness
`stanceFor` fallback, `ProviderSelector` in the composer, `TOOL_VERBS` for
`read_file`/`write_file`/`edit_file`/`glob_files`/`shell`.

## Known costs, stated

- A permission card appears only where fx thinks it should; `manual` is not "every write asks".
- Provider switch writes fx's own settings file.
- Model ids are not validated by fx; a bad one fails on the first prompt with fx's sentence.
- One active prompt per connection, and no injection point inside a turn — a prompt typed mid-turn always queues to the turn's end and the queue drains one message per turn, where Codex and Claude take several at a tool boundary.
- `binpath` caches `fx`'s path for the process, like every other CLI.
- The effort ladder is per provider, not per model. A level fx declines fails the first prompt with fx's own sentence.
- Every `fx acp` session Dray opens is persisted by fx, prompted or not; a session that failed before its first prompt still leaves a row in `fx sessions`.
