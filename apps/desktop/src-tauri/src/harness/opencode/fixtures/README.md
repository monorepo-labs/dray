# OpenCode fixtures

Real `opencode acp` traffic, captured against **OpenCode 1.19.5**
(2026-11-23). `>> ` is a line Dray wrote, `<< ` one OpenCode wrote. Captured
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
| `models_verbose.txt` | Three rows of `opencode models --verbose`: a ladder, a ladder with OpenCode's own `none`, and a model id holding a slash of its own. |
