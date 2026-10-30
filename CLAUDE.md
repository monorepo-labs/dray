# CLAUDE.md

File give Claude Code (claude.ai/code) guidance for work with code in this repo.

## Working practices

**Product work = GitHub issue, before first edit.** Feature, bug fix, UX change, refactor. Plan freely without one; `gh issue create` before code land. Existing issue = use that one.

**Housekeeping take no issue.** CLAUDE.md, plan note, tooling config — thing changing how we work, not what ship. Issue there = noise.

**Minor update take no issue either.** Tooltip wording, copy tweak, one-line prompt change. Several small thing landing in one PR = one issue at most, never one each.

**Description over ~1000 character open with `## TLDR for human`, closed by `---`.** One line per thing worked on, even when only one. Shorter description need none.

**Status = open or closed, and the PR is what close it.** `Fixes #123` in the PR body, which GitHub read on merge. Body = the only slot: worktree branch is `worktree-<name>` minted by the CLI and carry no id, unlike the tracker this replaced. **Exception: work pushed straight to `main`.** No PR = nothing to read, so `gh issue close` yourself.

**PR nobody need review carry `no-review` label, put on before the push so Greptile skip it.** Copy tweak, doc, prompt wording, config. Anything touching behaviour = no label, reviewed.

**Default road = work → test → ready PR → `/greploop`.** No Codex reviewer sessions: that road only ran while Greptile credits were gone.

1. Do the work, then test it for real — run it, not just compile it.
2. Commit, push, open the PR **ready**. Greptile review it on its own.
3. **Always run `/greploop` right after opening the PR**, unasked. It waits for Greptile's review and fixes what is real. Never post `@greptile review` — Greptile reviews every push on its own, so skip the loop's trigger step.
4. **Inside greploop, push each round's fixes yourself and keep looping** — fix, test, commit, push, wait for the next review — until 5/5 or the loop's cap. That push is pre-approved and needs no ask. Stop and wait instead when a fix changes something Yogesh has to try in the dev app, or when he says not to push.

**One repo, `monorepo-labs/dray`. Assign every issue to `yogesharc`.** `gh issue create --repo monorepo-labs/dray --assignee yogesharc`.

**A session working an issue link it**: `dray issue link monorepo-labs/dray#255 --title "<title>" --url "<url>"`. Identifier is always `owner/repo#123` — a bare `#123` is refused on purpose, a number alone naming no repository. That is the app's own rule about its GitHub tracker and it applies to this repo's own work too.

`gh` missing or logged out → say so, then carry on with the work. Tell reader at the end which issue still want creating.

**Don't commit unprompted.** Stage + describe change, then wait — even when finished and passing. Asked = approval for that commit only, not ones after. Same for `git push`, branches, anything rewriting history. One exception: greploop's own commit-and-push, step 4 above.

**Always write commit message with `caveman-commit` skill.** Invoke it, don't imitate — skill carry format and it can change under you. Every commit here, amend included.

**Comment sparingly.** ~10% of lines, only where code cannot speak for itself:

- Write _why_, not _what_. `// bump seq` on `self.seq += 1` = noise; "the session layer must number synthesized events through this same counter or seq develops gaps" = not noise.
- Good reasons: non-obvious wire-format fact, invariant future edit could silently break, why simpler-looking alternative rejected, deliberate omission.
- No restate type signature, no banner separators (`// ---- helpers ----`), no doc comment on every field of obvious struct.
- One dense sentence beat three-paragraph doc comment.

**Write plainly.** Everywhere — chat replies, comments, docs, commit messages, plan files. Short sentences, active voice, no clutter, no over-explain, no under-explain where detail matter. Skip fancy words. Cut any word doing no work.

**Stay out of files being actively edited.** User say they work on something → review and advise, don't rewrite. `todo!()` or missing match arm = work in progress, not defect.

**`///` doc comments show on hover, so add one to every `pub fn` and any non-obvious private fn** — one line, same "why not what" bar. Skip trivial helpers/getters where name say all.

## What this is

`Dray` = Tauri 2 desktop app wrapping coding-agent CLIs in chat UI. Spawn `claude` binary as child process, speak stream-json over its stdin/stdout, parse each output line into typed Rust enum, forward to React frontend as Tauri event.

## Repo layout

pnpm workspace, three apps, no shared package yet — plus a native iOS app outside the workspace.

```
apps/desktop/   the Tauri app — everything below this section describe it
apps/web/       marketing site: Next.js App Router, Tailwind 4, deploy Vercel
apps/docs/      docs: Blume (Astro), own Vercel project, served at drayhq.com/docs
apps/ios/       SwiftUI client of dray-serve, XcodeGen project — read apps/ios/PLAN.md
```

**The iOS app speaks `dray-serve`'s wire with hand-written `Codable` types**, so a change to a command's arguments, an event's shape or the serve protocol is a change there too. Every decode is lenient by design; a renamed field shows up as a missing row, not an error.

**Docs live at `drayhq.com/docs` through a rewrite in `apps/web/next.config.ts`** to `DOCS_ORIGIN`, the docs project's own URL. Blume builds with `base: "/docs"`, which puts `/docs` on every link but writes the files at the output root, so the rewrite strips it: `/docs/x` here is `/x` there. `blume dev` serves under the base, so the dev fallback origin carries `/docs`. Content folder is `content/`, not `docs/`, or every page lands at `/docs/docs/…`. Blume wants Node 22.19+. Copy describes what shipped, checked against the code — a docs page promising a feature is a bug report waiting to happen.

Root `package.json` carry **no dependencies** — name, `packageManager`, `pnpm --filter` aliases only. Keep it that way: dep at root install into root `node_modules`, which both apps resolve through, so version drift there show up as one app mysteriously working.

Two things repo-wide on purpose. Release pipeline = desktop's alone but live in root `.github/workflows`, so paths carry `apps/desktop/` prefix and `tauri-action` need `projectPath`. And `pnpm-lock.yaml` single for whole workspace, why `pnpm install` run at root and nowhere else.

`apps/web` share design language with app but **no code** — no build step reach across, no import cross line. First component genuinely wanted in both = reason to create `packages/ui`, nothing before.

## Design direction

Dray keep to one visual language — one radius scale, one yellow, filled buttons carry shadow and chrome don't, shortcuts live in real tooltips and never on `title`. Window is glass (macOS vibrancy) with body's fill the only hole in it, and the titlebar row is what user drag window by.

**Rules, rejected alternatives and the reasoning all live in [DESIGN.md](apps/desktop/DESIGN.md)** — read it before restyling anything, changing window chrome, or reworking a panel, card, row or button. Two things there fail *silently* and cost an afternoon each: vibrancy's `body` specificity, and window drag needing both an explicit capability and `data-tauri-drag-region="deep"`.

## Commands

Use **pnpm**, not npm. `tauri.conf.json` hardcode `pnpm dev` / `pnpm build` as before-commands.

**Every app command run from its own package dir.** Workspace root hold no deps, only thin `pnpm --filter` aliases (`pnpm app`, `pnpm web`). Anything else — `cargo`, `vitest`, `tauri build` — want real cwd, because relative paths in `tauri.conf.json`, `.cargo/config.toml` and `install.sh` all resolve against it.

```bash
cd apps/desktop && pnpm tauri dev
```

That = real entry point. `pnpm tauri` = shim ([scripts/tauri.mjs](apps/desktop/scripts/tauri.mjs)) merging `tauri.dev.conf.json` into `dev` subcommand only, so dev app carry own name and icon and `build` untouched.

**Never wait for the dev app to come up.** Start `pnpm tauri dev` as one background Bash, hand over to the reader, and stop — no `until`/`sleep` loop on its log, no second task watching the first. The dev task is a server and never ends, and a cold compile is minutes, so a wait is either a turn spent sleeping or a task nobody can close. A failed compile exits the task and the harness reports it on its own. Need a look at the log anyway? Read it once, and grep what sits past cargo's colour codes: Tauri run cargo with `--color always`, so `` Running\x1b[0m `target/debug/dray` `` never matches ``Running ` `` — `` `target/debug/dray` `` and `could not compile` do.

