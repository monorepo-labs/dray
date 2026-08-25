---
name: dray
description: Create and list Dray sessions from the command line. Use when the user asks to work on several things at once — a batch of issues, tickets, or tasks — and each deserves its own agent, its own branch, and its own place in the sidebar. Also for checking what other sessions are running.
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
| `--no-worktree` | Run in the project directory instead of an isolated worktree. |
| `--worktree-name <name>` | Name the worktree instead of letting Dray generate one. |
| `--model <alias>` | `opus`, `sonnet`, `fable`, `haiku`. Defaults to the current session's model. |

### Each session gets its own worktree

By default every session runs in its own git worktree on its own branch. This is
what makes running them at once safe — without it, three agents write to one
checkout and overwrite each other.

Two consequences worth knowing:

- The worktree branches from `origin/<default>`, **not** from the branch you are
  on. If your work is on a feature branch and is not pushed, the new session will
  not have it.
- `--no-worktree` puts a session in the shared checkout. Only reasonable when
  nothing else is running, or for work that touches no files.

## Listing sessions

```bash
dray ls              # this project, human-readable
dray ls --json       # machine-readable
dray ls --all        # every project
```

Each row carries the session id, title, status (`idle`, `in_progress`,
`completed`), and branch. This is how you check on sessions you started — nothing
reports back on its own, so poll `dray ls` if you need to know when one finishes.

## Reporting back

After creating sessions, tell the user plainly what is now running and where to
look. Name the work, not the session ids — the ids are for you, the sidebar is
for them.

Don't poll in a loop waiting for them to finish unless the user asked you to. They
can watch the sidebar.

## Limits

- **Create and list only.** You cannot send a follow-up message into a session you
  created, and you cannot read its transcript. The user drives it from there.
- **Two levels deep.** A session you create may create sessions of its own; those
  may not. If you hit this, say so — the user can start the next batch from a
  top-level session.
- **Dray must be running.** If it is not, `dray` says so and exits non-zero.
