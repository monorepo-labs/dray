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
| `--model <alias>` | `opus`, `sonnet`, `fable`, `haiku` on Claude Code; a `provider/model` id on pi. Defaults to the current session's model — see *Model and effort*. |
| `--effort <level>` | `low`, `medium`, `high`, `xhigh`, `max`. Defaults to the current session's — see *Model and effort*. |
| `--harness <name>` | `claude_code`, `codex` or `pi`. Defaults to the current session's. |
| `--from <session\|ref>` | Start the worktree on existing work instead of `origin/<default>`. |
| `--issue <ID>` | The issue this work is against, like `DRA-53`. Repeat for several. |

### Model and effort

A new session inherits this one's harness, model and effort. Pass whatever the
user named. Where they named nothing, two cases are worth a question rather than
an inherited answer:

- **This session is on Fable.** Ask which model and which effort. Fable is a
  pick somebody made for this chat. It is not one to hand to a session nobody
  will be sitting in front of.
- **This session is above its harness's default effort.** Ask which effort.
  On Claude Code the default is High, so `xhigh` and `max` ask. On Codex it is
  Medium, so `high` and above ask. One session at a raised level is a cost the
  user chose once, and fanning it out multiplies it by however many sessions
  you are about to start.

Everything else inherits with no question: any model but Fable, at the default
effort or below. On Codex the model never raises one either — Sol performs and
costs like Opus, so the choice between Codex's models is not worth a turn.

Ask **once for the whole batch**, not once per session, and start them all on
the answer.

Changing harness carries nothing across, because the ladders are not one scale.
A Codex session spawned from a Claude one takes Codex's own default, and the
reverse likewise: Claude Code is Opus 5 on High, Codex is Sol on Medium. Pass
`--model` and `--effort` there only when the user named them.

**pi names no default at all**, and that is deliberate rather than a gap: it is
multi-provider, so which models exist depends on which providers the user has
logged into, and any name this skill picked might be one they have no key for.
A pi session started with no `--model` runs whatever pi's own settings say,
which is the choice they already made. Pass one only when the user named it,
and pass it whole — `xai/grok-4.6`, not `grok-4.6`, since two providers can
serve the same model name.

**pi runs without a permission gate.** It has no approval system, and Dray's
own is not built for it yet, so a pi session does what the model asks. Say so
when you start one for work that writes.

### Tagging a session with its issue

```bash
dray new --issue DRA-53 "Add the issue panel described in DRA-53"
dray issue link DRA-53 --title "Add the issue panel" --url https://linear.app/acme/issue/DRA-53
dray issue link DRA-53 DRA-54
dray issue unlink DRA-54

dray issue link <session-id> DRA-53 --title "Add the issue panel"
```

`link` and `unlink` tag **your own session** when you do not name one, so you
never have to write `$DRAY_SESSION_ID` — and you must not, because Claude Code
refuses a command naming an environment variable inside a worktree, which is
where every session `dray new` creates runs. Name a session to tag one you
spawned.

A tagged session shows an **Issue** tab in the user's panel, and its prompt gains
one line per issue: the identifier and the title, nothing else.

`dray issue link` **writes down what you give it and asks the tracker nothing.**
So pass `--title` and `--url` — you have just read the issue and they cost you
nothing, where without them the tag is a bare `#DRA-53` that links nowhere. They
describe one issue, so name one issue when you use them.

That line is deliberately thin. **Read the issue yourself** through the tracker's
own MCP server — `linear-server` for Linear — which is where the description,
the comments, the links and the current status live. The line in the prompt is an
address, not a briefing.

If that MCP server is not connected, say so rather than guessing: you have the
title and the identifier and nothing behind them. `claude mcp list` says which
servers are reachable.

`--issue`, and a `#DRA-53` written into a prompt, are the other half and they
*do* need the user to have connected a tracker in Dray — that is where the title
is looked up. If they have not, the tag stays plain text, the session still runs,
and nothing fails. Report it rather than working around it.

You can also write `#DRA-53` straight into a prompt — `dray new`, `dray send`, or
the user's own composer. Dray resolves the tag and links it exactly as `--issue`
does.

### Each session gets its own worktree

Every session runs in its own git worktree on its own branch, and there is no way
to turn that off. It is what makes running them at once safe — without it, three
agents write to one checkout and overwrite each other.

By default the worktree branches from `origin/<default>`, **not** from the branch
you are on. So a session created plainly cannot see unpushed work — yours or
another session's.