**Shim also pick dev port, and it only side that can.** Vite and Tauri have to agree on one, and both start from here — so shim ask the OS for a free one (`listen(0)`), hand it to Vite as `DRAY_DEV_PORT` and to Tauri as second `--config` carrying `build.devUrl`. Fixed 1420 was hard failure before, which = one worktree's dev build refusing to start because another's already running. `strictPort: true` **stay** on Vite side: port already known free, and Vite wandering off it leave Tauri loading URL nothing serve.

- `pnpm dev` — frontend only, port 1420 unless `DRAY_DEV_PORT` say otherwise. `invoke` do nothing in plain browser, so only useful for pure-CSS/layout work.
- `pnpm build` — `tsc && vite build`. `pnpm tauri build` for bundled app.
- `cd apps/desktop/src-tauri && cargo test` — Rust tests (parser + mapper + event-model compatibility, plus git and file index). Single test: `cargo test parses_complex_fixture`.
- `cd apps/desktop/src-tauri && cargo check` — fast type check, no linking whole app.
- `cd apps/desktop/src-tauri && cargo check --no-default-features --features serve --bin dray-serve --tests` — the headless build. **Run it after any core change**: nothing else compiles it.
- `pnpm test` — frontend tests (vitest, node environment, no DOM). Scoped to pure logic where being wrong invisible on screen: [streaming.ts](apps/desktop/src/lib/streaming.ts), which read same committed fixtures Rust tests do; composer's caret arithmetic ([slash.ts](apps/desktop/src/lib/slash.ts), [mention.ts](apps/desktop/src/lib/mention.ts), [highlight.ts](apps/desktop/src/lib/highlight.ts)); and [theme.ts](apps/desktop/src/lib/theme.ts)'s coercion. Components not tested — no DOM here.

## Architecture: the event pipeline

Messages flow one way out to CLI and one way back in; return path = what most Rust code exist to serve.

1. **`useSessions`** ([useSessions.ts](apps/desktop/src/hooks/useSessions.ts)) call `invoke("send_msg", {...})` with camelCase keys (`sessionId`, `isNewSession`); Tauri map them onto snake_case params in [lib.rs](apps/desktop/src-tauri/src/lib.rs). Frontend mint session UUID with `crypto.randomUUID()` — Claude Code adopt id chosen by app, not other way round.
2. **`SessionManager`** ([session.rs](apps/desktop/src-tauri/src/session.rs)) own `Mutex<HashMap<String, Session>>`. On send: spawn process for new session, reuse live one when present, re-init from `--resume` when id known but process gone. New sessions written to index before spawn, so one failing to start still visible, and created `SessionIndexItem` returned to frontend — `Some` on creation, `None` on resume.
3. **`claude_code::init`** ([claude_code.rs](apps/desktop/src-tauri/src/harness/claude_code/claude_code.rs)) spawn `claude -p --input-format stream-json --output-format stream-json --verbose --include-partial-messages`, add `--session-id` for new sessions or `--resume` for existing, and `-w <name>` on creation for worktree session.
4. Two `tokio::spawn` tasks drain stdout and stderr. Each non-empty stdout line go through `parser::parse_line` → `Mapper::map` → `app.emit("agent_event", &agent_event)`, then appended to session's JSONL. Nothing keep events in memory — the log is the only copy.
5. **`useSessions`** listen for `"agent_event"`, route deltas into the module store in [useStreamingBlock.ts](apps/desktop/src/hooks/useStreamingBlock.ts) and everything else onto session's `events`. `Chat.tsx` render both. **Deltas never touch React state**: held there they re-rendered all of `App` per token. Growth paints once a frame and only the preview row subscribes to the text; a committed event retires its preview inside the same `flushSync` as its own commit, or the two land a frame apart.

**Finding the binary.** [binpath.rs](apps/desktop/src-tauri/src/binpath.rs) resolve `claude` to absolute path, cached in `OnceLock`; both spawn sites go through it. Never go back to `Command::new("claude")` — bundled `.app` launched from Finder or Dock inherit launchd's `PATH` (`/usr/bin:/bin:/usr/sbin:/sbin`), which hold no `claude` however globally installed, so bare name work under `pnpm tauri dev` and fail in bundle with no events arriving at all. Resolution escalate by cost: inherited `PATH`, then known install dirs (`~/.local/bin`, `~/.claude/local`, `~/.bun/bin`, `~/.npm-global/bin`, Homebrew, globbed nvm version dirs), then `$SHELL -l -c 'command -v claude'`. `-l` load-bearing — without it zsh read `.zshrc` only and miss `PATH` exported from `.zprofile`. `git` need none of this.

**Worktrees.** `claude -w <name>` put tree at `<project>/.claude/worktrees/<name>` on branch `worktree-<name>`. Child must spawn at **project root** — directory not existing yet can't be `chdir`ed into, and CLI create tree and move itself in after launch. So spawn dir and session's recorded `cwd` differ for worktree sessions, only latter point at tree.

## The headless server

**The core runs without Tauri as `dray-serve`, and the frontend reaches it through [transport.ts](apps/desktop/src/lib/transport.ts).** Design, wire and auth in [SERVE-PLAN.md](apps/desktop/SERVE-PLAN.md). What keeps it working:

- **The core never names Tauri.** Events go through [`Sink`](apps/desktop/src-tauri/src/sink.rs), whose `emit` is spelled like Tauri's; a command takes `sink: Sink` where it took `app: AppHandle`. The `SessionManager` is `session::manager()`, a static, not managed state. A core command is `#[cfg_attr(feature = "desktop", tauri::command)]`, and a new one also wants its line in `serve.rs`'s table or it answers `unknown command` remotely.
- **`desktop` is a default feature** holding Tauri and every Mac-only dependency; `serve` is opt-in. `tauri build` builds defaults, so the release is untouched and skips `dray-serve` by its `required-features`.
- **`DRAY_HOME` moves `~/.dray` and the orchestration socket with it.** Two processes on one data dir lose each other's index writes, so a server beside the running app needs its own.
- **Frontend imports `invoke`/`listen` from `@/lib/transport`, never `@tauri-apps/api/core`/`event`**, and loads local files through its `fileSrc`, never `convertFileSrc`. Remotely that is the server's `/file` route, confined to attachments and recordings.
- **A reconnect resyncs from two places**: logged events from the log tail, matched on event id because subagents restart `seq`; unlogged state from the `live_state` frame the server opens every connect with. A new piece of unlogged state the reader must see after a drop — the way an open card must be — belongs in `serve.rs`'s `Live`, or a reconnect loses it silently.

### The Mac's background server

**On a Mac the sessions live in `dray --serve`, the app's own binary run with no window, and the app is its client** (#456, [MAC-SERVER-PLAN.md](apps/desktop/MAC-SERVER-PLAN.md)). `main.rs` reads `--serve` before Tauri is touched, so no `NSApplication` exists and macOS never counts it as the app. It owns `~/.dray`, the orchestration socket, every agent and Remote access; quitting Dray leaves it running.

