# pi fixtures

Real `pi --mode rpc` stdio, captured **both directions**, one JSON object per
line: `{"dir": "in" | "out" | "err", "t": <ms since spawn>, "line": "<the raw
JSONL line>"}`.

Same wrapper the Codex fixtures use, for the same reason: pi is a peer, not a
pipe. A capture recording only what pi said would lose half the protocol —
an approval is a request *we answer*, and every command's response is the line
the next one depends on. `t` is added here and not there; it is what shows that
a `*_end` delta arrives after two later blocks have already started.

Home paths are rewritten to `/Users/dev`, the probe tree to `/work`, and the
session directory to `/Users/dev/.dray/pi-sessions`. Nothing else is edited.

## Versions, and why there are two

Captured against **`@earendil-works/pi-coding-agent` 0.84.4** unless a row below
says otherwise.

The package rename and the Node floor both matter, because the wrong one of
each gets you a materially different protocol:

- `@mariozechner/pi-coding-agent` is **deprecated** in favour of
  `@earendil-works/pi-coding-agent`. Both still publish.
- npm carries two dist-tags: `latest` is `0.84.4` and `legacy-node20` is
  `0.74.2`. **On Node 22 npm resolves the legacy one.** Node 24 was needed to
  get 0.84.4.
- `agent_settled` — the event a turn boundary has to be read off — landed in
  **0.80.6**. On 0.74.2 it does not exist, and neither do `get_entries` or
  `get_available_thinking_levels`, both of which answer `Unknown command`.
  `commands_and_clone.jsonl` shows all three working on 0.84.4.

So a build that resolves pi by name alone can get a CLI whose turns never end.
See PI-PLAN.md §3.

## What the model was

Six of these ran against a **scripted OpenAI-completions provider**
(`scripts/pi-capture/stub-server.mjs`), not a real model. That is the honest
label and it is worth reading precisely: the pi process, the RPC framing, the
event vocabulary, the tool execution, the extension host and the session file
are all real — only the model's tokens are canned. It buys determinism, every
event type in one capture, and no API key.

Three captures reached the network: `live_turn.jsonl` and `live_models.jsonl`
against a working xAI login, and `failed_turn_live.jsonl` against an expired
one.

**Read the live pair before trusting the stubbed ones on two points.** The stub
was more generous than a real provider in exactly two ways, and both would have
been believed:

- **`usage` on `message_update` is all zeros for the whole stream** on xAI. The
  stub populated it. pi's docs warn that it "may remain zero until completion"
  and that is what a real provider does — which is why the context ring reads
  `get_session_stats` rather than deriving from deltas.
- **`toolcall_delta` fired once per call, carrying the whole argument JSON.**
  The stub split it into twelve-character fragments. So the streaming-preview
  split — header from the stream, body from the committed event — *works*, but
  on this provider it is worth 2ms, not the 39.5s it is worth on Claude Code.
  How much it buys is a property of the provider, not of pi.

