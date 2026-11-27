# OpenCode fixtures

Real `opencode acp` traffic, captured against **OpenCode 1.19.5**, and 1.19.6
for the two marked so (2026-11-23). `>> ` is a line Dray wrote, `<< ` one OpenCode wrote. Captured
in a scratch repo, never inside this one, with `OPENCODE_PERMISSION` set to
`{"edit":"ask","bash":"ask"}` so the permission cards were raised.

## Filtered on a whitelist

A raw capture is not committable: `available_commands_update` lists every
skill on the reader's machine, the model option lists every provider they have
configured, and the mode option lists their own agents. So a line survives only
where its method, and for `session/update` its `sessionUpdate`, is one the
mapper reads; the model option keeps only its current value and the mode option
only `build` and `plan`. Paths are rewritten to `/tmp/opencode-probe`.

## What each one is for

| file | what it pins |
|---|---|
| `live_turn.jsonl` | One turn: `bash`, `read`, `edit`, two permission cards, the unadvertised `fs/write_text_file` OpenCode asks after an edit it already made, `usage_update`, and the reply. Each `tool_call` opens with no arguments; they land on the first `in_progress` update. |
| `cancel.jsonl` | A codeword turn, then `sleep 30` stopped by `session/cancel`: the shell closes `completed` with "User aborted the command", `usage_update` reports `used: 0`, and the prompt answers `cancelled`. A `mode` change sent mid-turn is accepted. |
| `resume.jsonl` | `session/resume` in a fresh process: no replay, model and effort restored, mode back on `build`, and the codeword recalled. Then a resume of an unknown id, refused `-32603`. |
| `auth_error.jsonl` | A prompt refused outright with a JSON-RPC error naming a reset API key. |
| `subagent.jsonl` | A `task` subagent under Dray's real rules (1.19.6): refusing globals in `OPENCODE_PERMISSION`, the asking set handed back to `build` through `OPENCODE_CONFIG_CONTENT`. The parent's `pwd` raises a card; the child, with `bash` refused, lists the folder with `glob` and finishes. No child update reaches the wire; its id and report arrive only on the `task` call's close. |
| `fork.jsonl` | `session/fork` of the codeword session: the parent's history replayed as updates under the copy's id, all ahead of the fork's answer, then the copy recalling the codeword. |
| `models_verbose.txt` | Three rows of `opencode models --verbose`: a ladder, a ladder with OpenCode's own `none`, and a model id holding a slash of its own. |
| `live_turn_v2.jsonl` | **OpenCode 2.4.1**: one turn under `OPENCODE_CONFIG_CONTENT`'s `permission`, with `shell` and `patch` each raising a card. The patch's input is patch text; its file is only in `locations` and its diff only in `rawOutput.metadata.files`. |
| `models_api.json` | **OpenCode 2.4.1**: three rows of `opencode api GET /api/model`, `variants` and `capabilities.input` as lists. |
| `subagent_v2.jsonl` | **OpenCode 2.4.2**: a `subagent` call that answers at once with "working in the background (sessionID: …)", the child's reply as an `agent_message_chunk` on the parent's id tagged `_meta["opencode/child-session"]`, then two parent messages, each its own `messageId`. |
| `question_v2.jsonl` | **OpenCode 2.4.2**, `elicitation.form` advertised: the `question` call, the `elicitation/create` form it raises (`q0`, `q0_custom`), answered `accept` with `{"q0": "Blue"}`, and the call's close naming the answer. |

`src/fixtures/opencode_integrations.json` is OpenCode 2.4.1's `opencode api GET /api/integration` cut to seven providers, credential ids rewritten, for the Accounts tab.
