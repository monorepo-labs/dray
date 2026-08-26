---
name: dray
description: Create, list and message Dray sessions from the command line. Use when the user asks to work on several things at once — a batch of issues, tickets, or tasks — and each deserves its own agent, its own branch, and its own place in the sidebar. Also for checking on sessions you started, and for sending a message or summary between sessions.
---

# Dray sessions

Dray runs coding agents in parallel, one chat per piece of work. The `dray` CLI
creates those sessions from outside the app, so an agent in one session can fan
work out into several.

Every session created this way appears in the user's sidebar immediately. They
can open it, read the transcript, interrupt it, or delete it like any other.

## When to reach for this

The user has **several separate pieces of work** and wants them going at once —
"work through these 3 Linear issues", "fix all four of these bugs", "start a
session for each of these tickets".

Do **not** use it to break one task into steps. Sessions are for work that is
genuinely independent: separate branches, separate PRs. Steps of one job belong
in one session, and subagents already handle parallelism inside a turn.

## Creating a session

```bash
dray new "Fix the login redirect loop described in ENG-412"
```

Prints the new session's id. It returns immediately — the session starts working
on its own, and nothing waits for it.

Write the prompt as if briefing a colleague who has not read this conversation.
The new session starts empty: it inherits no context, no files you have read, and
no decisions made here. Include the issue text, the reproduction, the constraints
— everything it needs.

Options:

| flag | meaning |
|---|---|
| `--project <path>` | Repo to run in. Defaults to the current session's, or the repo you are in. |
| `--model <alias>` | `opus`, `sonnet`, `fable`, `haiku`. Defaults to the current session's model. |
| `--effort <level>` | `low`, `medium`, `high`, `xhigh`, `max`. Defaults to the current session's. |
| `--harness <name>` | `claude_code`. Defaults to the current session's. |

### Each session gets its own worktree

Every session runs in its own git worktree on its own branch, and there is no way
to turn that off. It is what makes running them at once safe — without it, three
agents write to one checkout and overwrite each other.

One consequence worth knowing: the worktree branches from `origin/<default>`,
**not** from the branch you are on. If your work is on a feature branch and is
not pushed, the new session will not have it.

## Listing sessions

```bash
dray ls              # this project, human-readable
dray ls --json       # machine-readable
dray ls --all        # every project
```

Each row carries the session id, title, status (`idle`, `in_progress`,
`completed`), and branch. A session created by another one also says which —
`spawned by <id>` in the table, `parentSessionId` in the JSON. This is how you
check on sessions you started — nothing reports back on its own, so poll
`dray ls` if you need to know when one finishes.

## Messaging a session

```bash
dray send <session-id> "Code review is done. Two findings, both fixed."
```

Works in both directions and between any two sessions:

- A session you created can report a summary back to the one that created it.
- You can hand a session you created extra context after it has started.

The message arrives as an ordinary prompt and **starts a turn** in the receiving
session, so it wakes an idle agent up. If that session is mid-turn the message is
queued and picked up at the next boundary — that is reported, and is not a
failure.

The receiving agent is told which session the message came from, and is given its
id — so it can answer with `dray send <that-id>` without looking anything up.
Write it as a message to a colleague, not as a note to yourself.

Send when there is something the other session genuinely needs. A message costs
it a whole turn, so "done" on its own is rarely worth one.

## Reporting back to the user

Say briefly what is now running, in terms of the work — "three sessions, one per
issue". **Do not list session names or ids.** The user sees every session in the
sidebar, nested under this one, and reading ids back is noise they cannot act on.

Don't poll in a loop waiting for sessions to finish unless the user asked you to.
They can watch the sidebar.

## Limits

- **No reading transcripts.** You can create, list and message. You cannot read
  what another session said — ask it to send you a summary instead.
- **Two levels deep.** A session you create may create sessions of its own; those
  may not. If you hit this, say so — the user can start the next batch from a
  top-level session.
- **Dray must be running.** If it is not, `dray` says so and exits non-zero.