- **launchd runs the release one** (`com.yogesh.dray.server`, `KeepAlive`), installed by the app on every launch. A changed plist is held in memory and loaded only after the old server has exited idle, since unloading stops every turn, so the file on disk always names the loaded job — except a changed `DRAY_HOME`, which moves at once, the old server being unreachable from the new home; `DRAY_HOME` and `DRAY_NO_ANALYTICS` ride it, launchd giving the server its own environment. `serve.lock` is held for a server's life, so two can never share a home. **A dev build starts its server as a child instead**, home `~/.dray-dev`: TCC judges a launchd job on its own code identity, and an unsigned rebuild is a new identity, so every `cargo` build asked for Documents access again and the server hung in dyld until answered. A child is attributed to the app that started it. **A dev build compiled in a worktree gets a home of its own**, `~/.dray-worktrees/<name>` (`dev_home`, read off `CARGO_MANIFEST_DIR`), so every worktree runs its own server on its own code: one shared home meant whichever build's server started first served them all, and two apps judging each other's server stale restarted it in a loop (#495). **Projects, settings and credentials stay shared** through `store::config_dir`, which answers `~/.dray-dev` for every dev build, so a project attached in one worktree is there in all; every writer of those three takes `lock_across_processes`, which lives there too. Sessions, drafts and servers stay per home — two servers would resume one conversation at once, and `servers.json` is saved from each app's in-memory list.
- **"This Mac" is the `local` connection in `servers.rs`**, address and token read from `serve-port`/`serve-token` on every connect. `transport.ts`'s `APP_COMMANDS` is what the app still answers itself — browser, dictation, banners, updater, server list, opening apps — and a test holds it to `generate_handler!`, since a name missing there is sent to a server answering `unknown command`. A local call waits up to 20s for the connection rather than failing, so a restart never reads as sessions gone.
- **A server older than the app restarts itself.** It writes its exe's mtime into `serve-port`; the app compares and sends `restart_when_idle`, which exits once no turn runs. That one rule is how an update and a rebuild both land, so Install has no code of its own here.
- **The server calls back into the app** for what lives on screen: the app's hello carries `host:{browser}`, honoured on the local listener alone, and `host_call` sends `{"call":n}` frames the app answers with `{"reply":n}`. `dray browser` steps go to the app's CEF while it is open and to headless Chromium otherwise; `dray server …` goes to the app or is refused; settle closes the app's tabs. A host that drops answers every waiting call — read errors included, which is why that loop has no `?`.
- **`settings.json` and `credentials.json` have two writers**, so `settings::update` and `set_credential` take an `flock` beside the process mutex.
- **Quit asks, and offers a full stop**: Quit leaves sessions running; Quit and stop sessions is `launchctl bootout`, or `SIGTERM` to the pid in `serve-port` in dev.

### Updating a remote server