| file | pi | model | what it pins |
|---|---|---|---|
| `no_approvals.jsonl` | 0.84.4 | stub | **The answer to "what happens with no extension installed": pi runs the tool.** Four tool calls — `read`, `bash`, `edit`, `write` — and not one `extension_ui_request`. Also the whole streaming vocabulary: `thinking_*`, `text_*` and `toolcall_*` deltas keyed by `contentIndex`, four `turn_start`/`turn_end` pairs inside one `agent_start`…`agent_settled`, and the `toolResult` message echo that has to be dropped. |
| `extension_approvals.jsonl` | 0.84.4 | stub | The only approval route pi has: a `tool_call` extension hook calling `ctx.ui.confirm`. `extension_ui_request{method: "confirm"}` out, `extension_ui_response` in, and a denial landing as `tool_execution_end{isError: true}` carrying the reason. Requests are strictly serialised — `read` is answered before `bash` asks — which matches pi's documented "preflighted sequentially". The capture cannot show otherwise: the driver answers each before the next is asked. Answers for ids already answered are ignored in silence. |
| `abort_and_queue.jsonl` | 0.84.4 | stub | `abort` mid-`bash`, and **the trap**: the aborted turn's assistant message carries `stopReason: "error"` with `errorMessage: "This operation was aborted"` — not the `"aborted"` the docs list. Also `steer`, `follow_up`, `queue_update` and `clear_queue` returning the queued text. |
| `models_and_steering.jsonl` | 0.84.4 | stub | `get_available_models` listing **only providers with resolvable auth** — a third provider with no key is configured and absent. `get_available_thinking_levels` answering per model: five levels for the reasoning one, `["off"]` for the other, which still accepts `set_thinking_level: "max"` with `success: true`. And the mid-turn prompt rule: bare `prompt` refused with a sentence naming the cure, `streamingBehavior: "steer"` accepted. **`abort` with a steer queued delivers the steer anyway.** |
| `resume.jsonl` | 0.84.4 | stub | Resume: a second process spawned with `--session <the same path>` comes back with **the same `sessionId`** and all nine messages. `contextUsage.tokens` (2840) against cumulative `tokens.total` (8960) — the occupancy trap, already answered by name. Also `compaction_start`/`compaction_end` on the failure path, where `result` is absent rather than null. |
| `commands_and_clone.jsonl` | 0.84.4 | stub | Command error shapes (`Unknown command`, `Model not found`), `get_entries`' typed session tree, and **`clone` hijacking the running process**: `get_state` afterwards names a new session id and a file path pi chose, not the one `--session` was given. |
| `fork_flag_refused.jsonl` | 0.84.4 | — | Three lines, and they settle the fork design: `--fork cannot be combined with --session`. pi will not let a client name the path a fork lands at. |
| `session_id_not_adopted.jsonl` | 0.84.4 | — | `--session` pointed at a file named `019a0000-dead-7000-8000-000000000001.jsonl`. pi writes the session there and reports a `sessionId` of its own. The path is a handle Dray can choose; the id is not. Two lines, and PI-PLAN.md §4 rests on them. |
| `live_turn.jsonl` | 0.84.4 | **real** (xai/grok-4.6) | The same scenario as `no_approvals.jsonl` against a real model. Three model calls, a `read` and a `write`. **Zero usage on every `message_update`**, and **one `toolcall_delta` per call** carrying the whole argument object — both differ from the stub, and both matter. Also 41 thinking deltas of real reasoning text, where Claude Code's thinking blocks arrive empty. `contextUsage.tokens` 2139 against cumulative `tokens.total` 6288. |
| `live_models.jsonl` | 0.84.4 | **real** | `get_available_models` on a machine with two providers logged in: 11 models across `openai-codex` and `xai`, context windows from 128k to 1M. It grew from 10 to 11 the moment a second provider was added, which is the whole argument of PI-PLAN.md §7. `gpt-5.3-codex-spark` reports `input: ["text"]` — a real model that takes no images, which is what `accepts_images` is for. |
| `failed_turn_live.jsonl` | 0.74.2 | **real** | A failed turn against a real provider with expired credentials. There is no error *event* in pi: the failure is `stopReason: "error"` plus `errorMessage` on the assistant message, and `agent_end` closes the run normally. The sentence — "No API key for provider: openai-codex" — is the one a row should draw. Also the user-message echo, on the live wire rather than the stub's. |

## Re-capturing

`scripts/pi-capture/` holds the whole harness — the driver, the stub provider,
the probe extension and one scenario file per fixture. Its README says how.

## Not captured

Each of these settles an open question in PI-PLAN.md §11, and guessing at them
is what the captures exist to stop:

- **A second real provider streaming.** `live_turn.jsonl` is xAI. Whether
  Anthropic or OpenAI through pi fragment tool arguments, or report usage
  mid-stream, is one capture each and neither changes a mapping — only how much
  the streaming preview buys.
- **A custom tool from an extension.** Every tool in these captures is a
  built-in. PI-PLAN.md §6 gates `Auto` on an allowlist precisely because an
  extension can register a mutating tool under any name, and nothing here shows
  such a call reaching `tool_call` under the name it registered. Wanted before
  slice 2.
- **Two approval requests open at once.** The driver answers each before the
  next is asked, so this capture could not show overlap whether or not pi
  allows it. pi's docs say preflight is sequential, which suggests it does not.
- **A subagent.** pi has none built in; one arrives only through an extension,
  so there is nothing to capture until an extension is chosen.
- **Auto-compaction, and an auto-retry.** `compaction_end` is captured only on
  its failure path, and `auto_retry_start`/`auto_retry_end` not at all — the
  stub never fails transiently.
- **`fork {entryId}`.** `clone` is captured and hijacks the process; `fork` is
  assumed to do the same because it is the same command family, and that
  assumption is written against the pattern rather than against a line.
- **An unanswered `extension_ui_request`.** `ctx.ui.confirm` has no default
  timeout, so the turn is expected to block forever. Expected, not observed.
