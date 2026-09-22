# Grok Build as a fifth harness, over `grok agent stdio`

Research note and architecture plan. Written against `docs.x.ai/build/*`, the
bundled offline docs at `~/.grok/docs/user-guide/*.md` (extracted by the CLI on
launch; `15-agent-mode.md`, `14-headless-mode.md`, `17-sessions.md`,
`22-permissions-and-safety.md`, `26-config-reference.md` are the ones that
matter), and Dray as of `main` at `223794cf`.

**Captured live against `grok 1.0.40 (eb1a2256660d) [stable]`**
(`/Users/yogesh/.local/bin/grok`, signed in through `auth.x.ai` OIDC), on
2026-09-22. Every wire value below was read off a running `grok agent stdio`
or `grok -p`, not the docs. Raw captures sit under `/tmp/grok-probe/` for now —
**do not commit them as they are**: `_x.ai/mcp/servers_updated` echoes the
reader's whole `~/.grok` MCP config, env values and connection strings
included. Fixtures for the harness dir must be re-captured under a scratch
`GROK_HOME` with no MCP servers configured.

## What it is

"Grok Build" is xAI's coding agent. One binary, three faces: a TUI (`grok`),
headless (`grok -p … --output-format …`), and ACP (`grok agent stdio`). It is
a deliberate Claude Code clone on the surface — `--permission-mode` takes
Claude's exact enum (`default acceptEdits auto dontAsk bypassPermissions
plan`), `--allow` is aliased `--allowedTools`, `--session-id`/`--resume`/
`--fork-session`/`-w` all exist with Claude's semantics, it reads `CLAUDE.md`,
`.claude/rules/`, `.claude/settings.json` hooks and MCP config, `~/.claude/skills`,
and one of its two streaming formats is literally the Messages API
`stream-json` wire format (`system/init`, `assistant`, `user`, `result`,
`stream_event`). Install: `curl -fsSL https://x.ai/cli/install.sh | sh`.

Models today: `grok-4.7`, `grok-4.7-build-fast`, `grok-4.6`, `grok-4.5`. All
500k context. Ladder `low medium high xhigh` on 4.7/4.6, `low medium high` on
4.5; default `high` everywhere. No image input over ACP
(`promptCapabilities.image: false`). Auth is OIDC at `auth.x.ai` (browser or
`--device-auth`) or `XAI_API_KEY`; a `grok` subscription session token wins
over the key.

## Why ACP, and why not the Claude-shaped stream

Three routes were on the table.

