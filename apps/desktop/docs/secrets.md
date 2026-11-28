# Secrets

**An agent asks for a token or password with `dray secret request`, and the value never enters chat** (#1578). Modelled on T3 Code's `request_secret` (pingdotgg/t3code#15907, #24809), file delivery only.

- `dray secret request NAME --reason … [--label …] [--url …]` logs `secret_requested` in the calling session and answers at once. The agent is told to end its turn. Its card is open until a `secret_answered` with the same `request_id` closes it.
- The card ([SecretRequest.tsx](../src/components/chat/SecretRequest.tsx)) draws from `buildTranscript`'s `pendingAsks`, so it shows in the chat, a bot chat and the crew column alike. Masked text rather than a password field, autofill attributes off, so no password manager saves or fills it. The URL opens in the system browser, never the session's: the agent can drive that one.
- `answer_secret_request` (serve wire only) takes the value to the session's own server, which writes it to `<home>/secrets/once/NAME-<id>` or, with Save to Vault, `<home>/secrets/saved/NAME`: `0600` files in `0700` dirs, created with the mode, then renamed over. The agent learns the path in a hidden prompt (`send_review`) and reads it with `NAME="$(cat <path>)"` inside its own command, so its sandbox and approvals still apply.
- **This keeps a secret out of chat; it does not hide it from the agent**, which can read the file. The card says so.
- One-time files are swept a day after they are written, at start and hourly. Saved ones stay until Settings → Vault deletes them, and reach a task only through `request` (below). `dray secret path NAME` answers for an always-allowed name alone: answering for any saved one let an agent skip the card the user had not waived. `SecretPath` and `ListSecrets` are `this_machine_only`: a path is this machine's.

## Saved, and used without asking

- **A name already saved here** puts `saved` on the card, which then offers Use saved NAME in one click above the paste field. The agent gets the saved file's path in the same hidden prompt.
- **Let agents use it without asking** (on the card beside Save to Vault, and per row in Settings → Vault) puts the name in `<home>/secrets/always.json`. It implies Save to Vault, since only a kept secret can be handed over later. A later `dray secret request NAME` then posts no card: it logs `secret_answered` with `auto` (drawn as "Used saved NAME without asking") and answers the CLI with the path, so the agent carries on in the same turn. Deleting the secret drops it from the list.

## Offering a saved one

- The card carries `saved_names` (every name saved on the machine that answers) and `closest`: the name asked for where saved, else the one picked for it before (`aliases.json`, names alone), else the nearest by words (`closest_name`: GH reads as GITHUB, and two names must share a word that is not TOKEN, KEY, API and the like). It opens on Use saved CLOSEST, with a ⌄ for any other saved one and Paste a new one beside it; pasting has a Use saved back button.
- The ⌄ opens a dialog on the desktop ([SecretPicker.tsx](../src/components/chat/SecretPicker.tsx)) and a bottom sheet on Android, never a dropdown, which stopped reading at ten names. Picking a name only makes it the card's Use saved. Past `SECRET_SEARCH_AFTER` (6) saved names it opens with a search, every word matched in the name with `_` read as a space; [secretPicker.ts](../src/lib/secretPicker.ts) and Android's `model/Secrets.kt` say it twice, and iOS keeps the same number.
- Using a saved one under another name answers with `from` and records the alias, so the next request for that name offers, or with Auto hands over, the same one. The agent always gets it under the name it asked for. Auto (the switch the reader sees; `always` on the wire) belongs to the saved secret used.
- Prompts and the skill tell agents to run `dray secret ls` and ask by a saved name where one fits. A bot's task on another machine lists its own machine's names there, not the bot's; the card's nearest match covers that.
- The card names who is asking only when it sits in someone else's chat: a bot's chat showing its task's ask gets the task's chip above the title, with the server mark for a task elsewhere. In its own chat the chat is the asker, so there is no chip and Decline sits beside the title. The card is Yogesh's own design (18px corners, the permission card's fill and ring, a Share button with a shield-check, a solid key before the title, Decline an × at the top right, switches "Save to Vault" and "Let agents use it without asking you"); Settings calls the second Auto. While pasting, a muted line under the card (`lifeLine`) says the value is kept out of chat and logs — no stronger, since the agent can read the file and print it — and how long it lives, following the switches: deleted in 24 hours, saved on this machine, or for a relayed task 24 hours on its machine. Use saved draws none. Change it with the server's rules, not apart from them. The lines a closed card leaves are "Started a new task"'s size, open on the same solid key, and use its `PartyChip`.
- Settings → Vault shows one machine at a time, picked at the top, each row with Auto and a ⋯ for Replace and Delete. [secrets.html](../demo/secrets.html) mounts all of it.

