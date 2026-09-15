# fx fixtures

Real `fx acp` stdio, captured **both directions**, one line each: `>> ` is what
Dray's probe wrote, `<< ` is what fx answered. A capture recording only what
fx said would lose half the protocol — a permission request is a request *we
answer*, and the prompt's own response is how a turn ends.

The first four were captured against **fx 0.0.9** (`𝒇x v0.0.9`, build
`e26e97ec4040`) with the Codex subscription as the active provider; the two
effort captures against **fx 0.0.10**, `effort_ladder.jsonl` with the Vercel AI
Gateway — the only provider whose catalog holds models that do no reasoning —
and `effort_carryover.jsonl` with the Codex subscription, whose two-rung spread
between `sol` and `luna` is what makes a carried level visible. All in a scratch
repo under `/tmp`. Home paths are rewritten to `/Users/dev`; nothing else is
edited. Re-capture against a newer fx by driving the same prompts with the probe
scripts named below and naming the new version here.

| file | what it pins |
|---|---|
| `live_turn.jsonl` | The whole lifecycle at its smallest: `initialize`, `session/new` with its `configOptions`, one prompt writing a file and running `wc -c` on it. The shell's stdout streams through `in_progress` updates and its `completed` update carries fx's replay blob as text beside `command_result` — the mapper keeps the stream and drops the blob. Ends with `session_info_update`, `usage_update` and the prompt's `end_turn` response. Also the only capture of the first-turn `skill discovery warning` arriving as assistant text. |
| `permission_request.jsonl` | `session/set_mode ask`, `session/set_config_option effort high`, then a write outside the workspace plus `git init` — the one shape that raised `session/request_permission`. Three options, `allow_once` / `allow_always` / `reject_once`; our `{"outcome":{"outcome":"selected","optionId":"allow_once"}}`; the call then runs. In-workspace writes under `ask` never asked, on any capture. |
| `cancel.jsonl` | A 20-second shell loop, `session/cancel` after 12s. The tool's update comes back `failed` with `signal: 15`, and the prompt answers `stopReason: "cancelled"`. |
| `edit_file.jsonl` | `read_file`, two `edit_file` calls carrying `old_string`/`new_string` in `rawInput` — no ACP `diff` block anywhere — and a `read_file` back. What the diff row draws its sides from. |
| `effort_ladder.jsonl` | fx **0.0.10**, Vercel AI Gateway. One session walked across three models, which is what settles that the effort ladder is per *model* and not per provider (DRA-221). `claude-opus-5` carries an `effort` option stopping at `max`; `set_config_option model grok-4.6` answers a list with **no `effort` option at all**, and an effort set there is refused `-32602` "Reasoning effort **is unavailable** for the active model"; `gpt-5.4-nano` carries one offering `none`, and `ultra` there is refused `-32602` "Reasoning effort **is not available** for the active model" — two sentences for two different refusals, which is why Dray writes its own. Also the only capture of a `set_config_option` reply and of the gateway's 247-model `model` option. Big for the same reason: that list rides all five replies, and a capture edited down is not evidence. |
| `effort_carryover.jsonl` | fx **0.0.10**, Codex subscription — the counterweight to the file above, and the reason Dray does not believe every list it is handed. `session/new` on `gpt-5.6-luna` reports luna's own ladder, stopping at `max`, and `ultra` there is refused. The same session started on `gpt-5.6-sol`, set to `ultra` and then switched onto luna reports luna's options as `… max, ultra` — **the level was carried across the model switch and unioned into the list**, and setting it is still refused. `session/resume` restates the wrong list. So an option list is the model's ladder plus the session's current level, and only a reading sitting on fx's own `auto` can be remembered against a model. Both readings of luna are in this one file. |

Probe scripts: `/tmp/fx_probe.py` (live turn), `/tmp/fx_probe2.py perm|cancel`,
`/tmp/fx_probe3.py edit`. Not committed — they are twenty lines of
`subprocess` each and the captures are the artefact.