- **`grok -p --output-format streaming-messages-json --include-partial-messages`.**
  Parses with Dray's Claude Code parser almost unchanged (measured: `system/init`
  with `permissionMode`, `tools`, `slash_commands`, `mcp_servers`; `assistant`
  with `thinking`/`text`/`tool_use` blocks and Claude's `usage` shape; `user`
  with `tool_result`; `result` with `total_cost_usd`, `modelUsage`,
  `num_turns`; `stream_event` framing). Tempting and wrong: it is **read-only
  and single-turn**. No stdin input format, no `--permission-prompt-tool`, no
  `control_request`, and the docs say so outright ("Tool approvals and other
  bidirectional flows use the ACP interface"). Multi-turn would be one process
  per prompt via `--resume`, with `--always-approve` forced. Same dead end
  `fx ask --json` was.
- **`grok -p --output-format streaming-json`.** xAI's own flat NDJSON
  (`thought`, `text`, `tool_call`, `tool_call_update`, `usage`, `plan`,
  `available_commands`, `end`, `error`). Same single-turn, read-only limit.
- **`grok agent stdio`.** ACP v1, newline JSON-RPC 2.0, a peer that sends
  requests of its own — the exact shape `fx acp` already is, and the framing is
  `harness/rpc.rs` verbatim. Full permission channel, in-place model and effort,
  cancel, resume in a fresh process, client-chosen session ids. **This one.**

## What the wire says

| | docs say | wire says |
|---|---|---|
| spawn | `grok agent [--model M] [--reasoning-effort E] [--yolo] stdio` | Agent-level flags go **between `agent` and `stdio`**. `--allow`, `--permission-mode`, `--rules` are TUI/headless flags and are **refused** on `grok agent` (`error: unexpected argument`). `--no-leader` is worth passing: `[cli] use_leader` defaults off, but a reader who turned it on would otherwise get every Dray session multiplexed through one shared process |
| `initialize` | `{protocolVersion: 1, clientCapabilities}` | Answers in **0.45s** with `agentCapabilities` (`loadSession: true`, `sessionCapabilities: {list, resume, close}`, `promptCapabilities: {image: false, embeddedContext: true}`), `authMethods: [cached_token, grok.com]`, and a `_meta` carrying `agentVersion`, `modelState: {currentModelId, availableModels[{modelId, name, description, _meta:{totalContextTokens, supportsReasoningEffort, reasoningEffort, reasoningEfforts[{id, label, description, default}]}}]}` and `availableCommands`. **The model list and every effort ladder are on the handshake, before any session exists** — a throwaway `initialize` is the picker's probe, no session written |
| session id | "UUIDv7 when Grok generates it; a client may supply its own with `-s`" | **`_meta.sessionId` on `session/new` is honoured** — the reply's `sessionId` was the v4 Dray sent, and `session/resume` in a fresh process found it. So `SessionIndexItem.id` *is* the grok id; no `thread_id` slot needed (fx's bargain is not needed here) |
| `session/new` | `{cwd, mcpServers, _meta:{rules, systemPromptOverride, agentProfile, yoloMode, autoMode}}` | **0.33s.** Answers `{sessionId, models, configOptions, _meta}`. `configOptions` = `[{id: model, category: model, currentValue, options[{value, name}]}, {id: reasoning_effort, category: thought_level, currentValue, options[{value, name, description}]}]`. `modes` is **absent**. `_meta.isGitRepo`, `gitRoot`, `showNonGitWarning` ride along |
| `mcpServers: []` | — | **Grok merges its own `~/.grok` MCP config anyway** (`_x.ai/session/setup` phase `mcp_merge`, then `_x.ai/mcp/init_progress` and `_x.ai/mcp_initialized {mcpToolCount: 44, elapsedMs: 4969}`), including Claude's `.mcp.json` and Cursor's through its compat scanners. The opposite of fx: Dray hands over nothing and the reader's servers are there. `session/new` returns before MCP init finishes; the first prompt's toolset waits on a startup grace |
| rules / system prompt | `_meta.rules` "appended to the system prompt" | **True, and it persists onto the session.** A `rules` naming a codeword was obeyed on the first turn *and* after `session/resume` in a fresh process with no `rules` sent. So Dray's rules ride `session/new` once, as a real field, not as prompt text — none of fx's first-prompt-append or title-stripping is needed |
| model / effort at creation | `--model`, `--reasoning-effort` on `grok agent` | Both work. `_meta.model` / `_meta.reasoningEffort` on `session/new` **also** moved them (probe sent `--model grok-4.6 --reasoning-effort low` on the spawn and `_meta:{model: grok-4.7, reasoningEffort: medium}` on `session/new`; the session came up on 4.7 at medium). The flags are the safer statement — `_meta` fields beyond the documented five are undocumented |
| in-place model / effort | `session/set_config_option {sessionId, configId, value}` | **Works, both.** Answers the whole updated `configOptions` list and mirrors it as `session/update config_option_update`. `value` is a bare string (`"xhigh"`), not the doc's `{value: …}` wrapper — both accepted. A `_x.ai/session_notification model_changed {model_id, reasoning_effort}` follows. Effort change persists onto the session record (resume came back at `xhigh`) |
| in-place permission mode | `session/set_mode {sessionId, modeId}` | **Inert.** Answers `{}` for `bypassPermissions`, `always-approve` and `nonsense-mode` alike and changes nothing — a shell command still raised a card afterwards. **What does work is `/always-approve on` sent as prompt text**: the reply was a one-line ack, no model call, and the next shell command ran without asking. So a stance change is a prompt-text command, which costs a bubble, or a respawn. `_meta.permissionMode` with Claude's enum is swallowed (`plan`, `bypassPermissions`, `acceptEdits` all raised cards) |
| auto mode | `_meta.autoMode: true` | A classifier with **no client surface**: a blocked call fails the tool with "Auto mode blocked this action (…)" to the model and raises no `session/request_permission`; an allowed one runs. Blocked: `rm -rf ./keep` in the cwd. Ran: `rm -rf` outside the cwd, `git push origin main`, `curl -X POST`. `yolo: false` throughout |
| plan mode | `/plan` as prompt text; `_x.ai/exit_plan_mode {sessionId, toolCallId, planContent}` | No toggle method (`_x.ai/toggle_plan_mode` → unknown extension method). `/plan` as text enters in place (one bubble, a model call). `enter_plan_mode`/`exit_plan_mode` are the model's tools; exit is a **client request** bracketed by `pending_interaction {kind: plan_approval}` / `interaction_resolved`. Reply `{"outcome":"approved"}` approves; any other shape or an error reads as "revise". Plan file `~/.grok/sessions/<cwd-encoded>/<id>/plan.md` |
| permission request | `session/request_permission` | `{sessionId, toolCall{toolCallId, kind, title, rawInput{variant: Bash, command, description, is_background}, _meta:{"x.ai/tool":{name, kind, namespace, label, read_only, input}}}, options[{optionId, name, kind}]}`. Four options: `always-allow` (`allow_always`, "Yes, and don't ask again for bash commands"), `allow-once` (`allow_once`), `reject-once` (`reject_once`, "No, and tell Grok what to do differently"), `reject-always` (`reject_always`). Reply `{outcome:{outcome: selected, optionId}}`. Bracketed by `_x.ai/session_notification pending_interaction {tool_call_id, kind: permission}` / `interaction_resolved {tool_call_id}`. Server request ids start at **0**, own id space |
| `ask_user_question` | — | **Its own client request, not a permission**: `_x.ai/ask_user_question {sessionId, toolCallId, questions:[{question, options:[{label, description}], multiSelect}], mode}`. Answered with a JSON-RPC error, the tool failed and the model carried on ("The question tool could not reach the client"). Reply shape under probe |
| `ask` mode | "Read-only tools and built-in read-only shell commands" run without asking | Wider ask than fx's: `git init && echo done` inside the workspace asked, a `write` to the workspace asked (probe 1 auto-allowed both). Auto-approved list is documented and word-boundary matched: `ls cat head tail wc grep rg git status/log/diff/…`. **Bypass is reachable** (`--yolo`, `_meta.yoloMode`) — the mode fx cannot run |
| stream | `session/update` with `sessionUpdate` | Standard ACP: `agent_message_chunk {content{type: text, text}}` (no `messageId`), `agent_thought_chunk {content}`, `tool_call {toolCallId, title, rawInput, _meta:{"x.ai/tool":{name, kind, namespace, label, read_only}}}`, `tool_call_update {toolCallId, kind, title, content, locations, rawInput, status?, rawOutput?}`, `available_commands_update {availableCommands[{name, description, input{hint}}]}`, `session_info_update {title}`, `config_option_update`. Every update's `_meta` carries `totalTokens`, `eventId`, `promptId`, `agentTimestampMs` |
| tool naming | ACP `kind` | **`kind` is on the *update*, not the `tool_call`** — the opening `tool_call` carries `title: "write"` and `_meta["x.ai/tool"].kind: "write"`; the ACP `kind: edit` arrives on the first `tool_call_update` beside a proper `title: "Write \`/path\`"`. Read `_meta["x.ai/tool"].name` for the tool and `.kind` for the class; wait for the update for the display title. Tools seen: `write` (namespace `opencode`), `search_replace`, `run_terminal_command` (`grok_build`), `read_file`, `todo_write`, `ask_user_question`, `spawn_subagent` |
| edits | ACP `diff` block | **Sent.** `tool_call_update.content: [{type: diff, path, oldText, newText, _meta:{details:[{old_string, old_line, new_string, new_line, context_before, context_after}]}}]` on both `write` and `search_replace`. `rawInput` is `{file_path, content}` for `write` and `{file_path, old_string, new_string}` for `search_replace` — Claude's own field names, so `diff.ts` and `toolSummary` read them unchanged |
| shell result | — | Streams `in_progress` updates carrying the whole `rawOutput` each time: `{type: Bash, output: [bytes], output_for_prompt, exit_code, command, truncated, signal, timed_out, current_dir, output_file, total_bytes}`. `completed` carries the same with `output_for_prompt` prefixed `exit: 0\n`. `content[0].content.text` is the stdout so far. `output` is a **byte array**, not a string — read `output_for_prompt` |
| turn end | prompt response `{stopReason}` | `{stopReason, _meta:{sessionId, promptId, modelId, totalTokens, inputTokens, outputTokens, cachedReadTokens, reasoningTokens, usage{…, costUsdTicks, modelCalls, apiDurationMs, modelUsage{<model>:{…}}, numTurns}}}`. Preceded by `_x.ai/session_notification turn_completed {prompt_id, stop_reason, usage, elapsed_ms}` and `_x.ai/session/prompt_complete`. `end_turn`, `cancelled` seen; docs list `max_tokens`, `max_turn_requests`, `refusal` |
| context ring | — | **`_meta.totalTokens` on the prompt response is the occupancy** (21598 → 22429 across two turns of one session; `usage.inputTokens` beside it is the per-turn sum, Claude's `result.usage` trap). `totalContextTokens` on the model entry is the window. `usage_update` never seen |
| per-response usage | — | `_x.ai/session_notification response_completed {usage{input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens, reasoning_tokens}, signature}` once per model call |
| title | "generated automatically from the conversation… regenerated at a couple of early turns and frozen" | `session/update session_info_update {title}` lands **mid-turn, before the tool calls** (probe D), model-written, plus `_x.ai/session_notification session_summary_generated`. Whether the prompt reply waits on it (fx's stall) is under probe. `title.rs` needs an arm either way — `grok -p --output-format json -m grok-4.5` in a scratch dir is the cheap-model shape |
| stop | `session/cancel` | A **notification**. Prompt answered `stopReason: cancelled` with the permission request still outstanding; the `tool_call`/`tool_call_update` for the cancelled call arrived *after* the response. A `session/cancel` then reaches Dray's `TurnCompleted` before the last rows — the mapper must not close the call list on the response |
| resume | `session/resume`, `session/load` | Both work. `resume` replays nothing and answers `configOptions` (effort/model as left); `load` replays `user_message_chunk`/`tool_call`/… (unneeded, Dray's log is the replay). `session/list` works and returns `{sessions[{sessionId, cwd, title, updatedAt}]}` |
| slash commands | `available_commands_update` | **Real and populated**: grok's built-ins (`compact`, `always-approve on\|off`, `context`, `hooks-*`, `plugins`, `session-info`, `feedback`, `deep-research`, `workflow`, `goal`, `loop`) plus every skill it discovered — including the reader's `~/.claude/skills` (`caveman`, `dray`, `ponytail`…). `/caveman-help` sent as prompt text ran the skill. So the picker comes off the wire and the send path is prompt text, Claude Code's own shape |
| commands to withhold | — | `always-approve`, `compact`, `context`, `session-info`, `feedback`, `plugins`, `hooks-*`, `loop`, `goal`, `workflow`, `deep-research` — TUI actions or things Dray owns or cannot reconcile. Same reading as Claude Code's `clear`/`model`/`rename` |
| leader | `--leader`, `~/.grok/leader.sock` | Off by default (`leader_mode: false` in the settings cache). Pass `--no-leader` regardless |
| headless side channel | `_x.ai/*` | `_x.ai/session/setup {phase}` (auth → resolve_workspace → folder_trust → plugin_registry → mcp_merge → persistence_init → spawn_session_actor → model_switch), `_x.ai/sessions/changed {upserted[{sessionId, title, cwd, isWorktree, modelId, reasoningEffort, yolo, activity: working\|idle, resident}]}`, `_x.ai/queue/changed {entries, runningPromptId}`, `_x.ai/models/update`, `_x.ai/settings/update`, `_x.ai/announcements/update`, `_x.ai/mcp/server_status`, `_x.ai/session_notification {update:{sessionUpdate: hook_run_started \| hook_execution \| tool_call_delta_chunk \| model_changed \| response_completed \| turn_completed \| background_tasks \| pending_interaction \| interaction_resolved \| session_summary_generated}}`. All modelled-and-dropped, or the failure log fills |
| hooks | `~/.grok/hooks/*.json`, `.grok/hooks`, `.claude/settings.json` | Run over ACP too: `hook_execution {event_name, runs[{name, status{status, elapsed_ms}}]}` fired the reader's `session_start`/`user_prompt_submit` hooks from `~/.grok/hooks`. Nothing to draw |
| bad cwd | — | not probed |
| where sessions live | `~/.grok/sessions/<url-encoded cwd>/<id>/` | `updates.jsonl` is grok's own ACP log, `summary.json` the index entry. Every ACP session is persisted, prompted or not — an `initialize`-only probe is under test for whether it writes one |

## MCP, and why it is not fx's problem

Measured 2026-09-22 against a real OAuth server (`https://mcp.linear.app/mcp`),
consent granted by the reader in the browser mid-probe.

- **Grok owns the config; Dray hands over nothing.** `mcpServers: []` on
  `session/new` and grok merges its own `~/.grok/config.toml`, the project's
  `.grok/config.toml`, **and** Claude's (`~/.claude.json`, `.mcp.json`) and
  Cursor's (`~/.cursor/mcp.json`) servers through its compat scanners
  (`[compat.claude] mcps`). Six of the reader's servers came up on every
  session, five stdio and one HTTP, with no Dray involvement. The one failure
  was a local SSE server not running, not auth.
- **OAuth is grok's, and it works over ACP.** An OAuth-backed HTTP server first
  reports `_x.ai/mcp/server_status {status: unavailable, reason: handshake_failed,
  detail: "… Auth required …"}` and `_x.ai/mcp/list` marks it
  `session.authRequired: true`. Grok then runs the OAuth flow itself — its own
  client registration against the server's `.well-known/oauth-protected-resource`,
  a loopback `127.0.0.1:<port>` redirect, the reader's browser — and on consent
  the same process reports `{status: ready, reason: initialized}` and the
  server's 66 tools register mid-session. Tokens land in
  `~/.grok/mcp_credentials.json` at `0600`, keyed `<name>:<url>`, and **a fresh
  process connects from them with no browser** (`retry_auth_required: tokens
  found on disk` is the binary's own log line for it). This is the exact place
  fx refused to lend its store to an ACP-supplied server; grok has one store for
  TUI and ACP alike.
- **What starts the flow is `_x.ai/mcp/auth_trigger`, and its reply lies.**
  Every param spelling tried (`session_id`/`server_name`, camelCase, both) was
  answered `-32602 missing field session_id`, yet the browser opened in both
  runs that called it and never in the 180s run that did not. Read as: the
  request is dispatched before the reply is shaped. The real field names are
  `McpAuthTriggerRequest`'s and still unread; confirm on a clean credential
  store before building an Authorize button on it. Nothing starts the flow on
  its own — a server left `authRequired` stays that way for the session.
- **The callback listener lives in the grok process**, so a Dray that kills or
  respawns the child while the consent page is up leaves the reader on
  "127.0.0.1 refused to connect" — measured, on the first attempt. A stance
  respawn must not run while an auth is in flight.
- **A bearer header on an ACP-supplied server is the other route**
  (`mcpServers: [{name, type: http, url, headers: [{name: Authorization, value:
  "Bearer …"}]}]`), fx's `bearer_token_env` shape; not exercised, since OAuth
  answered.
- **Folder trust gates more than MCP, and ACP has no prompt for it.** An
  untrusted folder skips project `.grok/config.toml` servers, project hooks,
  project skills **and the repo's own `CLAUDE.md`/`AGENTS.md`** — `grok inspect`
  in this checkout listed only `~/.claude/Claude.md` until trust was granted.
  The store is `~/.grok/trusted_folders.toml`; the grants are the TUI's
  `--trust` flag (refused on `grok agent`), `/hooks-trust` as prompt text
  (which wants a git worktree root and answers without a model call), or
  **`GROK_FOLDER_TRUST=0` on the child env**, which ungates every surface at
  once — measured: `projectTrusted: true`, the repo's rules file listed, project
  servers started. Trust "covers subdirectories of the same repository" but "a
  nested git checkout is a separate workspace", so a Dray worktree under
  `<project>/.claude/worktrees/<name>` is its own folder and the env var is the
  honest carrier. Claude Code under Dray runs the repo's hooks and MCP with no
  trust prompt either, so this is parity, not an escalation — but it is a
  per-child decision and should say so in `grok.rs`.
- **grok.com's own connectors ride along.** `_x.ai/mcp/list` also returns
  `managed_gateway:*` rows (Automations, with `search_connected_tools` /
  `request_connector_auth`), the cloud-side integrations a grok.com account has
  authorised. A second route to Linear, Gmail and friends that needs no local
  server at all; not probed further.

## Decisions

- **ACP over `grok agent --no-leader stdio`.** `RpcClient`/`Incoming` from `harness/rpc.rs` as fx uses them, `request_detached` for `session/prompt`.
- **Dray picks the session id** (`_meta.sessionId`), so the index id is the resume handle. `thread_id` stays `None`.
- **Model and effort ride the spawn as flags** (`--model`, `--reasoning-effort`) for creation, and `set_config_option` for a running child. `Capabilities { applies_model_in_place: true, applies_effort_in_place: true }` — the second harness after fx to say so.
- **The TUI's four modes map onto three `_meta` keys and one prompt-text command.** Normal → nothing (ask); auto → `autoMode: true`; always-approve → `yoloMode: true`; plan → `/plan` as prompt text (below). `HONOURED.grok = ["manual", "auto", "bypassPermissions"]`, so Dray's default stance lands on grok's auto. **Auto over ACP is a classifier, not bypass, and not a card.** A blocked call fails the *tool* with a sentence to the model and raises nothing at the client — measured `rm -rf ./keep`: `yolo: false`, no `session/request_permission`, tool result "Auto mode blocked this action (rm -rf of non-scratch path ./keep is irreversible deletion and must wait)". So a Dray card never appears under auto and the refusal shows only where the model repeats it; the TUI's "escalate to the user" is a prompt the model writes, not a request Dray can draw. Measured holes in the same run, all executed silently: `rm -rf` of a directory *outside* the cwd, `git push origin main`, `curl -X POST` to the internet. Say so in the stance row rather than mapping auto to `manual` — a reader picking auto on Claude Code gets the same "ask on the risky ones" promise, and grok's reading of risky is narrower. **`_meta.permissionMode`** (Claude's `plan` / `bypassPermissions` / `acceptEdits`) is swallowed: all three raised cards. `applies_permission_in_place: false` — `set_mode` is inert; `/always-approve on` as text works in place but costs a bubble the transcript would have to hide, so a stance change is a respawn.
- **Plan mode is the model's, entered by text and left by a client request.** No ACP toggle exists (`_x.ai/toggle_plan_mode` → "unknown ACP extension method" under every param spelling); `/plan` sent as prompt text switches the session in place ("Plan mode is on", one bubble, a model call). Inside it the only writable file is `~/.grok/sessions/<cwd-encoded>/<id>/plan.md`, a write elsewhere is deferred until approval, and the model calls `exit_plan_mode`, which arrives as **`_x.ai/exit_plan_mode {sessionId, toolCallId, planContent}`** — a client request bracketed by `pending_interaction {kind: plan_approval}`. Reply **`{"outcome":"approved"}`** approves (tool result "Your plan has been approved. You can now start coding."); *every* other shape measured — `decision: approve|approved|reject|abandon`, `executePlan`, `approved: true`, `outcome: abandon`, a JSON-RPC error — reads as "The user wants to revise the plan. Ask the user what changes they would like to make." So the wire has two answers, approve or revise, and abandon is a prompt the reader types. v1: no Plan in the composer (Codex's bargain), but the request is mapped to a two-option `PermissionRequested` (Approve / Revise) so a reader who types `/plan` is not left with a hung turn — an unanswered request blocks the session exactly as an unanswered `can_use_tool` does.
- **Rules ride `session/new._meta.rules`**, one file `harness/grok/system_prompt.md`. Names `~/.claude/skills` (grok reads it) and the `dray` CLI. Nothing on the prompt, nothing to strip.
- **`Bash(dray *)` consent has no injection route, and v1 accepts the card.** Measured: `_meta` keys (`permissionRules`, `allow`, `allowedTools`) are swallowed; `GROK_CONFIG` / `GROK_CONFIG_PATH` drop the `[permission]` table by design (the overlay allowlist is `models`, `features`, a narrowed `toolset`, `shell_environment_policy`); `--plugin-dir` carries no permissions; `grok agent --allow` is refused. What works is a **file in the reader's repo** — `.grok/config.toml` `[permission] allow = ["Bash(dray *)"]` or Claude's own `.claude/settings.local.json` `{"permissions":{"allow":["Bash(dray *)"]}}` — *and* `GROK_FOLDER_TRUST=0`, *and* the model not chaining (`allow` is conjunctive across `;`/`&&` segments, so `dray send …; echo $?` still asks). Read once at session start, so written before spawn. Rule syntax is a prefix with no word boundary: `Bash(dray *)`, never `Bash(dray)`, which matches `drayctl`. The cheap upgrade is a user-level `[permission] allow` in `~/.grok/config.toml`, always trusted and repo-free, at the two-writer cost `~/.fx/settings.json` already documents — `grok mcp add` rewrites that file. Under `bypassPermissions` there is no card, and that is what a spawned child runs on.
- **Models come off `initialize._meta.modelState`** — a throwaway spawn answering in under half a second with ladders and context windows per model, and `_x.ai/models/update` mid-session says when the list moves. `models.rs` keeps a four-row fallback table for the picker on a machine where the probe fails. `secondary` folds 4.5 and 4.6; top level is 4.7 and 4.7 Fast.
- **Fast mode is a model** (`grok-4.7-build-fast`, "2x the price"), the Vercel-gateway shape: `supports_fast` from a `-build-fast` twin, `FastMode::OnSpawn` if the switch is drawn as a model swap, or simply list it as a model and say `Unsupported`. **Simplest: list it, `Unsupported`.** The twin rule in `fastMode.ts` already knows how to hide a `-fast` id if the switch is wanted later.
- **Context ring from the prompt response's `_meta.totalTokens`** over the model's `totalContextTokens`, folded onto `TurnCompleted.usage.contextWindow` as fx does. **Except after `/compact`**: the compacting turn's reply reads `totalTokens: 0` while `inputTokens` beside it reads the real figure, so a ring reading it blindly snaps to empty. Read `0` as "keep the last reading" and take the next turn's. Compaction is one event, `_x.ai/session_notification auto_compact_completed {tokens_before, tokens_after, summary_preview}` — no start, no boundary — mapped to `ContextCompacted { post_tokens: tokens_after }`. `turn_completed.usage.costUsdTicks` is 10¹⁰ ticks per USD if cost is ever drawn.
- **`ask_user_question` → `QuestionsAsked`**, the card Claude Code's `AskUserQuestion` already draws, keyed on `_meta["x.ai/tool"].kind == "ask_user"`. The reply is an internally tagged enum on `outcome`: `{"outcome":"accepted","answers":{"<question text verbatim>":"tea"},"partial_answers":false}` — a **map** keyed by the question's text exactly as Claude Code's rule, value a string for single-select or an **array** for multi-select (not Claude's comma-joined string), `partial_answers` optional, an unanswered question omitted. `{"outcome":"skip_interview"}` and `{"outcome":"chat_about_this"}` are the other two arms and both complete the tool. A wrong shape or a JSON-RPC error fails the tool and **the turn carries on** (`Client returned an invalid response to user question: missing field \`outcome\``), so a Dray that cannot draw the card may refuse the request rather than hang. Grok's own timeout is 1800s (`[toolset.ask_user_question] timeout_secs`). **`Reply::Rpc(id)`** as for fx's permissions.
- **Diffs off `tool_call_update.content[type=diff]`**, falling back to `rawInput`'s Claude-named pair. `write` → `ToolType::FileWrite {file_path, content}`, `search_replace` → `FileEdit {file_path, old_string, new_string}`, `run_terminal_command` → `Bash {command, description}` with `exit_code`/`duration` from `rawOutput`. `read_file` → `FileRead`. `_meta["x.ai/tool"].name` is the key, never `title`, which is a display string that changes between the call and its first update.
- **Fork is one eager call and can ship in v1 if wanted.** `_x.ai/session/fork {sourceSessionId, sourceCwd, newCwd, newSessionId?, newModelId?}` — three required strings, Dray's own UUID honoured as `newSessionId` — answers `{newSessionId, parentSessionId, chatMessagesCopied, updatesCopied, planStateCopied, newCwd}` and the copy is made **inside the call** (pi's shape, not Claude Code's lazy `fork_from`): a fresh process `session/load`ed on the fork recalled the parent's turn. No worktree flag on it — `worktree`, `useWorktree`, `sessionKind` are swallowed with no error — so a fork-in-worktree is Dray's tree plus this call with `newCwd` pointing at it. Needs a live or throwaway child to make the call. `forkable: true, fork_needs_cli: false`, or defer; the shape is settled either way.
- **Worktrees are Dray's** (`creates_own_worktree: false`), the Codex/pi route. `grok -w` and `x.ai/git/worktree/*` exist but the TUI's `-w` defaults to the checked-out HEAD via Grove copies under `~/.grok/worktrees`, a different tree layout to Dray's.
- **Images: none** (`image: false`). `accepts_images: false` on every row.
- **Titles: the wire's, free.** Measured 0.22–0.24s from last token to the `session/prompt` reply, with `session_info_update {title}` landing out of band mid-turn — fx's stall is absent. So `session_info_update` → `session_title` and `title.rs` needs no grok arm. Grok regenerates the title "at a couple of early turns and then freezes it", so later updates are ordinary.
- **Accounts row**: no `grok auth status`, but `initialize` answers it: `authMethods` holding `cached_token` means signed in, its absence means `session/new` will refuse (`-32000 Authentication required`, `data: "no auth method id provided"`, nothing on stderr). Identity comes from `~/.grok/auth.json` (0600, ours): one key per issuer holding `email`, `first_name`, `auth_mode` (`oidc`), `expires_at`, `team_id`. An absent file with `XAI_API_KEY` set is the API-key state; absent both is signed out. Sign-in commands: `grok login` (browser), `grok login --device-auth`; sign-out `grok logout`. **Never call `authenticate {methodId: "grok.com"}` as a probe** — on a machine already signed in it minted a fresh credential with no browser and no prompt, into whatever `GROK_HOME` the child had; `GROK_HOME` isolates sessions and config, not auth.
- **Analytics `session_started` harness tag**: `grok`.

## Mapping

| ACP | `AgentEventPayload` |
|---|---|
| `session/prompt` written | `TurnStarted`, `ModelRequestStarted` |
| `agent_message_chunk` | `Delta::BlockStart` on first chunk after a non-text update, `TextDelta`; `BlockStop` + `AssistantMessage` on the next non-text update or turn end (no `messageId` — same one-block-per-run reading fx's thoughts take) |
| `agent_thought_chunk` | `Reasoning` |
| `tool_call` | `ToolCallStarted { call_id: toolCallId, name: _meta["x.ai/tool"].name, tool_type from .kind, input: rawInput }` |
| `tool_call_update` with `title` and no `status` | retitle the pending call (the human title lands here) |
| `tool_call_update status: in_progress` | accumulate `content` text; shell `rawOutput.output_for_prompt` |
| `tool_call_update status: completed \| failed` | `ToolCallCompleted { text, is_error, exit_code: rawOutput.exit_code, diff: content[type=diff] }` |
| `session/request_permission` | `PermissionRequested` with the four options carried whole; reply `{outcome:{outcome: selected, optionId}}` |
| `_x.ai/ask_user_question` | `QuestionsAsked`; reply per probe 1 |
| `_x.ai/exit_plan_mode` | `PermissionRequested` with two options, Approve / Revise, `planContent` as the card's body; Approve replies `{"outcome":"approved"}`, Revise replies anything else (an empty object). Must be answered, or the turn hangs like an unanswered `can_use_tool` |
| `session_info_update` | `session_title` side channel — grok's title is free, see Decisions |
| `config_option_update` | `models_changed` if the ladder moved; else dropped |
| `available_commands_update` | slash picker list (cached per session, not per directory — no throwaway child needed) |
| prompt response | `TurnCompleted { status: Success (end_turn, cancelled) \| Error (refusal, max_tokens, max_turn_requests), usage.contextWindow from _meta.totalTokens }` — and on `cancelled`, abandon every open call: a cancelled foreground tool gets **no terminal `tool_call_update`** (last word `in_progress`, with a meaningless `exit_code: 0` on it) |
| `_x.ai/task_backgrounded` / `_x.ai/session_notification background_tasks {tasks[{task_id, command, kind, status, pid?, output_file}]}` | `BackgroundTasksChanged`; `task_id` ≠ `tool_call_id`, and `BackgroundTaskStarted.pid` in the spawning call's `rawOutput` is the kill handle |
| `_x.ai/session_notification subagent_spawned {subagent_id, child_session_id, subagent_type, description, model}` / `subagent_progress {tokens_used, context_usage_pct, tools_used}` / `subagent_finished {status, output, duration_ms}` | `SubagentStarted` / `SubagentCompleted` with `output` as the report — the panel needs nothing from the child's own stream |
| `session/update` whose `params.sessionId` is not this session | **dropped** — a subagent's whole transcript rides the parent's pipe under the child's id (113 updates in one capture), and it is never announced in `_x.ai/sessions/changed` |
| `_x.ai/session_notification auto_compact_completed {tokens_before, tokens_after}` | `ContextCompacted` |
| `_x.ai/*`, `hook_*`, `tool_call_delta_chunk`, `response_completed`, `turn_completed`, `pending_interaction`, `interaction_resolved`, `session_summary_generated`, `background_tasks`, `model_changed` | modelled, mapped to `None` |

## Layout

```
harness/grok/
  grok.rs          spawn, handshake, session/new|resume, read loop, cancel, in-place setters
  parser.rs        session/update + request_permission + ask_user_question → typed GrokEvent
  mapper.rs        GrokEvent → AgentEvent
  permissions.rs   four options → card
  models.rs        initialize-only probe → Vec<Model>, ProbeCache; four-row fallback
  system_prompt.md rules, sent as session/new._meta.rules
  fixtures/        captures under a scratch GROK_HOME + README
```

`Harness::Grok`, wire name `grok`, in `ALL`, `Capabilities`, `wire_name`,
`label`, `install_command`, `install_docs`; `binpath::grok()`; `title.rs`
arm; `accounts.rs` row; `analytics` tag. Frontend: `Harness` union
(generated), `AGENT_LABELS`, `AgentIcon`, `HARNESS_ORDER`, `DEFAULT_MODEL_FOR`,
`HONOURED.grok = ["manual", "auto", "bypassPermissions"]`, `TOOL_VERBS` for
`write`/`search_replace`/`run_terminal_command`/`read_file`/`todo_write`/
`spawn_subagent`.

## Known costs, stated

- A stance change is a respawn, where model and effort move in place.
- No injectable allow rule on the ACP surface, so `dray` raises a card under `manual` unless a rule file sits in the repo or the user config.
- `auto` raises no card at all: a blocked call is a failed tool with a sentence to the model, and outside-cwd `rm -rf`, `git push` and a `curl` POST are not blocked. The stance row has to say that.
- Plan mode has no client toggle, so it stays off the composer; a reader's typed `/plan` still works and its approval card is drawn.
- Every `session/update` must be filtered on `params.sessionId`, or a subagent's transcript lands in the parent's chat.
- A backgrounded task outlives cancel and the process; settle reaps by pid.
- Every ACP session grok opens is persisted under `~/.grok/sessions`, prompted or not.
- Grok runs the reader's `~/.grok`, `.claude` and `.cursor` hooks and MCP servers under Dray — the same machine state the TUI sees, which is the right way round but means a broken MCP server in the reader's Claude config costs grok's startup grace too (measured 5s for six servers).
- Auto-update: pass `GROK_DISABLE_AUTOUPDATER=1` or `--no-auto-update` is TUI-only; the env var is the one that reaches `grok agent`.
- `tool_call.title` is the *tool name* on the opening update and a sentence on the next; anything reading `title` for the row draws the wrong thing for a frame.

## Settled by the second probe

Twelve more probes ran in a Dray session on Opus (2026-09-22; full write-up
with captured lines at `/tmp/grok-probe/FINDINGS.md`, raw logs under
`/tmp/grok-probe/logs/`). What they added, beyond the decisions above:

- **Filter every `session/update` on `params.sessionId`.** A `spawn_subagent`
  child streams its whole transcript on the parent's pipe under its own
  session id — thoughts, tool calls, `user_message_chunk`, the lot. The rule
  is stated in the mapping table because forgetting it paints the child into
  the parent's chat.
- **Two notification streams, same envelope.** ACP kinds on `session/update`;
  grok's own on `_x.ai/session_notification {sessionId, update:{sessionUpdate}}`.
  A reader on the first alone never sees `subagent_*`, `background_tasks`,
  `turn_completed`, `pending_interaction` or `auto_compact_completed`.
- **A backgrounded task outlives `session/cancel` and the agent process.**
  `sleep 300` survived both; a *foreground* tool process is killed by cancel.
  So settle must reap the tree as it does for Claude Code — and grok hands the
  `pid` over on `BackgroundTaskStarted`, which Claude never does.
- **Environment reaches the shell; `PATH` is merged, not replaced.** Every
  inherited entry survives, but grok prepends `~/.grok/bin` and the login
  shell's `PATH`, so a directory Dray injects lands mid-list (27th of 39) and
  cannot shadow a binary the login shell already resolves. `agent_path`'s
  append-not-prepend rule holds by construction here.
- **The effort ladder is closed at four**: `low medium high xhigh`,
  case-sensitive, bare string only. `minimal` (which the agent-mode doc names)
  and `ultra` answer `unknown reasoning_effort value` without listing the legal
  set; the docs' `{value: …}` object form is refused
  (`did not match any variant of untagged enum SessionConfigOptionValue`).
- **An `initialize`-only spawn writes nothing under `~/.grok/sessions`** and
  answers in 0.23s — the picker probe is free. `grok models` (plain text) lists
  the same four.
- **Folder trust is never asked for over stdio.** `x.ai/folder_trust/request`
  and a `folder_trust_prompt.rs` exist in the binary, but no run ever sent the
  client a request; the folder is silently untrusted. `GROK_FOLDER_TRUST=0`
  (or `false`) is the lever; `=1` does nothing. The binary also notes the
  grant is "process-local only and will not survive restart", which suits a
  per-child env var exactly.
- **`session/new` answers `modes: null`**, so there is no ACP surface to read
  the stance back from — the index entry is the only record, the same bargain
  `ApprovalPolicy` already makes for Claude Code's `default`.
- **A cancelled turn's `_x.ai/session/prompt_complete` carries
  `cancellationCategory: "MidTurnAbort"`** beside `stopReason: cancelled`.

## Settled by the third probe

Modes, run here after the reader pointed out the TUI has four
(`mode_probe.py`, `plan_probe*.py`, `plan_reply_probe.py`; logs beside them).

- **Auto is real and Dray never sees it.** The classifier answers the model,
  not the client: a blocked call is a failed tool carrying its reason, no
  request reaches stdio, and the transcript shows the refusal only where the
  model repeats it. The first probe's "auto allows everything" was a benign
  command set; against the docs' own dangerous list it blocked the in-cwd
  `rm -rf` and let outside-cwd `rm -rf`, `git push` and a POST through.
- **`_meta.permissionMode` is decoration.** Claude's enum on `session/new`
  changed nothing for `plan`, `bypassPermissions` or `acceptEdits`.
- **Plan mode is model-driven.** `/plan` as text enters it (nothing else
  does); `exit_plan_mode` surfaces as `_x.ai/exit_plan_mode` and only
  `{"outcome":"approved"}` approves — seven other spellings and an error all
  read as revise, so the card is two buttons, and abandon is the reader's
  next prompt. A write asked for inside plan mode is held until approval,
  then made; the `made.txt` probe ran end to end on the approve reply.
