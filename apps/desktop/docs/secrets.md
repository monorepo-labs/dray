# Secrets

**An agent asks for a token or password with `dray secret request`, and the value never enters chat** (#1578). Modelled on T3 Code's `request_secret` (pingdotgg/t3code#15907, #24809), file delivery only.

- `dray secret request NAME --reason … [--label …] [--url …]` logs `secret_requested` in the calling session and answers at once. The agent is told to end its turn. Its card is open until a `secret_answered` with the same `request_id` closes it.
- The card ([SecretRequest.tsx](../src/components/chat/SecretRequest.tsx)) draws from `buildTranscript`'s `pendingAsks`, so it shows in the chat, a bot chat and the crew column alike. Masked text rather than a password field, autofill attributes off, so no password manager saves or fills it. The URL opens in the system browser, never the session's: the agent can drive that one.
- `answer_secret_request` (serve wire only) takes the value to the session's own server, which writes it to `<home>/secrets/once/NAME-<id>` or, with Save as, `<home>/secrets/saved/NAME`: `0600` files in `0700` dirs, created with the mode, then renamed over. The agent learns the path in a hidden prompt (`send_review`) and reads it with `NAME="$(cat <path>)"` inside its own command, so its sandbox and approvals still apply.
- **This keeps a secret out of chat; it does not hide it from the agent**, which can read the file. The card says so.
- One-time files are swept a day after they are written, at start and hourly. Saved ones stay until Settings → Secrets deletes them, and any task on that machine finds one with `dray secret path NAME`. `SecretPath` and `ListSecrets` are `this_machine_only`: a path is this machine's.

## Why logged, unlike a permission card

A permission card is answered to the child that asked, so it dies with the child and is never persisted. A secret's answer goes to a file and a fresh prompt, so the card outlives the turn, the child and a restart. `pending.json` beside the files holds every open card's event (never a value): `answer_secret_request` checks it, `live_state` carries it as `secrets`, and the stall judge counts it as asking. A client keeps those ids in `secretAsks`, apart from `asksBySession`, since a turn ending or a task set draining strands permission asks and must not strand these. Settle and delete drop a session's cards.

Asking again for a name whose card is still open in that session closes the old one as `replaced`, which draws no row.

## Masking is a safety net

`secrets::mask` blanks any value saved here (6 characters or more) out of each event before it is emitted and before it is logged, matching the raw and the JSON-escaped form. A value split across deltas, encoded or reformatted gets through, and the model has already seen whatever a command printed. Nothing relies on it.

## Not yet

Phone cards (iOS, Android) and 1Password `op://` references. The wire is ready for the phones: two logged events and one command with plain arguments.