## A bot's tasks use the bot's machine

A task the user started keeps its own machine's secrets. **A task in a bot's tree on another machine uses the bot's machine's** (`bot_root`: it, or a task above it on that machine, is `remote_reports::owed`), so one bot holds one vault for every machine it runs work on.

- The task still runs `dray secret request`. Its server posts no card: it logs `secret_requested` with `bot`, drawn in the task's chat as "Asked for NAME in the bot's chat", and keeps it in `pending.json`, left out of `live_state` and the asking flags.
- The bot's server collects those asks with the task's reports (`parent_reports` answers `secrets`, every 10s) and checks its own vault. A name agents may use without asking goes straight back; anything else draws the card in the bot's chat, carrying `task` (title, machine, and the task's request id).
- The answer goes back with `secret_deliver` over `machines::call_private`, which refuses a plain `ws://` address off the host: SSH forwards and `wss://` only. The task's server writes the usual one-time `0600` file and tells the task its path. Save to Vault and the switch keep the value on the bot's machine, never the task's.
- Each delivery is a line in the bot's chat, "Sent GH_TOKEN to <task>", never the value. Like every secret line, it sits outside the folded tool-call group (`turn.cards`).
- One switch covers both: a name agents may use without asking on the bot's machine reaches that bot's tasks on any machine with no card.

## Why logged, unlike a permission card

A permission card is answered to the child that asked, so it dies with the child and is never persisted. A secret's answer goes to a file and a fresh prompt, so the card outlives the turn, the child and a restart. `pending.json` beside the files holds every open card's event (never a value): `answer_secret_request` checks it, `live_state` carries it as `secrets`, and the stall judge counts it as asking. A client keeps those ids in `secretAsks`, apart from `asksBySession`, since a turn ending or a task set draining strands permission asks and must not strand these. Settle and delete drop a session's cards.

Asking again for a name whose card is still open in that session closes the old one as `replaced`, which draws no row.

## Masking is a safety net

`secrets::mask` blanks any value saved here (6 characters or more) out of each event before it is emitted and before it is logged, matching the raw and the JSON-escaped form. A value split across deltas, encoded or reformatted gets through, and the model has already seen whatever a command printed. Nothing relies on it.

## Phones

**Android draws the card and Settings › Vault** (#1604, [SecretCard.kt](../../android/app/src/main/java/com/yogesh/dray/ui/SecretCard.kt), [SecretsSettings.kt](../../android/app/src/main/java/com/yogesh/dray/ui/SecretsSettings.kt)). The card sits in `Store.asks` beside permission cards but survives `strand`, since a turn ending must not drop it; `live_state`'s `secrets` refills it. Its lines sit outside the folds. The phone hides Dray's own kickoff prompt as the desktop does, or the answer's hidden prompt drew as a bubble.

**iOS draws them too** (#1605, [Secrets.swift](../../ios/Dray/Secrets.swift), [PLAN.md](../../ios/PLAN.md)). Its cards sit in `Store.secretAsks`, apart from `asks`, since Dray Island shares that store and has no card for them; the rest follows Android.

## Not yet

1Password `op://` references.