**A `dray-serve` updates itself, on a channel of its own** (#514). Its welcome frame carries `release` — the CLI version release-cli.yml bakes in as `DRAY_CLI_VERSION`, so a local build says none and is never offered one — and `stale`, the binary on disk having moved since it started (read off a path taken at start, since Linux's `current_exe` names the deleted inode after a rename). The app reads GitHub's `cli-v*` releases hourly, unauthenticated, and a row is behind where a newer one is out on **its** channel: `Saved.beta`, a bool and never an enum, since a variant an older build cannot spell fails the line and the line is the whole list. A server ahead of its channel is not behind, and install.sh keeps a newer install rather than going back, so leaving beta never downgrades. `update_server` runs the `dray` from the same archive — which always knows `--channel` — and restarts once idle only where the binary moved; a restart **exits 75**, because systemd's `Restart=on-failure` and the headless Mac's `KeepAlive` on a failed exit both bring back a non-zero exit alone, which is also what keeps a stopped server stopped. A stale server met on connect is sent `restart_when_idle`, This Mac's rule. **Restart to update is all or none**: servers behind on their own channel, beta ones alone on a beta app, since a beta release says nothing about stable. A server from before `update_server` answers `unknown command` and is told to update by hand once.

## The normalized event model

Both harnesses map onto one vocabulary in [events/events.rs](apps/desktop/src-tauri/src/events/events.rs), so the frontend and on-disk log never see raw wire format. Adding a harness = writing one mapper. Per-harness code sits under `harness/<name>/` with a seam: `parser.rs` (wire → typed events), `mapper.rs` (those → `AgentEvent`). Module entry files are named after their directory (`events/events.rs`), not `mod.rs`, declared with `#[path]`.

Two rules the whole design rests on:

- **`seq` is the ordering key, not `ts`.** Most Claude Code lines have no timestamp. One counter per session, and events the app synthesizes itself (the user's own prompt, which the CLI never echoes back) must be numbered through it too.
- **Deltas are a preview; the committed event wins.** Absent deltas are the common case — Codex sends none, Claude Code sends none for subagent output — so consumers must render correctly without them. Deltas match on `BlockRef`; tool calls join on **tool_use id**.

Prompts go the other way as one JSON line on the child's stdin ([session.rs](apps/desktop/src-tauri/src/session.rs)), sharing the pipe with `control_request` lines ([control.rs](apps/desktop/src-tauri/src/harness/claude_code/control.rs)). `set_model` and `set_permission_mode` switch a running child in place. **`set_effort` does not exist** and `effort` on `set_model` is accepted and ignored, so effort changes need a respawn.

**`interrupt` stops a turn, `stop_task` stops a task** (v2.1.232). `stop_task` takes `task_id`, not the spawning `tool_use_id`, and `not_found`/`not_running` also answer success — so a wrong id looks exactly like success, and only lifecycle events' `agent_id` carry the right one. **Stop = interrupt alone.** It fanned `stop_task` out over every outstanding id back when a task held the session `in_progress`; status follow the turn alone now, so the fan-out only killed dev servers and subagents the reader still wanted. `StatusTracker` hold ids rather than a count for the panel's per-task stop and the stranded-task report, not for Stop.

**Dray closes a turn the CLI never will** (#673). An interrupt with no turn running is acked and nothing else (v2.1.310), and a task notification can open exactly that turn — `init`, no model call, no `result` — so Stop closes it itself after 5s where the tracker's `epoch` has not moved (`close_unanswered_stop`, through `ingest`, so a prompt queued behind it goes out). A child that dies mid-turn is closed by `settle_dead_child`, only while the slot still holds that child, and a send finding the child exited drops it from the slot and resumes.

**What can change mid-session.** Model and permission mode apply in place; effort kills and resumes; project, branch and worktree are creation-time only and the composer hides them once a session exists. That rule keeps `git checkout` from ever running under a live child.

**What can change mid-*turn* is narrower, and a prompt sent then must run on the pick.** Measured against each CLI with a turn running: Claude Code's `set_model`, `set_permission_mode` and `apply_flag_settings` are all taken and the next model call inside the turn uses them; grok takes `set_config_option`; pi takes `set_model` and `set_thinking_level` (and writes nothing to its own `settings.json`, the worry that once had it respawning); fx refuses every config change while a prompt is open (`-32600 Prompt already in progress`); Codex steers a queued `turn/start` into the running turn and ignores its `model`. So `send_msg` applies live controls before queueing on the first three, fx holds the whole pick on `FxSession::deferred` and applies it at the flush that opens the queued turn — taken under the queue lock with the batch it belongs to, and every fx flush spawned off the read loop since the requests are answered through it; what landed goes on `FxSession::applied` for the next send to catch the `Session`'s record up on — and anything a harness cannot carry onto the next prompt is **locked in the composer while a turn runs** ([liveControls.ts](apps/desktop/src/lib/liveControls.ts)): every control on Codex, effort on Claude Code, stance on grok and pi. That table and `send_msg`'s gate are the same fact stated twice.

### Permissions

**`ApprovalPolicy` is what `--permission-mode` accepts; `PermissionMode` is what `system/init` reports**, and they differ (v2.1.224): `plan`, `acceptEdits`, `bypassPermissions`, `dontAsk` report themselves, but both `auto` and `manual` report `default`. So `ApprovalPolicy` must never regain a `Default` variant, and session state must never be reconciled *from* the init event — `auto` and `manual` are indistinguishable there.

**Nothing is ever asked without `--permission-prompt-tool stdio` on spawn.** The literal `stdio` is a special case, undocumented in `--help`. Without it the CLI auto-denies and reports `system`/`permission_denied`.

A held call arrives as `control_request`/`can_use_tool`, the only line travelling *into* the app expecting an answer, and the CLI blocks its turn until a `control_response` with that `request_id` comes back. Silence stalls the session, so [permissions.rs](apps/desktop/src-tauri/src/harness/claude_code/permissions.rs) guarantees a reply and an unmodelled subtype is refused from inside `read_stdout` — hence `Session.stdin` is an `Arc<Mutex<ChildStdin>>` shared with the read loop. The reply double-wraps:

```json
{"type":"control_response","response":{"subtype":"success","request_id":"…",
 "response":{"behavior":"allow","updatedInput":{…},"toolUseID":"…",
             "updatedPermissions":[…]}}}
```

`deny` takes `message` and an optional `interrupt`. **A wrongly shaped reply is ignored silently**, so a regression here presents as a hung turn, not an error.

- Options are the CLI's — `permission_suggestions` carry pre-composed rules and `build_options` turns each into a button. **The rule never leaves Rust**; the frontend answers with an option id alone.
- The request is always main-thread even when a subagent asked, since subagent events are filtered out of chat and `agent_id` is the harness's handle, not the `tool_use_id` this app correlates subagents by.
- The card renders outside the turn stack from `buildTranscript`'s `pendingAsks`. Neither `permission_requested` nor `questions_asked` belong in `RENDERS` — they draw no row, so counting one miscounts collapse.
- **A JSON-RPC peer's `requestId` is minted, never its RPC id** (`rpc_request_id`). Codex, fx and grok count those from 0 in each child, so after a respawn the new child's first ask repeated an id the transcript already held a decision for and drew no card, while the rail went yellow (#301). The RPC id rides `Reply::Rpc`. `buildTranscript` also lets a decision retire only the asks *before* it.
- `control_cancel_request` is the CLI taking a question back: drop the entry, mint `PermissionDecided { automatic: true }`, **write no reply**. It names an inbound id and carries v4 where `ControlLine::new` mints v7.
- **Never persisted** — request, decision and questions alike. Only the child that asked can answer and no child survives a restart, so a replayed one is a card whose buttons cannot work.
- **Which is why the early-event hold is dropped on the commit, never on the load** ([earlyEvents.ts](apps/desktop/src/lib/earlyEvents.ts)). A request arriving for a session the app holds no transcript for is held there, and taking that hold at the five sites that *load* one was a frame too early: between the read and the load reaching `sessions` the listener still cannot see the session, so an event landing in the gap was held again with nothing coming back for it — `ensureLoaded` returns early for a session already here. Unpersisted, that hold is the only copy, so the crew row went yellow over a card that had been thrown away (DRA-277). One `useEffect` on `sessions` drains it instead, which is the real precondition said once; the drop is taken *outside* the updater, since React invokes one twice and a hold consumed inside leaves the second invocation building a state with nothing merged into it.

**`AskUserQuestion` rides the same channel and is not permission.** It arrives as `can_use_tool` with `requires_user_interaction: true`, and the answer travels back inside *allow*: `updatedInput` is the tool's own input with an `answers` map added, keyed by each question's verbatim text. Allowing with nothing filled in is what produces "The user did not answer the questions", so the mapper branches on tool name into `QuestionsAsked` and the card carries no Allow/Deny. Three answer shapes (v2.1.226): an option's **label** is the answer, multi-select is one **comma-separated string**, free text is any string. An absent question is skipped, so Skip is a real answer.

[QuestionRequest](apps/desktop/src/components/chat/QuestionRequest.tsx) is a `<form>`, and that is what reads answers back: each item's `name` is the question's text, so `FormData` is already keyed the way the CLI matches. `items` must carry `choices` (numbers come from that array, not markup), and the card **takes focus on mount** onto the first choice, since Enter only fires when the event target is a choice. The free-text box is not optional — the CLI promises the user one and tells the model not to add an "Other" option because of it.

**Two denials mean different things.** `PermissionRequested` → `PermissionDecided` is a question the user answered; `PermissionDenied` is `system`/`permission_denied`, refused with no question possible. Both render as nothing — approval is visible in the tool running, refusal in its error.

**A tool call with no result is only _pending_ while something could still produce one.** `buildTranscript` takes `live` (session `busy`) and files an `ABANDONED` stand-in into `resultByCallId` for every call the log leaves open, so collapsed row, group header and shimmer all read pending-ness from one map. `user_message` also abandons everything open before it. Marks are applied after the walk and only where no real result exists, since a background subagent can report back after its turn. It works only because `handleSelectSessionIndexItem` returns early for a session already in memory — make it always refetch and an open card disappears mid-flight with the agent still blocked behind it. **Loaded transcripts are evicted** (`evictSessions` in [useSessions.ts](apps/desktop/src/hooks/useSessions.ts)) on archive, on settle, after ten minutes unviewed, and past eight loaded, least recently touched first — never the selected session, never one mid-turn, never one holding a card, for that same reason. A load stamps the session as touched, so a sidebar row hovered for 100ms (`onPrefetch`, which is `ensureLoaded`) is not the first thing the cap takes back.

### Streaming and previews

**A tool call is drawn before its arguments arrive.** `Write`'s arguments *are* the file, so the committed row lands only once the whole content has streamed (39.5s on a 12KB file). Split = **header from stream, body from committed event**; a half-arrived diff is worse than none, so the preview row never expands. It is retired on `tool_call_started`, not `block_stop`, which lands later and draws both rows for a frame.

[streaming.ts](apps/desktop/src/lib/streaming.ts) reads the accumulated `input_json_delta` prefix rather than parsing it and holds no state between frames, so a dropped fragment cannot corrupt a running parse. Two lookup strategies sit side by side and the difference is load-bearing: **target keys are field-keyed** (`file_path`, `command`, `pattern`…), safe on MCP tools nobody enumerated, while the **line-count key is tool-keyed**, because `content` only means *file* content on a tool that writes one (`TodoWrite` carries `content` inside every todo). Within target keys, `command` is checked before `description`.

### The changes panel

**Diff two snapshots, not the working tree.** `git diff` reports everything uncommitted, including what was already dirty. `snapshot_tree` captures the tree at send time and the panel diffs that against the turn's **closing snapshot**, frozen onto `turn_completed.head` by `read_stdout`. Freezing the end is as load-bearing as snapshotting the start — head left at "now" and an idle session absorbs whatever later touches the checkout. A frozen pair also diffs to one immutable answer, which lets `useChanges` treat that cache entry as final.

Snapshot = **temp-index `write-tree`**: copy the index to a temp file, `git add -A` through `GIT_INDEX_FILE`, `write-tree`. Real index, working tree and stash untouched, and copying rather than starting empty keeps it at ~18ms since the copy carries git's stat cache. `--git-path index` finds it, which is not `.git/index` for a worktree session.

Comparing *content* rather than replaying edits is why `Bash` moves and reformats show up, several `Edit`s collapse into one diff, and a mid-turn commit is invisible — `Edit` carries only the fragment it replaced and `Write` never reports what it overwrote. Cost: the snapshot describes the *tree*, so anything else writing during the turn is attributed to it.

The baseline rides on `user_message.baseline`, the closing head on `turn_completed.head`. `changeRange` pairs the newest baseline with the newest head *after* it, and leaves head open only while nothing closed the turn, so a turn that never closed degrades to diff-against-now. **Only the newest prompt's snapshot is ever used.** `None` is ordinary and reads as nothing to show. **A worktree session's first prompt is the exception** — no tree yet, so the baseline comes from `base_ref_tree`.

- **A live diff re-reads on a tool finishing, never on any other event, and at most once per 15s mid-turn** (`LIVE_REFRESH_GAP` in [useChanges](apps/desktop/src/hooks/useChanges.ts)). Each read is five `git` spawns and a `git add -A` over the tree; keyed on `events.length`, a 20-tool turn read 42 times per open view. The turn's end reads at once, so the settled answer is never late. The commit logs and the Files tree move on the turn's end alone (`turnRevision` in `App`); the repo view's HEAD moves on every tool result, one `rev-parse`, since a mid-turn commit otherwise reads as uncommitted. Reopening a hidden pane always re-reads — the reader's editor moves the tree with no tool finishing.
- **Panes hide, they don't unmount.** The `active` prop is the other half: a hidden `ChangesPanel` must not keep snapshotting on every event, and `active`'s place in the effect deps triggers the catch-up read on reopen.
- **Reads are cached across mounts, keyed by tree id** ([useChanges](apps/desktop/src/hooks/useChanges.ts)) — a new snapshot is a new key, so an entry can only be stale by being unreachable and eviction is a size cap, not invalidation. Change sets are counted (12); file contents are budgeted by **bytes**, or a turn touching more files than the cap evicts rows while they are still mounted. A fresh read whose `base`/`head` match keeps the **old object**, which is what lets `FileRow`'s `memo` survive a re-render on every session event.
- **Two `cat-file` passes per file, and the split is about memory.** `--batch` is one spawn but drains stdout whole, so a 2GB blob is read in before `MAX_BLOB` could reject it; `--batch-check` returns headers only. Input is NUL-delimited (`-z`), since a rev embeds a path and a path may contain a newline. Both parsers always answer exactly as many entries as asked for, or one file's contents render under another's name.
- **Every `git diff` here ends in `--`**, or a working-tree file *named* like a sha makes it die with "ambiguous argument". Covered by test.

**Filtering `cargo test` rewrites generated TS.** ts-rs regenerates `src/types/events.ts` from whatever exports ran, so `cargo test git::` leaves only git's types and breaks the frontend build. **Always follow a filtered run with a bare `cargo test`.**

### Indicators and failed turns

- **Thinking blocks arrive empty** — `thinking_delta` carries `thinking: ""` and the committed block is empty too. `reasoning` must not be counted in `RENDERS`, or the working indicator stays suppressed for the rest of the turn. No fixture carries one.
- **A failed turn draws the harness's own sentence, never `stop_reason`.** Aborts are already suppressed, leaving `stop_sequence` — a wire token that says nothing, drawn instead of the `final_text` beside it that usually carries the cure. `Turn failed` is the fallback for an errored turn with no text.
- **The harness sends that sentence twice, and the red row wins.** The builder drops the assistant block rather than the renderer skipping it, since three surfaces could draw it. Written to under-match: the block must be the turn's last rendered row and **equal** the sentence whole, never contain it. `drawsFailure` is exported from [transcript.ts](apps/desktop/src/lib/transcript.ts) and shared with [EventRow](apps/desktop/src/components/chat/EventRow.tsx), since an aborted turn draws no red row and dropping the block there would take the agent's last words off screen.
- **The working indicator is driven by `model_request_started`**, not "this turn has drawn nothing yet", which only ever described the turn's first wait. Three exits clear it, all needed: a `block_start` that is not thinking, `turn_completed`, and any `session_status` off `in_progress` — the last covers interrupt or a dead child. Per-session and nowhere else, since both driving events are unpersisted.
- **Retry takes the indicator over.** `system`/`api_retry` draws its own row with the working one suppressed; the mapper drops `error: "unknown"` on the way in. There is no closing event, so it clears on "`api_retry` is the newest event", gated on `busy`.

## A missing agent CLI

**Answered before the reader writes a prompt, and refused before a session exists.** `agent_availability` reports which harnesses can run here; the picker reads it on mount and marks the one that can't, and `send_msg` checks again under `if is_new_session`.

That ordering is the whole feature. The index entry lands **before** spawn on purpose, so a session failing for an unpredicted reason stays visible — but a missing CLI is predictable, and through that path it leaves an empty row pointing at an agent that can never start. Refusing earlier means nothing to delete and no retry choreography: the composer never unmounts, `useDraft` still holds the text, and retry is pressing send again.

**"Is it installed" is read off the cached path, not probed again.** `binpath::agent_available` calls the ordinary resolver and asks `is_absolute()` — a successful resolution is always absolute, and the bare-name fallback is the only relative answer either resolver can give. Free after the first call, which matters because the *failing* call is the expensive one. For Codex it covers a stale binary for free: one with no `app-server` subcommand never satisfies `speaks_app_server`, so it falls through to the bare name exactly like an absent one.

**Dray installs nothing** — it names the command and links the page, using each vendor's own install script. Known cost: `binpath`'s cache never invalidates, so a CLI installed while the app runs still reads as missing until restart.

## Demo pages

**Demos are kept, never deleted.** A question answered once comes back — a restyle, a regression, a palette added — and a page already mounting the real component with its inputs faked is the cheapest way to look again. Today: [more-panel.html](apps/desktop/demo/more-panel.html) for the More tab's checklist beside its run list, [pr-empty.html](apps/desktop/demo/pr-empty.html) for the PR panel's empty states, [issues-empty.html](apps/desktop/demo/issues-empty.html) for the issues page with no tracker behind it, [recording-notice.html](apps/desktop/demo/recording-notice.html) for the browser pane while an agent records, and [tab-reorder.html](apps/desktop/demo/tab-reorder.html) for dragging tabs in the browser and Files strips — its **Run drag check** button drives the drag with synthetic pointer events, since `dray browser` has no drag verb, and [composer-paint.html](apps/desktop/demo/composer-paint.html) for the composer's colours following the text as it is edited — its **Run paint check** must run in WebKit (Safari or the app), since the session browser is Chromium and places typed characters differently, and [servers.html](apps/desktop/demo/servers.html) for the whole app against two real `dray-serve`s, one standing in for the local core — its Tauri IPC is mocked and the mock does in the page what `servers.rs` does in Rust, and [sounds.html](apps/desktop/demo/sounds.html) for every sound Dray and the island make, each with where it plays — update it when a sound is added or moves, and [send-sound.html](apps/desktop/demo/send-sound.html) for the island's send sound, made in code after iMessage's swoosh and auditioned by number key, and [dictation-sound.html](apps/desktop/demo/dictation-sound.html) a slider builder for dictation start and stop sounds in that send sound's family — nothing it made was picked, and dictation kept Handy's pair. [code-render.html](apps/desktop/demo/code-render.html) mounts every code surface — Edit diff, ranged Read, markdown fences, full-file diff, Files view — and times each to its first coloured token, the timings riding the window title so a script can read them out of Safari; run it before and after any `@pierre/diffs` or Shiki bump. [handoff-buttons.html](apps/desktop/demo/handoff-buttons.html) puts Settings → Composer beside the handoff row at full and panel-open widths, with **Hold the rows open** for a screenshot, since hover is what opens one. The composer, question-card, fx tool-row and crew-column demos were deleted before this rule and are gone. **One page per question, never one page collecting them**, so each stays small enough to read. Check what is here before adding one.

**A demo is its own page, never a flag on the real one.** An HTML page in `apps/desktop/demo/` (`demo/<question>.html`) loading its own entry from `src/demo/`, and opened at `/demo/<question>.html`. Vite's dev server serves any HTML under the package root, so it is reachable under `pnpm dev`; `vite.config.ts` names no extra `rollupOptions.input`, so `pnpm build` emits `index.html` alone. Gating on a query flag was the rejected alternative: it puts demo-only branches inside production code paths. A demo mounts the **real** components with faked inputs, and needs no test seam in `src/`: stub the Tauri bridge in the demo itself.

**Every demo's `<html>` carries `data-demo`**, or it cannot scroll: the app pins `html`, `body` and `#root` to the window with overflow hidden, since it owns every scroll container, and [App.css](apps/desktop/src/App.css) gives page scroll back only to that attribute.

**A new demo mounts `<DemoThemeBar />`** ([ThemeBar.tsx](apps/desktop/src/demo/ThemeBar.tsx)): Settings' own theme swatches ([ThemeSwatches](apps/desktop/src/components/ThemeSwatches.tsx), arrow keys included) and Light/Dark on the app's theme store, since a surface is judged across every palette and both modes. No hand-rolled mode toggle, and no theme attributes hardcoded on the page's `<html>`. The recording demo has it; the three older demos predate it and are left as they were, on purpose.

Two things that fail as a blank page with nothing in the dev server's output: **a demo page has to bring `App`'s own providers with it** (a control with a tooltip throws without `TooltipProvider`), and **a browser is not a webview** — `getCurrentWebview()` and `getCurrentWindow()` **throw** outside Tauri rather than rejecting, so reach for a `try` whenever an effect touches `@tauri-apps/api` synchronously. `invoke` is safe, since it rejects.

## Persistence

Everything lives under `~/.dray/` ([store.rs](apps/desktop/src-tauri/src/store.rs), [projects.rs](apps/desktop/src-tauri/src/projects.rs)).

- **`sessions/<session-id>.jsonl`** — one mapped `AgentEvent` per line, append-only. Single writer per file, so `O_APPEND` alone is enough; no lock. On resume, `next_seq_by_session_id` reads the **highest** `seq` in the whole log, never the last line's — see `max_seq` for why.
- **`sessions/index.json`** — one `SessionIndexItem` per session, holding both `cwd` (where the agent runs) and `project_path` (repo root, the grouping key, so worktree sessions still list under their project). Rewritten whole, so it take a process-wide lock and land via write-temp + `rename`.
- **`attachments/<session-id>/`** — a copy of every image sent from that session, deleted with the session. Only images: non-image attachments are referenced by original path and never copied.
- **`drafts.json`** — tasks saved with ⌘S on the new-task composer and not yet started: the prompt plus project, harness, model, effort, stance, fast and worktree picks. **Its own file, never the index**: an older build reading a draft there would draw a session with nothing behind it, and resuming it fails. Rust holds each entry as untyped JSON keyed on `id` — the shape is `Draft` in [useDrafts.ts](apps/desktop/src/hooks/useDrafts.ts) alone — so a pick this build cannot spell can never fail the file. ⌘S empties the composer and leaves the reader on the new task, with a notice saying where the text went. An open draft's text lives under `draftKey(id)` in `useDraft`, apart from the new-task composer's `null`, and autosaves; send closes it *before* the composer clears its text, or that clear is saved as the prompt — which is also why a draft left empty is judged off the *saved* prompt before it is discarded. **Drafts are a sidebar view of their own**, beside active and settled and toggled the same way: mixed into the live list they read as sessions, and needed a mark and a cap to stay apart. ⌘⇧↑/↓ walks whichever view is up, so in drafts it steps drafts and nothing else. **`dray draft new|ls|rm|start` writes the same file over the socket and emits `drafts_changed`**; `useDrafts` reloads on it through its write queue, so a save in flight lands before the read, and keeps its own copy only of a draft whose autosave is still waiting — one the CLI took away loses that autosave too, or it would write the draft back, and `App` closes it if it was open.
- **`projects.json`** — attached projects and which was last selected. Own file, own lock. Paths canonicalized at attach time, or `/x/proj` and `/x/proj/` become two projects and split the sidebar's grouping.

The asymmetry is the point: appending to a private file is atomic, rewriting a shared one is not. **`cwd` on the index is authoritative on resume** — `send_msg` read it rather than trusting the caller's argument, since the project picker make the two able to disagree and resuming in the wrong directory is silent.

## Parser conventions

[parser.rs](apps/desktop/src-tauri/src/harness/claude_code/parser.rs) is the file most likely to need extending, and it has firm conventions:

- `ClaudeCodeEvent` = externally-tagged enum on `type`. `SystemEvent` and `ResultEvent` nest a **second** tag on `subtype`. Adding a new CLI event = adding a variant at the correct level.
- `stream_event.event` is fully modelled as `StreamFrame`. Every stream enum carry a `#[serde(other)]` catch-all so one unknown frame type doesn't cost the whole line.
- Genuinely volatile payloads (`message`, `usage`) stay `serde_json::Value`.
- Fields the CLI may omit need `#[serde(default)]`. CamelCase wire fields need an explicit rename.
- **A field the CLI may send as `null` need `null_as_default` as well as `default`.** The two are not the same and the difference is invisible until it bites: `default` answer for a key that is *absent* and do nothing for one present and null, which then fail against any non-`Option` type. `usage.iterations` was the captured case — a **synthetic** message (`model: "<synthetic>"`, the reply to a built-in slash command) send it as null, which failed the whole line, so every built-in command silently produced an empty turn. Nothing read the field, so it is no longer modelled and the parse no longer see it. Reach for `Option<T>` where absence is meaningful and `null_as_default` where it isn't.
- **Failures are swallowed per line and filed.** `read_stdout` log and continue, so a schema mismatch presents as a missing UI update, not an error. Every one lands in `~/.dray/parse_failures.jsonl` with the raw line. `stage` = `parse` (no variant matched), `map` (mapper errored), `unknown_subtype` (a catch-all arm caught it, so the line survived but we learned nothing), or `unsupported_request` (a control request we had to refuse to keep the turn moving — the only stage that changes what the agent does, so treat it as urgent). Read it after a session with `jq -r '.stage + " " + .detail' ~/.dray/parse_failures.jsonl | sort | uniq -c`.
- **A line worth no UI is still worth modelling, to keep that log a signal.** `tool_progress` is a 30s liveness ping and was a third of the whole failure file. Parsed and mapped to `None`. Apply the same reading to the next high-volume line that turns out to say nothing.
- `McpServer` and `ApprovalPolicy`/`PermissionMode` are defined once in `events` and re-exported. Don't reintroduce per-harness copies.

**Outbound lines are typed too** ([control.rs](apps/desktop/src-tauri/src/harness/claude_code/control.rs)) — `ControlRequest` tagged on `subtype`, `ControlLine` minting `request_id`. Typed despite nothing here failing at runtime, because a wrongly shaped request is not reported: the CLI answer what it recognises and stay quiet otherwise, so a drifted envelope presents as a control that silently stopped working.

## Test fixtures

Tests use `include_str!` against real captured CLI output under `harness/<name>/fixtures/`. To add coverage, capture real output, commit it, assert against it. Shapes absent from every fixture (Claude Code `thinking` blocks) get hand-written tests pinning the documented shape. Fixtures are a shared asset — a frontend test needing real wire output read the same file rather than committing a second capture.

- `complex.jsonl` — 176 lines with subagent/task traffic. Assertions hard-code exact counts, so editing it breaks tests by design.
- `interrupted_tools.jsonl` — `interrupt` landing mid-tool-call; the only capture with `thinking_tokens`.
- `background_bash_monitor.jsonl` — `Bash` with `run_in_background` plus `Monitor` (v2.1.247), both registering as `local_bash` with `result` landing while both are outstanding. What settled that tasks must not hold a turn.
- `permission_allow.jsonl`, `permission_deny.jsonl` — the same `touch` under `manual` with `--permission-prompt-tool stdio`. The only captures of inbound `control_request`, and what pin the field names the reply is built from. Note what the denied one *lacks*: no `permission_denied` line, because the question was answered.
- `builtin_command.jsonl` — the only capture of a **synthetic** assistant message, with `usage.iterations` sent as explicit `null`. Pins that a synthetic message still parses.
- `fast_mode_refused.jsonl` — two lines, not a session: the `system`/`notification` channel as captured, on the one key Dray reads. Two because the CLI says it once per *turn* it refuses, which is what the notice's clearing rule rests on.
- `compaction.jsonl` — the only capture of `compact_boundary`, of a `result` with null `stop_reason`, and of `isReplay`/`isSynthetic` user lines.
- `image_read.jsonl` — the only capture of an `image` block in a tool result and of the same bytes riding the `tool_use_result` sidecar as `file.base64`.
- `file_write.jsonl` — the only capture of a tool call whose arguments take real time to stream (60 fragments over 39.5s), and what pin the key ordering the streaming preview depends on. Read by `pnpm test`, not `cargo test`.
- `codex/fixtures/rollout.jsonl` — a session *replay* log, not live protocol. **Do not write the Codex parser against this.** `live_simple.jsonl` and `live_tools.jsonl` are real `codex exec --json` output and are what it must target.

The `github` fixture sits outside that tree at `src-tauri/src/fixtures/pr_graphql.json`: a real capture carrying a status context, two app-owned check runs, bot comments, a review with a body, two **bodyless review envelopes**, and four inline threads across three reviews. It pin both rollup shapes, null `reviewDecision`, the thread-to-review join, and an **avatar on every one**. A thread with an actual reply is absent, so that shape is hand-written beside it.

## Current state

Several things are deliberately unfinished — don't mistake them for bugs.

- **Session status is a state machine in `session.rs` and it follows the turn alone.** `StatusTracker`: send or `init` → `in_progress`; `result` → `completed`, whatever background tasks are outstanding. A background subagent runs past `result` and the CLI opens a promptless `init` later to report findings, which reopens `in_progress` on its own. Holding *was* the rule and it hung every session running a dev server or `Monitor`, all `local_bash`, none of which ever end. The task set is recorded beside status for two things only: `has_outstanding_work()` guarding child-replacing paths (effort respawn, update install) and the subagent panel's per-task stop — fork is **not** among them, since it replaces no child, and **Stop is not either**. The frontend keeps tasks in a live `tasksBySession` map, not off the log, since a task outlives its turn; `read_stdout` mints an empty `background_tasks_changed` when the child exits, emitted and **never logged** (it runs after delete removed the file, where an append would recreate it). `buildTranscript` takes live task ids and keeps a spawning call pending while its task lives, joining on `SubagentRun.taskId`, since `task_id` ≠ `tool_use_id`. **That same set is what *closes* a run, since `subagent_completed` cannot be relied on to.** It is `task_notification`, which only the child holding the task can send — so a child killed, respawned for an effort change or lost with the app takes every outstanding notification with it, and those runs shimmered in the panel with a Stop button on them for the rest of the session. A run whose task is gone from the live set is done once its spawning call has answered — a real result for a backgrounded `Bash`, the abandoned stand-in for anything the log leaves open — so the mark is applied after the abandoned marks, and a task the child still holds is untouched. **A panel full of running "Wait for…" rows is usually not that bug** (DRA-264): measured live, they were real `until grep …; do sleep; done` loops the agent had left polling for a log line that never landed, eight of them under one child — the CLI was naming them and the panel was right. So the panel has **Stop all** above two or more running tasks, and [system_prompt.md](apps/desktop/src-tauri/src/harness/claude_code/system_prompt.md) tells the agent a background Bash must end on its own. `completed` means finished *and unread*: the frontend clears it to `idle` on view, and a persisted `in_progress` resets to `idle` at startup. Status changes reach the frontend as `session_status` events — derived state, never written to the log.
- **The mapper is partial.** Wired: `assistant`, `user`, `result`, `system/init`, tasks, `background_tasks_changed`, `compact_boundary`, `permission_denied`, `can_use_tool`, stream frames. Still `None`: hooks, `post_turn_summary`, `task_updated`, `control_response`. `result.permission_denials` is unmapped, since every denial it lists already arrived as its own event. `status` is mapped for `compacting` and `requesting`. `SystemEvent` has a `#[serde(other)]` catch-all so an unknown subtype degrades rather than failing the line. `turn_id` is always `None`, deliberately: Claude Code has no turn identifier on the wire and minting our own would split what the reader sees as one exchange.
- **Compaction is two events from different lines.** `system/status` with `status: "compacting"` opens it; `system/compact_boundary` closes it. `status` is a general channel, so the mapper gates on value, not subtype. **The live protocol is snake_case here where the replay log under `~/.claude/projects` is camelCase** (`compact_metadata` vs `compactMetadata`) — writing this against the replay log fails silently. Every metadata field is `Option` so an unseen shape still *closes* the indicator; a parse failure there leaves it spinning forever. Compaction also leaves two user lines behind and neither is conversation — the summary flagged `isSynthetic`, the `/compact` echo flagged `isReplay` — and the mapper drops both.
- **Rate limit is only an event when it is bad news.** The CLI reports `rate_limit_event` on roughly every turn, so the mapper emits one only when `RateLimitInfo::is_noteworthy()` holds. The check is "not a known-good state" rather than a list of bad ones, so an unrecognized *or missing* status surfaces — but `HEALTHY_STATUSES` is what grows, and **only from capture**: it started at `allowed` alone, and `allowed_warning` (meaning the window is *approaching* full) then put "Usage limit reached" on screen during an ordinary turn. The wire's own strings are carried through rather than collapsed into a boolean. `resetsAt` is unix seconds where every other timestamp here is RFC3339.
- **Three payloads are emitted but never persisted.** `read_stdout` drops `Delta`, `UsageUpdate` and `ModelRequestStarted` before the log write. Deltas are superseded by the committed event; a usage update is a running counter whose final value lands on `turn_completed`; no `ModelRequestStarted` survives the process that made it, and it fires once per turn *and* once per tool result.
- **Context occupancy is stored nowhere.** The composer's ring reads it back out of the session's own events, since everything moving it is already persisted: `turn_completed.usage.contextWindow`, and `context_compacted.postTokens` for what compaction left. `used` and `max` are collected in one backward pass but independently, since a boundary reports what it kept and not how large the window is.

  **`result.usage` is a per-turn sum, not a context reading** — its counts are summed over every main-thread message, and an agentic turn re-reads the whole context once per tool call, so it reports context multiplied by the number of steps (401103 against a real occupancy of 41102). `Usage.per_model` carries the `modelUsage` map instead: session-cumulative and monotonic, so a turn's figure is the difference between consecutive readings. Persisted rather than deferred, because the log is append-only and the CLI's output is gone once the process exits. `modelUsage` stays `Value` in the parser and is read field-by-field in `map_model_usage`, since serde rejecting the whole `result` line over one changed field would strand the session on `in_progress`. **An unfamiliar shape must cost one field, never a line.**

  **Used is one message's four counts summed** (`input + cache_creation + cache_read + output`, disjoint slices of a single prompt), and *which* message is the whole subtlety: the turn's **last main-thread `assistant`**, tracked in `Mapper::last_occupancy`, with subagent messages skipped since they run their own context. A single-message turn hides the distinction completely, which is why a summing bug shipped despite `compaction.jsonl` agreeing with its own `pre_tokens`. **Max comes from that same map's `contextWindow`**, so no window is hardcoded per model; the mapper remembers `init`'s `model` to index it, since a subagent on a second model puts two entries in it. Compaction clears the tracked reading, so a zeroed `result` landing after a boundary can't carry a pre-compaction figure over the `post_tokens` just published.
- **Only *ranged* `Read` renders its code; a whole-file read has no expander at all.** That read is the agent pulling a file into context, not showing it to the reader, and its result is the file itself. A *failed* read still expands, since its error text is the only place the reason lives. A read of an image is the exception.
- **The PR panel reads and acts, never writes prose.** No commenting, no replying to a review, no requesting review, no closing.
- **Forks copy the conversation whole and record no lineage.** The CLI exposes no fork-at-message, and `fork_from` is cleared once the CLI carries the fork out, so nothing on disk says which session a fork came from.
- **Dray writes only status and priority**, from the opened issue's header — no comment, no attachment, no assignee, no label — and there is **no issue-side project mapping**, the connection being workspace-wide. The `dray` CLI writes nothing.
- **The handoff row has no Revert, Amend or Stash** — each destroys or rewrites work, and a button that sends a prompt for one is a button whose blast radius is decided by the model. No Push either, and that one went on width.
- **The repo view reads — no fetch, no pull, no discard.** The ahead count is against the *last known* upstream, so a branch someone else pushed to reads as level until the push itself fails.
- **Sidebar PR marks say open, draft or merged; checks say running or failing.** No number, no per-check detail, no merge readiness, nothing at all for passing.
- **Spawned sessions inherit permission mode, so most block immediately.** The default stance is `auto`, so a fanned-out session stops at its first `Write` waiting for a card nobody is next to. `dray new` takes no `--permission-mode`, and adding one raises a real question: an agent in a `plan` session spawning a `bypassPermissions` child is an escalation past the stance the user set. Clamping the child to be no more autonomous than the parent is the likely shape of the fix.
- **No reading a transcript back.** Create, list and send exist; reading what another session said does not, and a parent cannot learn a child finished except by polling `dray ls`.
- **TS event types are generated, not written.** `ts-rs` derives them into `src/types/events.ts`, checked in so the frontend build needs no Rust toolchain. `cargo test` regenerates; never edit the output. Two settings live in `src-tauri/.cargo/config.toml`: the export path, and `TS_RS_LARGE_INT = "number"`, because `u64` otherwise becomes `bigint`, which `JSON.parse` never produces.

## Subsystem notes

Detail per subsystem lives in [apps/desktop/docs/](apps/desktop/docs/). **Read the file before touching that area** — the rules there are as binding as these, and most record a failure that is silent.

- [fast-mode.md](apps/desktop/docs/fast-mode.md) — Fast mode per harness, the picker row, refusal notices.
- [git-and-models.md](apps/desktop/docs/git-and-models.md) — git/gh shelling, `-w` fork point, model lists per harness, effort ladder and its persistence.
- [pull-requests.md](apps/desktop/docs/pull-requests.md) — PR panel, `gh` GraphQL, readiness, polling, sidebar marks, prSync.
- [repo-and-files-views.md](apps/desktop/docs/repo-and-files-views.md) — Diff view tab and Files view: tree, viewer, tabs, open-in.
- [spaces.md](apps/desktop/docs/spaces.md) — Spaces: project tags, switching, notifications per space.
- [issues.md](apps/desktop/docs/issues.md) — Linear + GitHub issues: credentials, tags and links, caching, uploads, issues page.
- [file-opening.md](apps/desktop/docs/file-opening.md) — Open-in button, app detection, file links in the transcript.
- [transcription.md](apps/desktop/docs/transcription.md) — Local dictation: engine, models, capture, streaming decode, mute, UI.
- [handoff.md](apps/desktop/docs/handoff.md) — Handoff row above the composer: built-ins, custom buttons, `work_status`.
- [worktrees.md](apps/desktop/docs/worktrees.md) — Removing worktrees, unlocking, relocating sessions, settle kills the tree.
- [orchestration.md](apps/desktop/docs/orchestration.md) — `dray` CLI: socket, protocol versions, install/update, creating and relaying sessions, skills.
- [sidebar-and-crew.md](apps/desktop/docs/sidebar-and-crew.md) — Sidebar stages and nesting; the crew column beside a fan-out.
- [browser.md](apps/desktop/docs/browser.md) — CEF browser: download, profiles, tabs, discard, `dray browser`, recording.
- [forking.md](apps/desktop/docs/forking.md) — Lazy forks per harness, worktree forks, name resolution, log repointing.
- [releases.md](apps/desktop/docs/releases.md) — App updater, channels, manifests, R2, relaunch; changelog feed.
- [settings.md](apps/desktop/docs/settings.md) — Settings page, shortcuts registry, Accounts tab, ⌘W, theme rules.
- [analytics.md](apps/desktop/docs/analytics.md) — PostHog events, active_day, error reporting, install id, surveys, site analytics.
- [notifications.md](apps/desktop/docs/notifications.md) — Notice channels, PR-ready cards, rail marks, dock badge, desktop banner.
- [rendering-code.md](apps/desktop/docs/rendering-code.md) — Shiki/@pierre/diffs, WASM engine, worker pool, transcript backfill and paging.
- [composer.md](apps/desktop/docs/composer.md) — Composer: drafts, slash commands per harness, @file index, attachments, contenteditable editor.
- [harnesses.md](apps/desktop/docs/harnesses.md) — Codex, fx and grok: what runs, wire quirks, MCP, effort ladders, plan mode, todos.

## Known issues

Diagnosed defects, not yet fixed. Unlike _Current state_ above, these are broken rather than unbuilt. Delete an entry when you fix it.

- **"Check for Updates…" answers into a void when the sidebar is collapsed.** The verdict draws in `UpdateRow`, which lives inside `<aside>`. Fix = a surface not tied to the sidebar.
- **Quit from the Dock's context menu is unguarded.** It bypasses the menu bar, so the custom Quit item never sees it. Nothing in the Tauri API reaches it today.
- **A blocked install has no way to say when it unblocks.** It waits on any session being mid-turn but names none. That sentence sits in the button's tooltip, which is why the button carries `aria-disabled` and guards its own click instead of taking `disabled` — a disabled button fires no pointer events to open a tooltip.
- **Changing effort respawns the child**, since the CLI has no `set_effort` control request. Harmless today, as the respawn happens inside `send_msg`. Revisit when queued or mid-turn messages land.
- **A live background task defer that respawn silently**, since `has_outstanding_work()` guard every child-replacing path and a `local_bash` task never end on its own. The reader change effort or model, nothing happen, nothing say why. Stop used to be the way out by draining the set; it deliberately isn't any more (DRA-185), so the subagent panel's per-task stop is now the only one. Cure = saying so, not putting the fan-out back.
- **A permission request stranded by a child dying mid-run is unanswerable.** The pending map lives in `Session`, so an effort-change respawn leaves a card whose buttons error. Restart is fine, and the CLI re-asks on resume.
- **`requires_user_interaction` is parsed and only half honoured.** `AskUserQuestion` is the one shape this app draws a card for, matched by tool name; anything else carrying the flag still gets Allow/Deny.
- **A worktree session's first baseline is a guess, and the reflog holds the answer.** `base_ref_tree` resolves the fork point the way the CLI does, but the CLI fetches `origin/<default>` first, so an upstream commit landing in between is attributed to that turn. `git worktree add -B` writes a reflog entry naming the commit it actually used, readable lazily even after the agent commits. Take the newest "Created from"/"reset" entry, not the oldest.
- **Nothing handles a command that restarts or replaces a session.** The picker hides `clear`, `fast`, `model` and `rename` for this reason, but hiding is not solving: each is still reachable by typing it. `clear` starts a fresh conversation the index never heard of; `rename` retitles a session whose title this app owns; `model` and `fast` move the running child off what the composer displays. None come back on the wire in a form the app can reconcile. The fix is a way to notice a session was replaced and re-adopt it — the same machinery a `/clear` button would need. `commands_changed` is a related loose end: the CLI publishes it when available commands change, which would fix the restart-to-see-a-new-plugin caveat.
- **A hard kill mid-dictation leaves the output muted.** The record of what to restore lives in the process, so `SIGKILL`, a panic or a power cut get past `RunEvent::Exit`. Quit and window close are covered. The cure is durable state or a watchdog, neither of which a mute is worth today; unmuting by hand is the recovery.
- **A session forgets its fast pick after a send on a model with none.** The send records `fast` narrowed by `fastFor`, so the index says `false` and reopening the session restores the switch off — against the rule that the pick is one preference that survives a model with no faster tier. Cure = recording the pick as asked beside the clamped value, or restoring fast from prefs where the index's model has no fast mode.
- **A background subagent's report-back is a second `completed`**, so a session with one raises two "Done" notices.
- **The PR polls share one GitHub rate-limit budget with every agent in every session.** Sidebar marks ask `gh` once per repo every 30s, the panel polls again at 15s while anything is in flight — against a *per-user* budget that every agent's own `gh` call spends too. **GraphQL's budget is 5000 *points* an hour, charged on the shape asked for, not on what comes back**: nested `first`s multiply, so the panel query at `20 × 50 × 50` cost 11 points per read of a branch with *no PR at all*, and two Dray instances (release beside a `tauri dev`) on one open PR tab drained the hour on their own (DRA-247). It is two aliased connections now — five open, two settled, thirty threads of fifty replies — measured at 2 points; measure any change to a query with `rateLimit{cost}` before shipping it. A second shape remains: `gh pr create` answering "API rate limit already exceeded" while `gh api rate_limit` reports the primary limit untouched is the **secondary** limit, which has no reset timestamp to wait on, and the cure at the agent's end is exponential backoff, which is GitHub's own guidance.
