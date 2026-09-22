# grok fixtures

Real `grok agent --no-leader stdio` traffic, captured against **Grok Build
1.0.40** (2026-09-22). `>> ` is a line Dray wrote, `<< ` one grok wrote.

Captured under a scratch working directory, never inside this repo, and never
with `authenticate` sent — that method mints a real credential silently.

## Filtered on a whitelist, never a blacklist

A raw capture is not committable: grok echoes the reader's MCP server list, its
connection strings, their environment, their hook names and their personal skill
directory, and a plan-mode run quoted a chunk of the reader's own global
`CLAUDE.md` back at them. So a line survives only where its `method` — and, for
the two notification channels, its `sessionUpdate` — is one the mapper actually
reads. `/tmp/grok-probe/make_fixtures.py` holds the rule; home paths are
rewritten to `/Users/dev`.

The `initialize` reply is **deliberately absent** from every `.jsonl`: its
`_meta` carries the machine's hostname, its agent ids, its working directory and
that MCP list. What the picker reads out of it lives in `handshake.json`,
trimmed to the model state alone.

Adding a fixture means adding to that whitelist and re-reading the result, not
capturing a session and committing it.

## What each one is for

| file | what it pins |
|---|---|
| `handshake.json` | `initialize`'s `_meta.modelState` — the model list and each model's own effort ladder. Trimmed; see above. |
| `live_turn.jsonl` | The smallest whole turn: two calls, both channels, and the only captured **finished shell result**, which is what keeps `RawOutput`'s snake case honest. |
| `cancel.jsonl` | Stop. The killed call gets **no terminal update at all** — and a sibling already running still lands its result, which is why "a cancelled turn answers nothing" is the wrong reading. |
| `ask_user.jsonl` | `_x.ai/ask_user_question`, including a single-select question sending `multiSelect: null` rather than omitting it. |
| `subagent.jsonl` | A `spawn_subagent` child streaming its **whole transcript** down the parent's pipe under its own session id. The filter every other fixture takes for granted. |

`_x.ai/exit_plan_mode` has no fixture on purpose: it is a client *request* with a
three-field body, so the hand-written JSON in [permissions.rs](../permissions.rs)
pins it at the level it matters, and the capture it came from was the one
carrying the reader's own files.
