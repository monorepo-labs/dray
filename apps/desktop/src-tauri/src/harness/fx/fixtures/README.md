# fx fixtures

Real `fx acp` stdio, captured **both directions**, one line each: `>> ` is what
Dray's probe wrote, `<< ` is what fx answered. A capture recording only what
fx said would lose half the protocol — a permission request is a request *we
answer*, and the prompt's own response is how a turn ends.

Captured against **fx 0.0.9** (`𝒇x v0.0.9`, build `e26e97ec4040`) with the
Codex subscription as the active provider, in a scratch repo under `/tmp`. Home
paths are rewritten to `/Users/dev`; nothing else is edited. Re-capture against
a newer fx by driving the same four prompts with the probe scripts named below
and naming the new version here.

| file | what it pins |
|---|---|
| `live_turn.jsonl` | The whole lifecycle at its smallest: `initialize`, `session/new` with its `configOptions`, one prompt writing a file and running `wc -c` on it. The shell's stdout streams through `in_progress` updates and its `completed` update carries fx's replay blob as text beside `command_result` — the mapper keeps the stream and drops the blob. Ends with `session_info_update`, `usage_update` and the prompt's `end_turn` response. Also the only capture of the first-turn `skill discovery warning` arriving as assistant text. |
| `permission_request.jsonl` | `session/set_mode ask`, `session/set_config_option effort high`, then a write outside the workspace plus `git init` — the one shape that raised `session/request_permission`. Three options, `allow_once` / `allow_always` / `reject_once`; our `{"outcome":{"outcome":"selected","optionId":"allow_once"}}`; the call then runs. In-workspace writes under `ask` never asked, on any capture. |
| `cancel.jsonl` | A 20-second shell loop, `session/cancel` after 12s. The tool's update comes back `failed` with `signal: 15`, and the prompt answers `stopReason: "cancelled"`. |
| `edit_file.jsonl` | `read_file`, two `edit_file` calls carrying `old_string`/`new_string` in `rawInput` — no ACP `diff` block anywhere — and a `read_file` back. What the diff row draws its sides from. |

Probe scripts: `/tmp/fx_probe.py` (live turn), `/tmp/fx_probe2.py perm|cancel`,
`/tmp/fx_probe3.py edit`. Not committed — they are twenty lines of
`subprocess` each and the captures are the artefact.