### Basing a session on existing work

```bash
dray new --from <session-id> "Review the work on this branch and report what you find"
dray new --from feature/login "Write tests for the login flow on this branch"
```

`--from` takes a **session id** — the same id `dray ls` prints and `dray send`
takes — or a branch, tag or commit. Naming a session is the usual case: you have
its id already, and you do not have to know how Dray names its branches.

This is what makes review possible. Spawn a session with a different model or a
different harness, point it at yours with `--from`, and it gets its own checkout
of the same commits — so it collides with nobody while it reads.

A session spawned to review this one's work must be told to send its findings
back to this session — the user asked *you* for the review, so that is where it
has to land. No other kind of session reports back unless the user says so.

Three things to know:

- **Committed work only.** The new worktree starts at a commit. Anything the
  other session has changed but not committed is *not* there. If you are asking
  for a review of work in progress, commit it first — or say plainly in your
  prompt what is missing, or the reviewer will report on a tree that lacks the
  very change the user is looking at.
- **A new branch, not a shared one.** The session gets its own
  `worktree-<name>` branch starting at that commit. It never checks out the
  branch you named, so it cannot commit onto your work or move it.
- **Not a shared checkout.** There is no way to run two sessions in one
  directory, and `--from` is not it. Two agents writing to one checkout overwrite
  each other, and the changes panel cannot tell them apart.

The line `dray new` prints says what it resolved: `Started "…" in worktree
calm-owl, based on worktree-brisk-jade`. Worth reading back when you passed a
session id, since the branch that id resolved to is something only the app knew.

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

## Staying current

```bash
dray update
```

Resolves the newest release and stops there when it is the one already running,
so this is cheap to run and safe to run often. Otherwise it downloads the new
binary over the current one — and rewrites this skill, which ships inside that
binary. So whatever you are reading always describes the `dray` you actually
have.

`dray update --force` installs the newest release even when it is the one you
have, which repairs a damaged binary.

The app and this CLI ship separately, so they can drift. When they disagree about
the protocol the app **refuses the command** — every command, not just whichever
one is new — rather than doing something you cannot see is wrong. You do not need
to know which flags need which version: run the command, and if the two disagree
you get a refusal naming the cure. There are only two:

- *"this dray CLI speaks protocol vN, the app speaks vM — run `dray update`"* —
  you are behind. Run it, then retry the command. This is the common case and
  you can fix it yourself, in one step, without asking anyone.
- *"… — update the Dray app"* — the **app** is behind. You cannot fix this from
  here. Say so to the user, name the command you were trying to run, and stop.
  Do not work around it.

A refusal is not a failure of the thing you were doing. Nothing was created and
nothing was sent, so retrying after the fix is safe.

## When a command cannot reach the app

Every `dray` command reaches the app over a unix socket — `ls` as much as `new` —
so a failure to connect is one of three things, and the line tells you which.

- **`permission denied reaching Dray at …`** — something blocked the connection,
  usually a sandbox. If this command is sandboxed, retry this one command with
  escalated permissions; ask on that command alone, never for a sandbox-free
  shell. A retry refused the same way is the socket path's own permissions, which
  no escalation fixes — say so and name the path.
- **`Dray isn't running. Start the app and try again.`** — the app is closed and
  you cannot fix it from here. Only this sentence means that.
- **`could not connect to Dray at …`** — the line names its own reason. Report it
  as written; it says nothing about whether the app is up.

Nothing was created and nothing was sent in any of the three, so retrying after
the cure is safe.

## Limits

- **Dray does not write to the tracker.** Tagging records the link on the
  session and nothing else: no status change, no comment, no attachment. If the
  user wants the issue moved or commented on, do it through the tracker's own
  MCP server.
- **No reading transcripts.** You can create, list and message. You cannot read
  what another session said — ask it to send you a summary instead.
- **Two levels deep.** A session you create may create sessions of its own; those
  may not. If you hit this, say so — the user can start the next batch from a
  top-level session.
- **Dray must be running.** If it is not, `dray` says so in those words and
  exits non-zero. Only that sentence means it — see above, and do not read any
  other connection failure as the app being down.
- **Nothing updates itself.** A CLI too old for the app is refused with a line
  saying so; `dray update` is how that gets fixed. If the refusal says the *app*
  is behind, tell the user — you cannot update it from here. Updating the app
  first is the smoother order for exactly that reason: it leaves the CLI behind,
  which is the half that can fix itself.
