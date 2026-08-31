# CLAUDE.md

File give Claude Code (claude.ai/code) guidance for work with code in this repo.

## Working practices

**Product work = Linear issue, before first edit.** Feature, bug fix, UX change, refactor. Plan freely without one; create through Linear MCP before code land. Existing issue = use that one.

**Housekeeping take no issue.** CLAUDE.md, plan note, tooling config — thing changing how we work, not what ship. Issue there = noise.

**Minor update take no issue either.** Tooltip wording, copy tweak, one-line prompt change — issue there cost more to file than change take to make. Several small thing landing in one PR = one issue at most, never one each.

**Description over ~1000 character open with `## TLDR for human`, closed by `---`.** One line per thing worked on, even when only one. Shorter description need none — it already scan faster than its own summary.

**Status:** start → `In Progress`. After that, leave it — GitHub integration move issue to `In Review` on PR open and `Done` on merge, so setting either by hand = noise. **Exception: work pushed straight to `main`.** No PR = nothing for integration to read, so set `Done` yourself.

**PR carry issue id so Linear link itself.** Body (`Fixes DRA-123`) or branch name — integration read both. Worktree branch = `worktree-<name>` minted by CLI, so body = reliable slot. Id = what arm the whole status rule above; PR without one leave issue sitting `In Progress` forever.

**PR nobody need review carry `no-review` label.** Copy tweak, doc, prompt wording, config — label keep review bot off diff with nothing to find. Add at open (`gh pr create --label no-review`), since review fire on open. Anything touching behaviour = no label.

**Open PR as draft, then spawn Codex reviewer.** `dray new --harness codex --effort medium --from <this session's id>`, briefed with issue, change and PR url — push first, since `--from` carry committed work only. It report through `dray send`; you fix and push until nothing left, then mark ready. `no-review` PR skip both.

**One team, `Dray`. Prefix `DRA-`. Assign every issue to `yogesh`.**

Linear MCP not connected → say so, then carry on with the work. Tell reader at the end which issue still want creating, so it can be filed by hand.

**Don't commit unprompted.** Stage + describe change, then wait — even when finished and passing. Asked = approval for that commit only, not ones after. Same for `git push`, branches, anything rewriting history.

**Always write commit message with `caveman-commit` skill.** Invoke it, don't imitate — skill carry format and it can change under you. Every commit here, amend included.

**Comment sparingly.** ~10% of lines, only where code cannot speak for itself:

- Write _why_, not _what_. `// bump seq` on `self.seq += 1` = noise; "the session layer must number synthesized events through this same counter or seq develops gaps" = not noise.
- Good reasons: non-obvious wire-format fact, invariant future edit could silently break, why simpler-looking alternative rejected, deliberate omission.
- No restate type signature, no banner separators (`// ---- helpers ----`), no doc comment on every field of obvious struct.
- One dense sentence beat three-paragraph doc comment. Explanation needing paragraphs belong in this file or plan doc.

**Write plainly.** Everywhere — chat replies, comments, docs, commit messages, plan files.

- Write simple. No clutter.
- Short sentences.
- Active voice.
- No over-explain.
- No under-explain when detail matter.
- Skip fancy words. Technical terms fine when right word.
- Complex ideas no need complex sentences.
- Cut any word or sentence doing no work.

**Stay out of files being actively edited.** User say they work on something → review and advise, don't rewrite. `todo!()` or missing match arm = work in progress, not defect.

**`///` doc comments show on hover, so add one to every `pub fn` and any non-obvious private fn** — one line, same "why not what" bar. Skip trivial helpers/getters where name say all.

## What this is

`Dray` = Tauri 2 desktop app wrapping coding-agent CLIs in chat UI. Spawn `claude` binary as child process, speak stream-json over its stdin/stdout, parse each output line into typed Rust enum, forward to React frontend as Tauri event.

## Repo layout

pnpm workspace, two apps, no shared package yet.

```
apps/desktop/   the Tauri app — everything below this section describe it
apps/web/       marketing site: Next.js App Router, Tailwind 4, deploy Vercel
packages/       empty; first shared thing go here, not into either app
```

Root `package.json` carry **no dependencies** — name, `packageManager`, `pnpm --filter` aliases only. Keep it that way: dep at root install into root `node_modules`, which both apps resolve through, so version drift there show up as one app mysteriously working.

Two things repo-wide on purpose. Release pipeline = desktop's alone but live in root `.github/workflows`, so paths carry `apps/desktop/` prefix and `tauri-action` need `projectPath`. And `pnpm-lock.yaml` single for whole workspace, why `pnpm install` run at root and nowhere else.

`apps/web` share design language with app but **no code** — no build step reach across, no import cross line. Site static and Next's; app Vite's. First component genuinely wanted in both = reason to create `packages/ui`, nothing before.

## Design direction

Dray keep to one visual language — one radius scale, one yellow, filled buttons
carry shadow and chrome don't, shortcuts live in real tooltips and never on `title`.
Window is glass (macOS vibrancy) with body's fill the only hole in it, and the titlebar
row is what user drag window by.

**Rules, rejected alternatives and the reasoning all live in
[DESIGN.md](apps/desktop/DESIGN.md)** — read it before restyling anything, changing
window chrome, or reworking a panel, card, row or button. Two things there fail
*silently* and cost an afternoon each: vibrancy's `body` specificity, and window drag
needing both an explicit capability and `data-tauri-drag-region="deep"`.

## Commands

Use **pnpm**, not npm. `tauri.conf.json` hardcode `pnpm dev` / `pnpm build` as before-commands. Stale `package-lock.json` sit next to `pnpm-lock.yaml` — ignore it; `npm install` desync tree.

**Every app command run from its own package dir.** Workspace root hold no deps, only thin `pnpm --filter` aliases (`pnpm app`, `pnpm web`). Anything else — `cargo`, `vitest`, `tauri build` — want real cwd, because relative paths in `tauri.conf.json`, `.cargo/config.toml` and `install.sh` all resolve against it.

```bash
cd apps/desktop && pnpm tauri dev
```

That = real entry point — build and run Rust app, start Vite via `beforeDevCommand`. `pnpm tauri` = shim ([scripts/tauri.mjs](apps/desktop/scripts/tauri.mjs)) merging `tauri.dev.conf.json` into `dev` subcommand only, so dev app carry own name and icon and `build` untouched. Tauri CLI merge extra config only when named on command line, and pick up no dev-flavoured config on own — hence shim, not config convention.

**Shim also pick dev port, and it only side that can.** Vite and Tauri have to agree on one, and both start from here — so shim probe upward from 1420, hand winner to Vite as `DRAY_DEV_PORT` and to Tauri as second `--config` carrying `build.devUrl`. Merged in order, so port land over dev flavour. Busy 1420 was hard failure before, which = one worktree's dev build refusing to start because another's already running — ordinary case with several session open. `strictPort: true` **stay** on Vite side and should: port already known free, and Vite wandering off it leave Tauri loading URL nothing serve. Probe bind wildcard not `localhost`, since server holding only `[::1]` leave `127.0.0.1` free and one-family probe answer "yes" for port dev server then fail to take.

- `pnpm dev` — frontend only, port 1420 unless `DRAY_DEV_PORT` say otherwise (`strictPort: true`, so busy port = hard failure — nothing picking port for it here). `invoke` do nothing in plain browser, so only useful for pure-CSS/layout work.
- `pnpm build` — `tsc && vite build`. `pnpm tauri build` for bundled app.
- `cd apps/desktop/src-tauri && cargo test` — Rust tests (253: parser + mapper + event-model compatibility, plus git and file index). Single test: `cargo test parses_complex_fixture`.
- `cd apps/desktop/src-tauri && cargo check` — fast type check, no linking whole app.
- `pnpm test` — frontend tests (vitest, 244, node environment, no DOM). Scoped to pure logic where being wrong invisible on screen: [streaming.ts](apps/desktop/src/lib/streaming.ts), which read same committed fixtures Rust tests do rather than keep own captures; composer's caret arithmetic ([slash.ts](apps/desktop/src/lib/slash.ts), [mention.ts](apps/desktop/src/lib/mention.ts), [highlight.ts](apps/desktop/src/lib/highlight.ts)), where same string open picker or not depending only on cursor position; and [theme.ts](apps/desktop/src/lib/theme.ts)'s coercion, where wrong direction on unrecognised stored value flatten whole app with nothing on screen saying why. Components not tested — no DOM here.

## Architecture: the event pipeline

Messages flow one way out to CLI and one way back in; return path = what most Rust code exist to serve. Trace end to end:

1. **`useSessions`** ([useSessions.ts](apps/desktop/src/hooks/useSessions.ts)) call `invoke("send_msg", {...})` with camelCase keys (`sessionId`, `isNewSession`); Tauri map them onto snake_case params in [lib.rs](apps/desktop/src-tauri/src/lib.rs). Frontend mint session UUID with `crypto.randomUUID()` — Claude Code adopt id chosen by app, not other way round.
2. **`SessionManager`** ([session.rs](apps/desktop/src-tauri/src/session.rs)) own `Mutex<HashMap<String, Session>>`. On send: spawn process for new session, reuse live one when present, re-init from `--resume` when id known but process gone. New sessions written to index before spawn, so one failing to start still visible, and created `SessionIndexItem` returned to frontend — `Some` on creation, `None` on resume — so resolved worktree name and truncated title come from one source.
3. **`claude_code::init`** ([claude_code.rs](apps/desktop/src-tauri/src/harness/claude_code/claude_code.rs)) spawn `claude -p --input-format stream-json --output-format stream-json --verbose --include-partial-messages`, add `--session-id` for new sessions or `--resume` for existing, and `-w <name>` on creation for worktree session.
4. Two `tokio::spawn` tasks drain stdout and stderr. Each non-empty stdout line go through `parser::parse_line` → `Mapper::map` → `app.emit("agent_event", &agent_event)`, with copy pushed onto `Session.events` and appended to session's JSONL.
5. **`useSessions`** listen for `"agent_event"`, route deltas into `streamingContentBlock` and everything else onto session's `events`. `Chat.tsx` render both.

**Finding the binary.** [binpath.rs](apps/desktop/src-tauri/src/binpath.rs) resolve `claude` to absolute path, cached in `OnceLock`; both spawn sites go through it. Never go back to `Command::new("claude")` — bundled `.app` launched from Finder or Dock inherit launchd's `PATH` (`/usr/bin:/bin:/usr/sbin:/sbin`), which hold no `claude` however globally installed, so bare name work under `pnpm tauri dev` and fail in bundle with no events arriving at all. Resolution escalate by cost: inherited `PATH`, then known install dirs (`~/.local/bin`, `~/.claude/local`, `~/.bun/bin`, `~/.npm-global/bin`, Homebrew, globbed nvm version dirs), then `$SHELL -l -c 'command -v claude'`. `-l` load-bearing — without it zsh read `.zshrc` only and miss `PATH` exported from `.zprofile`. `git` need none of this: `/usr/bin/git` present under minimal `PATH`.

**Worktrees.** `claude -w <name>` put tree at `<project>/.claude/worktrees/<name>` on branch `worktree-<name>`. Child must spawn at **project root** — directory not existing yet can't be `chdir`ed into, and CLI create tree and move itself in after launch. So spawn dir and session's recorded `cwd` differ for worktree sessions, only latter point at tree.

## The normalized event model

Both harnesses map onto one vocabulary in [events/events.rs](apps/desktop/src-tauri/src/events/events.rs), so frontend and on-disk log never see raw wire format. Adding harness = writing one mapper.

Two rules whole design rest on:

- **`seq` = ordering key, not `ts`.** Most Claude Code lines have no timestamp. One counter per session, and events app synthesize itself (user's own prompt, which CLI never echo back) must be numbered through it too.
- **Deltas = preview; committed event win.** Claude Code send streamed deltas _and_ finished `assistant` event for same content, matched by `BlockRef`. Absent deltas = common case — Codex send none, Claude Code send none for subagent output — so consumers must render correctly without them. Hold for tool calls too, but join is not `BlockRef` — see _A tool call is drawn before its arguments arrive_ below.

Per-harness code live under `harness/<name>/` with deliberate seam: `parser.rs` (wire format → own typed events) and `mapper.rs` (those → `AgentEvent`). Wire-format change touch only parser; vocabulary change only mapper.

Module entry files named after their directory (`events/events.rs`, `harness/harness.rs`) not `mod.rs`, declared with `#[path]`. Only entry files need attribute.

Prompts travel other direction as single JSON line written to child's stdin ([session.rs](apps/desktop/src-tauri/src/session.rs)). Same pipe carry `control_request` lines, built in [control.rs](apps/desktop/src-tauri/src/harness/claude_code/control.rs) — `set_model` and `set_permission_mode` both switch running child in place, verified against CLI. `set_effort` not exist, and `effort` field on `set_model` accepted and ignored, so effort changes require respawn.

**`interrupt` stop turn, `stop_task` stop task, and neither do other's job.** Verified against v2.1.232: with turn already finished and background task outstanding, `interrupt` ack `{"still_queued":[]}` and leave task running, so session sit `in_progress` until task end on own. `stop_task` take `task_id` (not spawning `tool_use_id`) and drain set same millisecond, filing `task_updated` and `task_notification` with `status: "stopped"`. Work on `local_bash` and `local_agent` alike, and cascade — stopping agent kill shell it spawned. `not_found`/`not_running` also answer success, so double click cannot error, but wrong id therefore look exactly like success: only lifecycle events' `agent_id` carry right one. `interrupt` also take optional `reason` and `cancel_queued`, neither used yet.

So composer's Stop = **interrupt plus one `stop_task` per outstanding id**, fanned out in `SessionManager::interrupt`; `StatusTracker` hold ids not count for exactly this. Without fan-out, session held open by task alone had Stop that ack and change nothing. Per-task stop stay in subagent panel for narrower ask.

**What can change mid-session.** Control live only if CLI have control request for it; everything deciding _where_ agent run fixed at creation, and composer hide it once session exist. So model and permission mode apply in place, effort kill and resume, project/branch/worktree creation-time only. That rule keep `git checkout` from ever running under live child.

**Permission mode asymmetric**, two separate types hold two directions ([events.rs](apps/desktop/src-tauri/src/events/events.rs)). `ApprovalPolicy` = settable set `--permission-mode` accept; `PermissionMode` = what `system/init` report, which wider. Verified against v2.1.224 by passing each mode and reading init event back:

| passed                                                | reported  |
| ----------------------------------------------------- | --------- |
| `plan`, `acceptEdits`, `bypassPermissions`, `dontAsk` | itself    |
| `auto`                                                | `default` |
| `manual`                                              | `default` |

So `default` not "no flag passed" — it CLI's own name for stance `auto` and `manual` both resolve into, and it come back even when you set something else. `ApprovalPolicy` must therefore never regain `Default` variant, or unsettable mode reach flag.

Reported value = transcript data only: reach `Settings.approval_policy` on `SessionConfigured`, nothing read it back. Index item = what app store and display, written from user's own pick. Keep it that way — reconciling session state _from_ init event quietly fail, since `auto` and `manual` indistinguishable there.

**Permission mode only ask if `--permission-prompt-tool stdio` on spawn.** Literal `stdio` = special case, not tool name — `--help` document flag as taking MCP tool and don't mention this value at all. It what Agent SDK pass whenever `canUseTool` callback supplied, which how it was found. Without it CLI never ask: auto-deny anything needing approval and report `system`/`permission_denied`. That whole reason `manual` and `plan` looked broken — nothing wrong with modes, channel simply never opened.

With it on, held call arrive as `control_request`/`can_use_tool` — only line travelling _into_ app expecting answer, and CLI block its turn until `control_response` carrying that `request_id` come back. Silence not neutral; it stall session until CLI's own deadline. So [permissions.rs](apps/desktop/src-tauri/src/harness/claude_code/permissions.rs) exist to guarantee reply, and unmodelled control-request subtype refused from inside `read_stdout` rather than ignored. That also why read loop need write end: `Session.stdin` = `Arc<Mutex<ChildStdin>>` shared with it.

Reply double-wrap — outer `response` = control-protocol verdict, inner one = permission decision:

```json
{"type":"control_response","response":{"subtype":"success","request_id":"…",
 "response":{"behavior":"allow","updatedInput":{…},"toolUseID":"…",
             "updatedPermissions":[…]}}}
```

`deny` take `message` (returned to model as tool's error) and optional `interrupt` to end turn outright. Wrongly shaped reply ignored _silently_, so regression here present as hung turn, not error.

**Options user see are CLI's, not ours.** `permission_suggestions` carry pre-composed rules — allow this exact command, add this directory, switch to `acceptEdits` — and `build_options` turn each into button, bracketed by "Allow once" and "Deny". Two rules: suggestion whose effect can't be stated in label dropped rather than shown generically, and `suppress_always_allow_rule` remove standing-rule button entirely (CLI set it where rule it can compose broader than question).

Rule never leave Rust. `PermissionOption` carry id, label, behavior; frontend answer with id alone and backend resolve it back to update. Composing rule from anything UI hold put the one durable grant here on wrong side of seam.

**Permission request always main-thread, even when subagent asked.** `can_use_tool` carry `agent_id`, and putting it on event's `Subagent` envelope wrong twice over: subagent events filtered out of chat and rendered in panel, so card invisible while agent hang waiting on it, and `agent_id` = harness's own handle not spawning call's `tool_use_id` this app correlate subagents by.

**Card render outside turn stack**, below transcript beside background-task and compacting indicators, from `buildTranscript`'s `pendingAsks` — one list holding both consent request and question, since they share `requestId` space and retired by same `permission_decided`. Neither can be relied on to sit next to question: subagent's tool call file into panel, main-thread one collapse with its turn. That also why card carry command itself. Follow that neither `permission_requested` nor `questions_asked` in `RENDERS`: they draw no row inside turn, so counting one miscount collapse. Open request also suppress thinking indicator, like compaction do — agent wait on reader rather than work.

**Questionnaire = `<form>`, and that what read answers back.** [QuestionRequest](apps/desktop/src/components/chat/QuestionRequest.tsx) use shadcn's `questionnaire` (over `@shadcn/react`, zero runtime deps), one question at a time with Previous/Skip/Next/Send. Each item's `name` = question's own text, so `FormData` hand back map already keyed way CLI match — no second mapping to drift. `getAll` join multi-select into comma-separated string wire want, and free-text input take item's name only when it selected answer, so it land in same slot choice would. Nothing `required`: `QuestionnaireSkip` render only for optional question, and skipping = real answer here. Card narrower than transcript (`max-w-md`) and override component's `min-h-11` touch targets to `min-h-0` — those = mobile floor, and on one-word option they = most of row's height doing nothing. Free-text box **not** optional to render — CLI promise user one and tell model not to add "Other" option because of it. **Keyboard handling is form's own**, fire only when focus inside it: number pick or toggle option, arrows move, Enter confirm, ⌘/Ctrl-Enter submit; digit typed into free-text box stay text.

Two things arm it, neither optional. `items` must carry `choices` — numbers assigned from _that_ array, not from markup, so card built without it render no badges and answer no keys. And card **take focus on mount**, onto first choice not form: Enter only fire when event target = choice. Stealing focus defensible here and nowhere else in app — agent blocked until this answered.

**CLI can take question back, and `control_cancel_request` = how.** Call abandoned before anyone answer → request gone its side, so card left up have buttons that provably do nothing: reply for dead id ignored in silence, like every other wrongly-aimed `control_response`. Mapper drop entry from `pending_permissions` and mint `PermissionDecided { automatic: true }` — retire path already exist and both card and rail read it, where second route = second thing to keep in step. **No reply written**, since request not there to answer.

Line name **inbound** id, not one of ours, and version = what tell two apart: cancel carry v4 like CLI's own `can_use_tool`, `ControlLine::new` mint v7. Unknown id = ordinary not error — user pressing button race this, and both order end with no card.

**Permission request never written to log.** Join deltas and usage updates in emitted-but-not-persisted set, and its `PermissionDecided` emitted straight from `Session::respond_permission` with no write. Reason not volume: request can only be answered by child that asked, and no child survive restart — so persisted request come back as card whose buttons cannot work. Nothing lost, because tool call it belong to _is_ persisted and show outcome either way. `QuestionsAsked` dropped on same reasoning, harder — `AskUserQuestion` result CLI write carry both questions and answers.

**Tool call with no result only _pending_ while something could still produce one.** `buildTranscript` take `live` (session's `busy`) and file `ABANDONED` stand-in into `resultByCallId` for every call log leave open — which why one line fix every surface at once, since collapsed row, group header, and shimmer all read pending-ness from that map. Without it call caught mid-flight by quit shimmer forever, most visibly `AskUserQuestion`: it block harness until app answer, so it call most likely open when app go away, and its request not persisted so no card come back to answer it.

Liveness alone not enough — it property of _now_, and next send flip those rows back to shimmering. So `user_message` also abandon everything open before it: new prompt = proof previous turn will not finish what it started. Marks applied after walk and only where no real result exist, because background subagent can report back after turn that spawned it.

Work only because frontend keep loaded session in memory: `handleSelectSessionIndexItem` return early when session already in `sessions`, so re-selecting session with request in flight reuse live state instead of re-reading file. Change that to always refetch and open card disappear mid-flight, agent still blocked behind it.

**`AskUserQuestion` ride this same channel, and is not permission.** Arrive as ordinary `can_use_tool` with `requires_user_interaction: true`, and answer travel back inside _allow_: `updatedInput` = tool's own input with `answers` map added, keyed by each question's verbatim text. So call never in question — always may run — and allowing it with nothing filled in exactly what produce CLI's "The user did not answer the questions." That make Allow/Deny wrong two buttons, which why mapper branch on tool name into `QuestionsAsked` and `PendingRequest::for_questions` carry no options at all.

Other route dead end, worth knowing why: `request_user_dialog` exist as control-request subtype, but CLI only send one for kind host declared in `supportedDialogKinds` during `initialize` handshake, fail closed otherwise, and only kind CLI's own bridge declare = `refusal_fallback_prompt`.

Three answer shapes, all verified live against v2.1.226: option's **label** = answer (no option ids), multi-select answer = one **comma-separated string** not list, free text = any string at all. Question absent from map skipped, partial map honoured, which make Skip real answer not refusal. `answers` also why whole input echoed back untouched: CLI rebuild tool result from same object.

**Two denials, and they mean different things.** `PermissionRequested` → `PermissionDecided` = question user answered; `PermissionDenied` = `system`/`permission_denied`, call refused with no question possible. Durable cause of second = working-directory sandbox, which no answer channel can fix. `PermissionDecided` minted by app when it reply, since CLI's ack carry nothing. **Render as nothing at all** — exist to retire card. Settled request draw no row either way: approval visible in tool simply running, refusal in tool's own error. Event **not** persisted either, same reason request isn't: decision retire card, card cannot outlive child that asked, so replaying one on load answer question nothing on screen still ask.

**Tool call drawn before its arguments arrive.** `Write`'s arguments _are_ file, so committed `assistant` event row normally built from land only once whole content streamed — measured at **39.5s** on 396-line (12KB) file, nothing on screen for any of it, which read as finished turn not working one. Nothing new needed on wire to fix: `content_block_start` name tool at 0.0s and path land 1.4s in. Split = **header from stream, body from committed event** — half-arrived path just path, but half-arrived diff worse than none, so preview row never expand.

[streaming.ts](apps/desktop/src/lib/streaming.ts) read accumulated `input_json_delta` prefix rather than parse it, hold no state between frames, so dropped or reordered fragment cannot corrupt running parse. It O(n²) over stream and deliberately so; note in that file have sizes and what to do if multi-MB write ever make it matter. Two key-lookup strategies sit side by side there and difference load-bearing: **target keys field-keyed** (`file_path`, `command`, `pattern`…), because path = path on whatever tool carry it, which make them safe on MCP tool nobody enumerated — while **line-count key tool-keyed**, because `content` only mean _file_ content on tool that write one. `TodoWrite` carry `content` string inside every todo, and field-keying that counted first todo as `+1` added lines on call writing no file.

Order matter within target keys, since tool can hold two at once and first _complete_ key win. Bash send both `command` and `description`, and `description` = what committed row will never show. They don't race, twice over: `command` checked first when both landed, and it arrive first on wire (41 of 41 Bash calls across every fixture emit `command,…`). `description` cannot simply be dropped to settle it — it how subagent spawn name itself while far longer `prompt` still streaming.

**Preview retired on `tool_call_started`, not `block_stop`.** Stop land ~20ms later, drawing both rows for frame with preview shoved down by own replacement. Two matched on **tool_use id**, all they share: `tool_call_started` carry no `BlockRef`, because mapper build it from committed message not from stream. Both writes happen in one listener call, which React batch into single render. One swap _not_ seamless and left that way: subagent spawn preview as ordinary tool row and replaced by `SubagentRow`, since preview cannot know committed row render differently.

**Changes panel diff two snapshots, not working tree.** "What did this turn do" cannot be answered by `git diff`: that report everything uncommitted, including whatever already dirty before prompt. So `snapshot_tree` capture tree at send time, and panel diff that against turn's own **closing snapshot** once turn over — frozen onto `turn_completed.head` by `read_stdout` — or, while turn still run, against snapshot taken at read time. Freezing end of range as load-bearing as snapshotting start: with head left at "now", idle session kept absorbing whatever later touched same checkout, and session read hour later described all of it as own last turn. Frozen pair of trees also diff to one immutable answer, which what let `useChanges` treat that cache entry as final and never re-read it.

Snapshot = **temp-index `write-tree`**: copy repo's index to temp file, run `git add -A` against it through `GIT_INDEX_FILE`, `write-tree` result. Real index, working tree, and stash untouched, and copying rather than starting empty what keep it at ~18ms — copy carry git's stat cache, so unchanged files not re-hashed. `--git-path index` find it, not same as `.git/index` for worktree session. Blobs `add` write unreachable and routine `gc` collect them.

Three things fall out of comparing _content_ rather than replaying edits, each why transcript-derived alternative rejected: `Bash` invocation moving or formatting files show up, several `Edit`s to one file collapse into one diff, and commit made mid-turn invisible. `Edit` carry only fragment it replaced and `Write` never report what it overwrote, so no walk of turn's own tool calls can produce file-level before.

Cost of that choice: snapshot describe _tree_, not agent. Anything else writing to same checkout **while turn run** attributed to it — user in their editor, second session's overlapping turn, and least obviously **background subagent from previous turn**, which run past own `result`. Frozen head bound that window to turn itself, but inside window nothing can tell writers apart — inherent to sharing one checkout, and worktree sessions = real isolation for running sessions in parallel.

Baseline ride on `user_message.baseline` and closing head on `turn_completed.head`, so range per-turn, persisted, survive restart. `changeRange` pair newest baseline with newest head _after_ it — later close superseding earlier one what fold background subagent's report-back turn into range — and leave head open only while nothing closed turn, so turn that never closed (killed child) degrade to old diff-against-now rather than show nothing. **Only newest prompt's snapshot ever used**: snapshot cover whole working tree, so session-wide baseline attribute anything another session or user's editor changed since that prompt to this one. `None` ordinary — non-repo, or prompt logged before field existed — and panel read it as nothing to show, not error. **Worktree session's first prompt = exception**: tree not exist yet, so baseline come from `base_ref_tree` instead, which resolve fork point CLI about to use. Slightly approximate, since CLI fetch `origin/<default>` first and upstream commit landing in between read as this turn's work.

`useFileVersions` adopt cached value from inside its effect rather than only when key change: closing row before its read land tear down hook's `live` flag, so value reach module cache but not state — and on reopen fetch skipped for key already cached, leaving row on "Loading…" forever. Hover-prefetch tried here and removed: fetch ~20ms and never cost of opening row — highlighting was, and worker pool below = real fix.

**Closing pane and switching tabs hide, don't unmount.** Pane mount with session and stay mounted: closed = `hidden` aside, inactive tab sit in hidden `TabBody`. Unmounting what made panel feel uncached — data caches survived, but every reopen remounted every row and re-ran every Shiki pass. `active` prop = other half of that bargain: hidden `ChangesPanel` must not keep snapshotting working tree on every event, so `useChanges` pause reads while inactive and `active`'s place in effect deps what trigger catch-up read on reopen.

**Reads cached across mounts, and that correctness fix as much as speed one.** [useChanges](apps/desktop/src/hooks/useChanges.ts) hold change sets and file contents in module-level maps. Both keyed by **tree id**, which make cache safe to never invalidate: new snapshot = new key, so entry can only ever be stale by being unreachable. Eviction therefore size cap, not invalidation — and two caps differ on purpose. Change sets counted (12), but file contents **budgeted by bytes**: shared count cap of 12 meant any turn touching more files than that evicted own rows while they mounted, so cache looked absent exactly when it mattered.

Two identity rules keep refreshes cheap. Fresh read whose `base` and `head` match what on screen keep **old object** — diff = pure function of two trees, so matching ids mean identical answer, and holding identity what let `FileRow`'s `memo` stop re-render. That memo matter because panel re-render on every session event (its `revision` prop move with stream).

Two rules responsiveness rest on. Debounce apply **only to refreshes** — baseline with nothing cached read immediately. And read never blank view: previous result stay up while next fetched. Measured before this: ~200ms of git per two-file read plus 300ms debounce, paid again on every open.

**Two `cat-file` passes per file, not four spawns — split about memory, not speed.** Size probe plus read, per side, ~15ms each in process overhead alone. One `--batch` = single spawn, but its stdout drained whole, so 2GB file in tree read entirely into memory _before_ `MAX_BLOB` could reject it. `--batch-check` return headers only, so first pass bounded whatever tree hold and second ask only for sides under cap. Input NUL-delimited (`-z`) because rev embed path and path may contain newline. Both parsers always answer exactly as many entries as asked for: truncated stream must not slide new side into old one's slot, which render one file's contents under another's name.

**Every `git diff` here end in `--`.** Both ids validated hex, but git resolve bare argument as either rev or path, so working-tree file _named_ like sha — build caches do this — make command die with "ambiguous argument". Verified reproducible, covered by test.

**File icons = VS Code Material set, served not bundled.** `vscode-material-icons` map path to icon name (`.tsx` → `react_ts`, `.rs` → `rust`, anything unknown → `file`); 900-odd SVGs referenced by name at runtime, so no bundler can see them and Vite plugin in [vite.config.ts](apps/desktop/vite.config.ts) stage them into `public/file-icons`. That directory generated and gitignored — do not edit or commit it. Staging run **at config load**, not in `buildStart`: dev server started before directory existed serve 404 for every icon until restarted, which present as "the icons are broken" not "the server is stale". These full-colour brand marks, deliberate exception to monochrome chrome — colour make file's type readable before its name is.

`changes_since` return `head` it snapshotted and `file_change` take it back. Not redundancy: agent keep writing while panel open, and file list and diff taken from two different snapshots disagree about what file say. Contents fetched per file on expand, so turn touching thirty files cost thirty rows and nothing else. Side that binary or over 1MB withheld with reason rather than sent — `from_utf8_lossy` swap every invalid byte for U+FFFD and render confident diff of file that never existed.

**Filtering `cargo test` rewrite generated TS.** ts-rs regenerate `src/types/events.ts` from whatever export tests actually ran, so `cargo test git::` leave file holding _only_ git's types and break frontend build. Always follow filtered run with bare `cargo test`.

**Thinking block arrive empty, and that what made transcript look dead.** Claude Code stream `thinking_delta` frames carrying `thinking: ""` — committed block empty too, and `estimated_tokens` only thing in them that vary. So thinking block render nothing from open to commit, and three things failed at once on top: `Reasoning` return null on empty text, `streamingThinking` = `""` therefore falsy so no preview mounted, and `reasoning` still counted in `RENDERS`, which permanently suppressed working indicator for rest of that turn. One real session: 53 reasoning events, every one zero-length, gaps after tool call reaching **83.8s** of blank screen. Parser's hand-written thinking test pinned `"thinking":"hm"`, shape CLI do not produce — thinking blocks appear in no fixture, why nothing caught it.

**Failed turn draw harness's own sentence, never `stop_reason`.** User abort already suppressed (`aborted_streaming`, `aborted_tools` = reader's own Stop, reporting it back as failure = noise), which leave exactly one reason ever reaching screen: `stop_sequence`. That wire token say nothing to reader, and it was drawn _instead_ of `final_text` sitting beside it — which carry whole sentence, often with cure in it: "You've hit your session limit · resets 9:05pm", "Not logged in · Please run /login", "API Error: 529 Overloaded". `Turn failed` = fallback for errored turn carrying no text, and only that case.

Row take **no icon** and `wrap`. Icon = third thing on row saying "this went wrong" where sentence and red already do; `wrap` because `Notice` truncate by default and every one of these clip exactly where cure start.

**Harness send that sentence twice, and red row win.** Expired OAuth arrive as ordinary `assistant` text block _and_ on `final_text`, so every failed turn drew one line in white then same line in red. Builder drop block, not renderer skip it: three surface could draw it — expanded walk, collapsed view's standing `finalText`, and summary count — so taking event out of turn settle all three at once, where suppressing at draw time = same rule stated three time. `finalText` cleared with it and **no fallback to earlier message**: red row = what turn end on now.

Match written to under-match. Block must be turn's **last rendered row** (`lastWasAssistantText`, flag discount already keep) and its text **equal sentence whole**, never contain it — agent narrating error it recover from keep its words even when turn later fail with that wording inside them. `drawsFailure` = same predicate [EventRow](apps/desktop/src/components/chat/EventRow.tsx) draw on, exported from [transcript.ts](apps/desktop/src/lib/transcript.ts) rather than stated twice: aborted turn draw no red row, so dropping block there take agent's last words off screen with nothing standing in.

Rule live on transcript, not on harness. Codex today carry its sentence on `turn.error.message` alone and mint no message item for it, so nothing duplicate — but shape, not harness, decide, so Codex covered free if it ever send one.

**Working indicator driven by `model_request_started`, not by "this turn has drawn nothing yet".** That old rule could only ever describe turn's _first_ wait: after one row existed it false forever, and agentic turn mostly later gaps. `system/status` with `status: "requesting"` land within 30ms of every tool result and again at top of each turn, so it mark start of every blank stretch (~1s to first text block, 3s median for thinking one). `Working` in [useSessions.ts](apps/desktop/src/hooks/useSessions.ts) carry one thing, live token count off `usage_update.reasoningTokens` — only number thinking block emit. Two kinds of wait deliberately _not_ told apart: indicator's word picked at random and "Thinking" one of options, so naming wait change nothing on screen. State per-session and live nowhere else: both events driving it unpersisted, so cannot be rebuilt from log.

Three exits clear it, all needed: `block_start` that not thinking (text or tool call draw immediately), `turn_completed`, and any `session_status` off `in_progress` — last cover interrupt or dead child, which other two never see.

**Retry take indicator over, like compaction do.** `system`/`api_retry` = failed model request being tried again, one line per attempt, and it draw own row (`ApiRetryIndicator`) with working one suppressed: turn genuinely open and drawing nothing, so every working test pass — but agent not thinking, it waiting on retry. Matter more here than for compaction, since `max_retries` = 10 in every capture and real session reach 7, which = longest blank stretch turn have.

**Attempt count = message; cause = optional clause.** 90 of 154 capture carry `error_status: null` with `error: "unknown"`, so most retry name nothing. Mapper drop `unknown` on way in — that harness saying it have no cause, not cause called "unknown" — leaving one absence rather than two spelling of it. Only 529 `overloaded` and 500 `server_error` ever seen.

**Harness send no closing event**, so indicator clear on "`api_retry` = newest event" rather than named list of ender: retry that work = simply request going through, so anything else arriving = proof it did. `usage_update` skipped as one payload firing without meaning progress. Gated on `busy` like compaction, since `api_retry` at tail of log = exactly what session killed mid-retry leave forever.

**Git.** [git.rs](apps/desktop/src-tauri/src/git.rs) and [github.rs](apps/desktop/src-tauri/src/github.rs) only places app shell out to anything but `claude`. `checkout_branch` validate name against branches git just listed — no shell involved, so injection not risk, but name starting with `-` parse as flag. Run when user pick branch in composer, not at send: picker only thing moving working tree, so by spawn time repo already where session expect it. `dirty` re-read at pick time rather than reused from project's initial load, or edits made since silently skip confirm.

**`-w` worktree do not fork from checked-out branch.** CLI resolve repo's default branch, fetch `origin/<it>`, pass that to `git worktree add --no-track -B` — so fork point = `origin/main` regardless of what checked out, and depend on network state (failed fetch fall back to local `HEAD`). `worktree.baseRef: "head"` in settings switch this, but `-w` flag surface expose no base ref. Hence composer hide branch picker in worktree mode and show resolved base instead: offering branch there promise something CLI don't honour.

**Models.** [models/models.rs](apps/desktop/src-tauri/src/models/models.rs) single source for model list, effort levels, defaults; frontend build picker from `list_models` not hardcoded array. Ids bare aliases (`opus`, not dated name) so sessions follow latest model. Haiku have no effort levels — CLI tolerate `--effort` there and ignore it, so omitting it keep persisted value honest rather than avoid crash.

## Pull requests

**Session's PR = tab in right pane**, beside Changes and Subagents. [PrPanel](apps/desktop/src/components/PrPanel.tsx) render readiness, checks, comments and merge action; frame, tab row and mount-forever bargain all `RightPanel`'s.

**Which tab open = one line, and `null` what make it work.** `ade.panelTab` hold `PanelTab | null` and default **null** = "reader never picked". `activeTab` then = pick where pick still name tab this session draw, else derived default — PR when open one exist, Changes otherwise. Storing `"changes"` as initial value = whole of old bug: fresh install indistinguishable from reader who chose Changes, so open PR could never lead. Not written back either, so switching to PR-less session keep pick.

**Tab's place fixed, tab pane open onto not.** `tabOrder` put PR first wherever it drawn at all — merged, closed, draft, open, same slot. It once moved to end when PR stop being open, and that cost more than leading order buy: row reshuffle under cursor at moment reader look at what they just did, and ⌘⇧[ / ⌘⇧] step order they never learned. `defaultTab` still follow state (PR when open one exist, Changes otherwise), because that decide first look not where eye go back to.

**Pane opening itself pick tab too.** `usePullRequest`'s `onOpened` set `panelTab` to `"pr"` beside opening pane, and have to: `activeTab` honour standing pick over derived default, and pick written by **app**, not only by reader — `handleTogglePanel` store `"changes"` every time pane open onto turn that touch files. So opening alone land on Changes for anyone who ever press ⌘E, which everyone.

Binding on **`{` / `}`**, not on brackets: shift layout reach `key`, so ⌘⇧[ report as `{`. `useHotkey` grew `code` option (`BracketLeft`/`BracketRight`) for engines that report unshifted one instead — both route, since character alone one engine away from silently never firing and position alone put chord under different glyph on every non-US layout.

**⌘R re-read active tab**, through same `panelRefresh` the one tab-row button use — so chord mean "refresh this" and never name specific thing. Null on Subagents (nothing to fetch), and closed pane = no-op: refreshing something invisible = work with no way to see it land, and both panel hook pause read there anyway. Safe to take despite being webview's reload because `useHotkey` `preventDefault` every chord it match, **and** because app's custom menu carry no Reload item — macOS menu accelerator swallow key before webview ever see it, so menu item there would make binding silently dead. Button's `title` became real tooltip with it, since app put shortcut in tooltip and never on `title`.

**Hook live in `App`, not in panel.** Tab row need to know whether open PR exist *before* that tab ever shown, so ordering can't wait on panel fetching for itself. Follow that first read **not** gated on `active` — only poll is. One read per session selection, deduped by freshness window.

**Sidebar's mark draw tab while panel's own read still out.** Panel blank `prs` on session switch and `gh` take better part of second to answer, so tab simply absent for that window — and pane opened *onto* PR tab (notice card's button, `onOpened`) land on Changes and jump beat later. Mark already know branch have PR, so it stand in: `hasPrTab = prTabVisible(…) || (loading && mark)`. `loading` half load-bearing — once read answer, panel's own answer govern, so this can never leave tab drawn for branch panel found nothing on. Two look branch up differently (mark by index's remembered name, panel by git's observed HEAD) and window close either way. Marks hook therefore sit **above** `usePullRequest` in `App`, which also retire `prMarksRef` — ref existed only to reach past old ordering.

**`gh` not REST API, and that trade deliberate.** `gh` already hold user's auth, their enterprise host config, and token refresh we would otherwise own. Cost = feature absent where `gh` missing or logged out — both surface as one readable line in panel, never as error. Binary resolved through [binpath.rs](apps/desktop/src-tauri/src/binpath.rs) like `claude`, and for same reason. Resolver return `Option` here rather than falling back to bare name — missing `gh` = ordinary state to describe, not spawn error to report.

**One `gh api graphql` carry whole panel, and avatars = why it not `gh pr list --json`.** That was first version and carry every same field. What it cannot carry = pictures: rollup `gh` hand back have no image on it at all, and neither do its comment author — only login. And `github.com/<login>.png` **404 for exactly accounts that matter**, verified: `vercel` and ordinary user resolve, `devin-ai-integration` and `github-actions` don't, because GitHub App's real login end in `[bot]` and `gh` strip it. `mergeStateStatus` need no preview header there, checked against live API.

**GraphQL fail with 200 and zero exit.** Failed query answer `{"data":null,"errors":[…]}`, so exit code prove nothing — `read_prs` check `errors` first, or "could not resolve repository" read as branch having no PR.

**Repo slug = one extra call, cached per cwd for process.** GraphQL take owner and name as arguments where every `gh pr` subcommand work them out from directory. Remote don't move while app run, so `gh repo view --json nameWithOwner` pay once per checkout.

**Two wire shapes need flattening on way in:**

- **Rollup heterogeneous** — `StatusContext` name itself on `context`, report on `state`, carry own `avatarUrl`; `CheckRun` name itself on `name`, report on `status`+`conclusion`, and hide its image at `checkSuite.app.logoUrl`. Internally tagged on `__typename` with `#[serde(other)]`, so entry of kind we don't model cost one row not whole response. Running check have **null** conclusion (GraphQL) where `gh` sent empty string — reading either as terminal draw running check as finished.
- **Every connection's `nodes` nullable.** `Option` there load-bearing, not defensive: PR with no comments otherwise fail whole response.

Only **tip commit's** rollup asked for (`commits(last:1)`) — check reported against older commit describe code since pushed over.

**One branch can carry several PR, so backend answer with list.** Same fix opened against `main` and release branch, or stack where each PR's base = branch below it — both real. `gh pr view <branch>` collapse that to whichever it find first and say nothing about rest. Sorted open-first then newest: open PR = one being worked on whatever its age, so reopening old branch must not show PR already landed.

**Inline comment live in `reviewThreads` alone, and hang off review that left them.** Review's own `body` = top-level text only, so review that nothing but file comments come back empty — dropping empty envelope therefore hid its whole conversation. Join = `pullRequestReview{id}` on each thread comment against `id` on each review, only thing linking two. **Timeline stay list of things people did, not of every sentence they wrote**: thread on own row read as ordinary comment and say nothing about which pass over code produced it.

So empty review holding threads now **kept** — it only row naming who left them — and empty one holding nothing still dropped unless it approve. Thread whose review out of reach (beyond 50 we ask for) fall back to own row rather than vanish.

Two levels nest and both counted as **replies** — review's file comments and file comment's own answers alike. Number there answer "is there more inside", and second noun make reader learn vocabulary to read count. Sorting inside review = oldest first, and row itself sort on comment that **opened** thread — sort on last reply and settled thread jump to top every time someone answer it.

Thread carry two facts ordinary comment don't. `path:line` say where it hang — `line` **null** once code pushed over, so path stand alone there — and `threadLabel` draw filename only, full path on `title`. `resolved` = thread reader already settled, drawn as one muted word.

**Readiness = three overlapping fields read in one fixed order** ([pr.ts](apps/desktop/src/lib/pr.ts)). `state`, `mergeable`, `mergeStateStatus` all answer overlapping questions, and order is whole of logic: closed PR's merge state stale, conflict outrank failing check, and `UNKNOWN` mean GitHub have not worked it out rather than answer being no — GitHub compute mergeability lazily, so first read of fresh PR land there and next poll settle it. Any other order put "Ready to merge" above conflict, why this pure function with own tests rather than JSX conditionals.

**Poll while open PR on screen; `isSettling` pick rate, not whether.** Two rate: **15s** while something visibly in flight (pending check, unresolved mergeability), **60s** for open PR with nothing moving. Gating on `isSettling` alone was wrong in only window that matter — check that hasn't **registered** yet leave rollup empty, exactly like repo with no CI, so PR app just opened read as settled and poll zero time. Reader then had to hit refresh by hand to see check that started ten second after tab opened. Same reasoning `usePrMarks` gate its own poll on "any open PR" not "any check running": tighter read have nothing to watch during exactly window needing watching.

Both gated on `active` — hidden tab must not keep spawning `gh`, and settled PR cost one `gh` a minute only while it the tab being read. Pending check spin for this reason: it one row about to change on own, and poll driving it invisible otherwise. Answers cached per `cwd + branch` across mounts and counted fresh for 30s, because switching session change props and `gh` cost better part of second.

`active` read off **pick**, not off `activeTab` — that derive from this hook's own answer, so it not exist yet at call site. Unset pick count, since derived default = PR tab whenever open one exist. Two disagree in exactly one case: session whose only PR merged, where pick unset, default resolve to Changes, and this read true. Harmless — merged PR never settle, and poll gate on that too.

**PR appearing = turn ending, and nothing else could see it.** Poll gate on PR tab being visible **and** active, and `prTabVisible` hide tab exactly while answer "no PR" — so one state needing recheck = only one that could never self-heal, and PR created mid-session stayed invisible until reader switched away and back. Fix = refetch on **falling edge of `busy`** in `App`. Session id ride along in that ref, because `busy` = *selected* session's: switching from running session to idle one drop it with no turn having ended.

**And appearance open pane, once.** `usePullRequest` take `onOpened`, fired from inside `load` — only fetch know what *previous* answer was, and previous answer = whole guard. `before` read off cache ahead of write; callback fire only where it existed, held no open PR, and new one do. First read have no `before`, so opening app onto session that already have PR raise nothing. Key-guarded like every other write there: read landing after session switch must not pull pane open onto branch reader left.

**Every write refetch, and that not deferred optimism.** Merge close PR and move it down list, ready-for-review move it out of draft — each change more than field it name. Merge itself two-step: button arm confirm that replace it, same shape sidebar's delete use. Method live in button's own menu not in confirm, so confirm read as one sentence naming exactly what about to happen — and menu spell out what each method do to base's history, since this only irreversible choice on pane. Menu `align="end"` and `w-80`: button sit at pane's right edge so start-aligned menu open off window, and at default width each description ran five lines.

**And refetch reach past pane.** Panel's own list not only view of that branch — sidebar mark come from `usePrMarks`, separate read with **120s** window, so merged PR keep its green glyph for two minutes. `usePullRequest` take `onChanged`, fired after any successful write, and `App` hang `prMarks.refresh` off it. Unlike every other write in that hook it **not** key-guarded: repo-wide answer true of branch whether or not reader still looking at it. Callback rather than second `useEffect` on `prs`, since only write know it was write.

**Merge that fail checked against PR before being reported.** `gh pr merge` can fail with merge already through — post-merge step, lost connection — and reporting exit code alone tell reader their merge failed when it on `main`. `merge_pr` re-read `state` on any failure and answer `Ok` only where it come back `MERGED`; unverifiable merge stay failure it was reported as.

**No Close, and no `--delete-branch`.** Panel exist to get work landed; abandoning PR = decision with discussion attached, which happen on GitHub. Reopen stay, because PR closed there = one reader may well want back here. Delete-branch dropped for own reason: worktree session have its branch checked out, so `git branch -D` refuse it and cleanup fail after merge already landed.

**Branch name read first, rebuilt only as fallback.** `sessionBranch` in [pr.ts](apps/desktop/src/lib/pr.ts) take `observed` — `work_status.branch`, git's own reading of HEAD — and it win wherever session still have checkout of own. Everything else there = **guess made at creation**: worktree session's `worktree-<name>` minted by CLI, plain session's `branch` = whatever checked out on first send. Neither re-read, so `git checkout` inside tree leave both naming branch session no longer on, and PR tab fail **closed** on it: ask GitHub about branch holding no PR, get empty answer, hide itself. Silent, and looked exactly like PR detection being broken.

`observed` null = resting state not error — read per-session and land frame late, non-repo have no branch at all — so guess still cover that frame and every session leaving HEAD where CLI put it.

**`worktreeRemoved` = one case `observed` lose, and without it deleting tree still take PR tab away.** Relocated session's `cwd` = project root, checkout shared with every other session and with reader's own editor — so HEAD there answer "what this checkout on" (`main`, usually) and never "where this session's work land". Record win outright there, which why `relocate_session_to_project` set flag beside clearing `worktree_name`: keeping `branch` alone bought nothing while git's reading still outranked it. Sidebar kept working through whole bug because its call pass no `observed` at all — one symptom worth reading as "the two disagree about `observed`", not as marks and panel using different lookup.

One function, and `SessionHeader` take result as **prop** rather than compute own: header naming one branch while tab look up another = same disagreement in two places instead of one.

**Sidebar row still read guess**, deliberately. `useOpenPrs` = one `gh` per repo, and per-row branch read = one `git` spawn per row, exactly what that design exist to avoid. So session whose tree checked out elsewhere lose its sidebar mark while panel keep working. `git worktree list` answer whole repo in one spawn if this ever want fixing.

**Sidebar row carry PR mark, and it one `gh` per repo not per row.** [usePrMarks](apps/desktop/src/hooks/usePrMarks.ts) ask `pr_marks` once per **distinct repo** among visible sessions — `gh` cost better part of second, so spawn per row make sidebar most expensive thing in app. Backend's `QUERY_MARKS` carry `number headRefName isDraft` plus tip commit's rollup **state**, and `mergeable mergeStateStatus` on open half for [ready-to-merge notice](#notifications) — row itself draw none of that pair. Nothing else: row draw one glyph, so shipping fifty check contexts and review threads for every session = payload nobody read.

**Two aliased connection, not `states:[OPEN,MERGED]` in one.** Single connection spend one `first:100` budget across both, ordered by update — so repo merging briskly bury open PR nobody touched this week under hundred recent merge, and row lose mark that already work. Separate budget cost nothing: still one query, one spawn. Merged asked for because **settled branch = what tell reader session done and can be archived**; closed-without-merging deliberately not, that work abandoned not landed and row's own timestamp already say it. Both half capped at 100 — merged one falling past hundredth = session already dealt with, right way round. `Response<T>` too narrow for this (generic over *node* shape around one `pullRequests` field), so marks get own `MarksResponse`; errors checked before data there for same 200-with-errors reason.

**`PrMarkState` come from which connection answer, not from field on wire.** Connection *is* answer, and `state` field beside it = second copy free to disagree.

**One branch carry several PR, row draw one glyph — so pick = rule.** `pickPrMark` ([pr.ts](apps/desktop/src/lib/pr.ts)) rank open > draft > merged and take first within rank (each half arrive newest-updated first). Live work outrank record: branch whose first PR landed and whose follow-up open read as live, and only where **nothing** open do row say merged — precisely when "this landed, settle it" = useful thing to say. Grouped then picked in `usePrMarks`, not last-one-wins map build, or which glyph draw = whichever the two connections happen to concatenate last.

**Glyph table shared with panel** ([PrStateIcon](apps/desktop/src/components/PrStateIcon.tsx)) for `Avatar`'s reason — two copies of four-way table drift on exactly state nobody watching. GitHub's colour: purple merged, red closed, muted draft, emerald open. Panel draw all four, sidebar only two it ask for.

**Checks say two things and they land in two different places.** `PrChecksState` fold GitHub's five-way `StatusState` into three: `PENDING`/`EXPECTED` → `Running`, `FAILURE`/`ERROR` → `Failing`, everything else → `Clear`. Unrecognised word read as `Clear` — safe way round, since vocabulary GitHub add later show nothing rather than paint every row red. `EXPECTED` = required check not reported yet, so it wait not verdict. `ERROR` sit with `FAILURE`: check that couldn't run = one that hasn't passed, and telling them apart = panel's job not row's.

**Running take timestamp's slot; failing recolour PR glyph instead.** Two different questions, so two different marks. Running = dashed spinner in right slot, **ahead of orb** — order load-bearing: reader set agent going and transcript one click away, where CI report elsewhere on own schedule and row = only place that land. Orb beat timestamp for own reason: "last activity" = least useful thing to say about row with anything in flight. Spinner carry `mr-[3px]`, since 14px glyph flush right against orb's 20px box otherwise shift sideways row to row. Failing = existing glyph go red, because broken build = fact *about* that PR not another thing on row, and row have one slot for what state work in. Passing draw **nothing at all** — marking every green branch green second time make mark that *does* need reading harder to find, so `SUCCESS` and no-CI-at-all both reach reader as `Clear`.

Red only while PR still open or draft — merged one's checks = history and purple = what reader need from that row. Failing draft still go red: draft not asking to land, but broken one still have to be fixed before it can. And label carry it too (`prStateLabel` append "checks failing"), because red-green difference = one this palette can least afford to make load-bearing.

Field named `checks_state`, not `checks`: `PullRequest.checks` already = list of individual `PrCheck`, and `PrStateIcon` take both shape structurally.

**Poll gate on any open PR being on screen, not on any check running.** Tighter read is wrong one: check *start* few seconds after turn end, so at turn-end refresh nothing running to poll for and indicator never appear at all. 30s, looser than panel's 15s for same reason 120s window is. Sidebar of merged and PR-less session spawn nothing, and poll stop entirely once last PR land.

**`sessionHasPr` check `state === "OPEN"` explicitly** now marks carry merged too — branch whose PR landed and being worked again want Create PR back. `ahead_of_base` usually hide it there anyway, but two answer different question and folding them cost button in one case it wanted.

**Matching live in frontend, deliberately.** Backend answer *list* not map, because which branch session land on = frontend's own rule (`sessionBranch` rebuild worktree session's from its worktree name) and map built in Rust = second copy of it free to disagree.

**Asked for active list's repos only.** `showArchived` true → empty set, no call. Settled session = work reader already dealt with, so repo appearing nowhere but archived list = one nobody waiting to land. Marks already fetched still draw over there, since cache outlive the ask. `projectFilter` narrow it further for free.

Cache module-level per repo, fresh **120s** — longer than panel's 30s, because this feed mark rather than view being read. Refreshed on same turn-end edge panel use, so mark and pane land together. **Failed read change nothing — no row written, no stamp.** Both half load-bearing, and each was wrong once. Not writing keep last good mark on screen (blanking them = bug: `gh` blip empty repo reader looking at), same rule `usePullRequest` hold its own list by. Not stamping = other direction: reusing cached answer and stamping it fresh look harmless and isn't, because `refreshAfterWrite` clear stamps and bump generation **before** its forced read — that read carry *new* generation, so failure sail past guard and re-certify pre-merge answer write just invalidated. Sidebar then hold old glyph for whole window, and stale merged mark keep `anyOpen` false so poll that fix it never start.

Unstamped cost near nothing: stamp only gate `load(false)`, which run when visible repo **set** change — project switch, not render — and repo `gh` can't answer for cache no open PR so never polled either. Failure silent (no `gh`, not GitHub repo, logged out); undefined mean both "no PR" and "couldn't ask".

**Two refresh, and write need bigger one.** `refresh` force-read what **visible now** — right for turn-end edge, wrong for merge: write can land after reader filter mutated repo off screen, leaving its cached mark at pre-merge glyph *stamped inside window*, so coming back within two minute reuse it. Reopened PR reading as merged worse still, since that hold poll off too (poll gate on open PR existing). `refreshAfterWrite` drop **every** stamp then force-read visible — off-screen repo spawn no `gh`, just stop counting fresh, so `load(false)` already running on arriving at project pick up truth. Every repo not just changed one, because caller hold session **cwd** where this keyed by **repo root** (two differ for worktree session) and write rare enough that worst case = one extra `gh` on next project switch.

**Module `generation` counter what make that clear stick.** Read capture it on start and check before writing. Without it, read already in flight — issued *before* merge, for repo now off screen — land after and stamp its pre-merge answer fresh again, putting entry back exactly where clearing just took it from. Damaging half not stale row but **stamp**: it tell every later reader pre-merge answer current and suppress read that would correct it. Stale answer therefore dropped whole, not written unstamped — entry left as it was, and unstamped = next visit refetch.

**`inFlight` carry generation too, because "read running" ≠ "read will answer for me".** Non-forced `load` stand down behind running read; if that read issued *before* write it get discarded on landing, so caller who stood down leave **nothing** scheduled — entry it would have replaced sit on screen unstamped, and stale merged mark hold `anyOpen` off so no poll correct it either. Now generation mismatch defer like `force` do. Generation captured **after** waiting for slot, one capture feeding both guard and slot so what slot advertise and what guard enforce can't drift.

**Slot wait = loop, not one `await`.** More than one caller can queue behind same read (turn ending *and* merge landing while one out). Each captured **same** occupant, so on its settling both resume and both spawn `gh` — exact overlap slot exist to stop. Re-read slot each pass so second wait for first.

**Poll read only repos holding open PR**, not everything visible (`load`'s `only`). Forcing all meant directory `gh` can never answer for — not GitHub repo, logged out for that host — take failing spawn every 30s for as long as some *other* repo on screen had PR open. Repos joined into string key for effect dep, since fresh array identity each render would re-arm interval every render.

**Write's read get one retry; nothing else do.** It only read whose failure don't correct itself — it what turn merged mark back into open one after reopen, and merged mark **not polled**, so dropped `gh` there leave row wrong until turn end or project switch. Retry after 4s, targeting only paths still unstamped. Exactly one, and not folded into poll: repo `gh` can never answer for must not let rare write become standing spawn.

**Archived view draw no check spinner.** It ask for no repos, so its row draw from cache nothing will update. Stale glyph = accepted trade there; stale *spinner* not, since it animate claim that something happening **now** — PR whose check finished after archiving span forever.

**Two readers tell each other what they learned, and signal only — never data** ([prSync.ts](apps/desktop/src/lib/prSync.ts)). Marks read (repo, 120s, 30s poll) and panel read (branch, 30s, 15/60s poll only on tab) each held own cache with nothing joining them, so "Ready to merge" card landed on panel still saying checks not passing, or panel went green beside row still spinning. Now marks read diff each branch against previous answer (`sameMark`) and emit `branchChanged` carrying **repo and branch** — `feature` moving in one repo must not invalidate every repo's `feature`: panel drop stamp for that branch under every cwd in that repo (`inRepo`, root or worktree beneath it) and re-read at once where it the branch on screen — tab or no tab, since that the read card land on. Panel read emit `panelRead`, and marks side ask `markDisagrees` against mark it hold, forcing repo re-read where they differ. Neither can fill other: mark carry no checks list, and panel's per-check list ≠ backend's rollup fold, so `markDisagrees` compare checks *loosely* — wrong answer cost one `gh`, never a glyph. **Panel-triggered marks read echo nothing for the branch that triggered it** (`except`), and only that branch: telling panel back where two folds differ by construction = pair spawning `gh` at each other forever, while swallowing whole repo-wide answer left other branches' panel stamps fresh and wrong. First marks read compare nothing and say nothing. Panel reads overlap on purpose (poll, tab open, marks' signal) so per-key sequence (`latest`) let only newest write — older `gh` answer landing last otherwise undid the sync it was asked for. And `markDisagrees` sort panel's list newest-updated first before picking, since `pickPrMark` break ties by position and panel list by number where marks arrive by update; two open PR on one branch otherwise picked differently each side and every panel poll forced a marks read.

**Poll's `anyOpen` read over `repoPaths`, not over whole cached map.** `byRepo` = copy of module cache, holding every repo ever fetched — so project reader filtered away kept poll running for one they can't see: `gh` every 30s against visible repos, or in archived view no-op rescheduling itself forever.

## The repo view

**Main column have tabs now, and Chat = one of them.** [ViewTabs](apps/desktop/src/components/layout/ViewTabs.tsx) sit in header row between session name and `PanelToggle`; `VIEW_TABS` = set *and* order, so Terminal later = one array entry plus one body. Accelerator read off array position (⌘1, ⌘2), not stored per tab — reorder array and keys move with it. Bodies use `TabBody` from `RightPanel`, so transcript **hide, not unmount**: scroll position, follow pin and every highlighted diff survive flip.

**Tab per session, and not persisted.** `panelTab` = standing preference; this = working context for one session. Record keyed by session id in `App`, `?? "chat"` on read. Reopening app onto repo view for every session wrong more often than right.

**Composer hidden off Chat.** Other views not conversations, and composer under them send into session reader can't see. Safe to unmount because `useDraft`/`useAttachments` module-level already.

**Right panel's changes tab stay, and answer different question.** Panel = "what did this turn do", turn-scoped, beside transcript. View = whole repository. One follow turns, other follow branch.

**`head_tree` answer `None` for one thing only: not a repository.** Repo with **unborn** branch (`git init`, nothing committed) answer **empty tree** instead — honest baseline there, since with no commit behind it every file = addition. Folding it into `None` made real repo indistinguishable from plain directory and hid its file until first commit. Empty tree need no object in database: git know that id built in (verified by test diffing against it in fresh repo).

**And `null` alone still say two thing — "no repo" and "not asked yet".** View paint before first read land, so testing id alone announce every real repository as plain directory for frame or two. `useHeadTree` carry `settled` for that, and empty state wait on it.

**Uncommitted list = HEAD tree against live snapshot**, and that whole trick. `head_tree` = `rev-parse HEAD^{tree}`, paired with `changes_since(cwd, headTree, None)` which snapshot working tree to answer. Commit move HEAD → new tree id → cache key roll onto new baseline by itself. **Nothing invalidate anything** — same bargain frozen turn ranges already make.

**Commit SHA pass `is_tree_id` and every diff path take them unchanged.** ≤64 hex, so `git diff <sha> <sha> --` and `{sha}:{path}` cat-file rev work as-is — commit's own diff = `useChanges(cwd, commit.parent ?? EMPTY_TREE, commit.sha)`. Non-null head = frozen key = read once, cached forever. Root commit's `parent` = `None`, and `EMPTY_TREE` (`4b825dc…`) stand in, so first commit in history open like any other instead of being one row that can't.

**Log record framed on NUL, field on `%x1f`, body last.** `git log -z` separate *commits* with NUL — one byte message cannot carry. Fields = unit separator, and body **last** so `splitn(6)` let it hold anything, separator included. `%P` space-separated, first parent only: merge read as what it brought onto branch, not as everything both side ever did.

**View read, never write — and that not "not yet".** Conversation next door = where work get made and committed, so second place to write commit = second way to do thing reader already asking agent for. No checkbox, no message box, no push button, no discard.

Backend keep `commit_files` and `push_branch` anyway, registered and tested, and `commit.ts` keep checkbox arithmetic beside them. Deliberate: hard part of commit surface = *which* path go in (rename need both name, `--only` promise, literal pathspec), and that reasoning expensive to rediscover. **UI absent, capability parked.**

If it come back: commit = `add -A -- <paths>` then `commit -m … -- <paths>`, both `GIT_LITERAL_PATHSPECS=1`. `add` = what make untracked file committable at all (`commit -- <path>` refuse path git never heard of) and what record deletion. Pathspec on `commit` imply `--only`, so **anything staged for unchecked file stay staged and uncommitted** — pinned by test. Porcelain, not temp-index plumbing `snapshot_tree` use: this *meant* to move HEAD, and `commit-tree` leaving real index untouched make every just-committed file read as staged revert after. Checkbox set stored **inverted** (`unchecked`), so file agent write while view open arrive *in* commit like every other change.

**Live file list sort newest edit first; frozen one keep git's order.** Git list path alphabetically, so file just written sit wherever its name fall. `sort_by_recency` stat each path and sort descending — but **only when `head` = `None`**, since frozen range name *trees* and what file say on disk today have nothing to do with what it said then (both direction pinned by test). Deletion have no file left to stamp, so it sort bottom; tie break on path so refresh don't shuffle list.

**Face on commit come from email, because git carry no account.** Two route, certain first: GitHub's noreply address (`12345+login@users.noreply.github.com`) *contain* account id, so it resolve exactly — where guessing login from name would not, same 404 trap PR panel already document. Everything else = **Gravatar over SHA-256**, which `crypto.subtle` do, so no hashing dep come with it. `d=404` deliberate: missing account must fail request and leave initial standing, not cover it with generated pattern reading as real person. Both cached per address in module map (`useAvatar`), `null` cached too. `Avatar` shared with PR panel, since two copy drift on fallback and fallback = part actually seen.

**Diff in pane, and `diffStyle` = prop on same `DiffView`.** `@pierre/diffs` carry `diffStyle: "split" | "unified"` natively — split = library's own default and what anyone arriving from another git client expect. Toggle = prop change repainting same instance, **never re-tokenize**: layout client-side, worker pool cache keyed on text. Split must travel with `overflow: "scroll"` — library only wire two columns' scroll together when line can overflow. Prop rather than second component because highlighter gate = part easy to get wrong and must exist once. Pref = `ade.diffStyle`, one surface so `useLocalStorage` not singleton.

**Selected file derived, never stored.** `find(path) ?? files[0]` — file that stop being changed can't leave pane pointing at nothing, and first-by-position right here where turn panel refuse it: diff have own pane, so opening one hide nothing.

## Issues

**Surface say "issue", implementation say Linear, and only one row say both.** Vocabulary live in [issues/issues.rs](apps/desktop/src-tauri/src/issues/issues.rs), wire in [linear.rs](apps/desktop/src-tauri/src/issues/linear.rs). Second tracker = module plus variant on `IssueTracker`, not rename of every panel — which why `IssueRef` carry tracker even while there one. Word "Linear" reach reader in exactly two place: connect form, where it name what key being asked for, and failure Linear itself caused.

**Connection workspace-wide, no project ↔ team mapping.** Repo bound to nothing; picker and page read what connected user assigned. Mapping = thing to add when it earn itself, not thing to guess at now.

**Key live in `~/.dray/credentials.json` at `0600`, account cache in `settings.json`.** Two read together: credentials say whether key exist, settings say whose it is, and cached account with no key behind it read as **disconnected** — key *is* connection.

**Keychain tried first and retreated from, deliberately.** macOS tie grant to exact binary that asked, so every rebuild = new application to ACL and grant never stick — authorization dialog several times an hour on any machine where app being *built*. Signing with stable Developer ID settle it for shipped build and do nothing for anyone working on app. Cost of retreat worth stating: key readable by anything running as user, where keychain entry not. What make it tolerable = company it keep — `~/.dray` already `0700` and hold every transcript, which = every file agent read or wrote on this machine. Read-only tracker key not most sensitive thing in that directory by wide margin, and `gh`/`npm`/`aws` make same trade.

**Own file, not field on `settings.json`, for two reason that both bite.** Settings rewritten by every analytics toggle and read on launch path where parse failure fall back to defaults — which would silently *forget* key. And `get_settings` hand that struct to frontend, which credential must never ride along with.

**Mode ride the *create*, on temp file** — not set after write, not on final file after rename. `fs::write` create at process umask, so every other order leave window where key sit world-readable: chmod after write close wide window and leave narrow one, where `OpenOptions::mode` leave none at all, since file never exist at wider mode for single byte to be written into. `create_new` beside it because `mode` apply only to file this call create, and temp file left by crashed write could be somebody else's at whatever mode they chose. Pinned by test — failure silent otherwise, since world-readable key behave identically in every other respect.

Personal API key not OAuth, deliberately: Linear OAuth want client secret, secret want server to hold it, so that = drayhq.com work. Key path want neither. Connect form = where OAuth button land if that change.

**Connect live on issues page, disconnect in settings, and split not arbitrary.** Page = surface with nothing to show without key, so field that fix it belong there and empty state *is* form. Settings row draw only when something connected — row offering to connect thing reader never seen = row they cannot judge, and second form = second place for one slot. Two error sentence that name cure therefore point at page, never at dialog.

**Disconnect ask first**, arming confirm that replace button — same shape sidebar's delete and PR panel's merge use. Key not recoverable from here: taking it back mean finding Linear's own settings page and minting new one, which = long way to be sent by button pressed on way to somewhere else.

**Linear's mark drawn in exactly two place**, connect heading and settings row ([LinearIcon](apps/desktop/src/components/LinearIcon.tsx)) — same two place word "Linear" reach reader, and for same reason. `currentColor` not brand purple: both sit in row of muted chrome, and single saturated logo = loudest thing on surface whose job is to be quiet.

**Validated before saved.** Key stored untried = one reader find out about next time they open picker, by which point they left form and failure look like feature broken. `verify` also answer identity, which what row draw.

**Write to either side forget every cached issue.** `useIntegrations`' `connect`/`disconnect` call `forgetIssues()`, and it correctness not speed: every cached answer was read with old key, `not_connected` failure page's empty state drawn from included — so without it, connecting leave reader looking at form they just filled in.

**Tag carry title itself, and that why there no block underneath.** `#DRA-53 Add issue tracker integration` = whole shape, everywhere: picked from composer's `#` menu, typed by hand, or appended by CLI's `--issue` (`tag_text` in Rust, `issueTag` in [issue.ts](apps/desktop/src/lib/issue.ts), pinned both side). Title being *in text* = what make feature cheap — model read it, transcript paint it, and composer's overlay stay in register with textarea underneath because nothing painted that isn't really there.

First version appended "Linked issues" block after prompt and stripped it back off bubble. Both gone: block restated what tag already say, and strip = pattern match that fail silently the day block get reworded.

Description still not injected, and that separate call: agent have tracker's own MCP server and fetch what it want in shape it want, where description pasted in = wall of text at top of every prompt, stale moment somebody edit issue, and paid for again on every follow-up. Session may be started against three issue at once, so three tag beat three paragraph.

**Resolution best effort, always.** Unreachable Linear, revoked key, tag naming issue that not exist — all leave tag as text, record no link, say nothing. Send must never fail because issue tracker down: that make tracker dependency of typing.

**Best effort stop short of losing named issue.** Tag reader typed already *in* prompt, so unresolved one cost its title and nothing else. One arriving through `--issue` not: dropping it left model prompt with no mention of work at all, and **answered identically to success** — same test that earn protocol bump. So named issue that resolve to nothing get appended bare (`#DRA-53`) and linked bare, exactly as `dray issue link` write one. `wanted_tags` and `apply_tags` split out from read for this: what happen when nothing resolve = case worth pinning, and it one test process cannot reach by asking Linear.

**One tagging rule per side of bridge.** Everything app send tag in prompt *text* — composer picker being only route — so `send_msg` command pass empty issue list always. CLI's `--issue` = other caller and name them outright, because flag not prose. Both merge inside `expand_tags`, deduplicated, and named-not-in-text one get their `#ID Title` appended so both caller end at same shape.

**Tag in prose = mention, and mention link nothing.** `ExpandedTags` answer two list: `mentioned` = every issue prompt name, ride `user_message` event so tag draw as button; `linked` = what written onto session, and only caller naming issue outright put one there — `dray new --issue` and `dray issue link`, both CLI's. App name none: `send_msg` pass empty list always, and issues page start no session. Tag reader typed reach first list alone. Every `#DRA-53` used to link, so "this is unrelated to #DRA-53" filed session under DRA-53 forever — decision about what session about, taken from sentence saying opposite, with nothing on screen to see it happen. Split live in one struct so two question can't be answered by one list again.

**`dray issue link` write down what it given and ask tracker nothing.** Link = local record — this session about that work — so making it need reachable Linear and stored key meant it could fail for reason nothing to do with what it record. Caller = agent that just read issue through tracker's own MCP, so it hold title and url already; asking second system for what caller have in hand = round trip whose only contribution = way to fail. Hence `IssueInput { identifier, title?, url? }` on wire, and `--title`/`--url` on CLI.

Absent metadata = **ordinary, not error**: bare identifier still usable link. `tag_text` drop trailing space (`#DRA-53`), `issueUrl` read empty url as none so tag stay text rather than button opening nowhere. Both stated twice — Rust and [issue.ts](apps/desktop/src/lib/issue.ts) — same reason every other tag rule is.

**`--title` and `--url` describe one issue, so several identifier + either = refusal.** Applying one title to all, or silently to first, = wrong link reading exactly like right one.

**Session id optional, and `$DRAY_SESSION_ID` = why.** Claude Code's Bash guard refuse any command naming env var inside worktree-isolated session — `echo "$HOME"` run, `echo "$PATH"` and `echo "$DRAY_SESSION_ID"` both refused, so allowlist not variable-specific and no name CLI could pick survive. Every session `dray new` make = worktree one, so documented `dray issue link "$DRAY_SESSION_ID" DRA-53` refused before it spawn, **silently**: agent read refusal, carry on, issue never linked, Issue tab never appear. Guard = harness's, not ours ([tools.ts](apps/desktop/src/lib/tools.ts) only mute its red). What we own = instruction walking into it, so CLI resolve session itself off `parent_session_id()` and documented call carry no `$` at all.

**Shape tell session from issue, and two cannot collide.** Session id = uuid, five hyphen-separated group; identifier = letter-leading team key plus number, so two. `is_session_id` read it same way `is_stable_id` read Linear's. Positionals therefore **one `Vec`** split in one function, not `Option` positional ahead of variadic one — clap refuse that shape outright (`debug_assert`: non-required positional below required one), verified, and any workaround end with rule stated twice. Old `<session> <ISSUE>...` form still parse and must: it shipped, and agent holding older skill still emit it. Mistyped id fall through to identifier list and **app refuse it** (`"X is not an issue identifier"`) before anything written, so CLI need no second copy of identifier rule.

**No protocol bump.** `LinkIssues` wire shape untouched — CLI resolve id locally before building request — so old app + new CLI and reverse both behave identically. Bump rule ask whether default old side fall back to = detectable; here there no new field for old side to ignore. Skew that do exist = **new app prompt + old CLI**: `0.3.0` read `DRA-53` as session and die on clap usage error — loud, right direction, but usage error name no cure, so system prompt name `dray update` for it. **CLI version bumped to `0.3.1` and had to be**: `cli-v0.3.0` already tagged, and `install.sh` early-exit when installed version = newest tag, so unbumped fix reach nobody through `dray update`.

**Resolution still live, on other route.** `expand_tags` run in *app* on send and do read Linear, because `#DRA-53` in prose carry no title with it. So two route: prose resolved, CLI blind. `issues::link` and `link_issue` command existed as third route nothing took and were removed with it.

**v4 = `LinkIssues.identifiers` → `issues`.** Field renamed not extended, so two shape cannot be confused on wire: old app handed new one find no `identifiers` and refuse, which = loud failure wanted here.

**Tag shape stated twice and tested twice.** Rust `issue_tags`/`parse_identifier` decide what get *linked*; [issue.ts](apps/desktop/src/lib/issue.ts)'s `parseIdentifier` and `highlightSegments` decide what get *painted*. Neither can call other — one run before prompt sent, one after — so rule = team key plus number, `#` must open word, and bracketing punctuation (`(#DRA-53)`) count as opening it. Drift show as word coloured like address that link nothing, or reverse. `#fff` and markdown heading both stay prose, both direction pinned.

**Composer's placeholder name `#` only while connected.** Unconnected reader offered tag they cannot use learn app missing feature rather than that they haven't set one up. Picker itself need no such gate — it simply find nothing.

**Every user-facing string collected in [COPY-ISSUES.md](apps/desktop/COPY-ISSUES.md)**, grouped by surface with reason beside each. Reword there and here together, or doc become second copy free to disagree with screen.

**Tag in sent bubble = button, and link come from event not from text.** `issueUrl` look identifier up in `user_message.issues`, so what open = url tracker itself gave at send time. Tag whose issue never resolved — unreachable tracker, identifier that don't exist — stay coloured text rather than becoming link to nowhere. Tooltip name host off that url (`Open DRA-53 in linear.app`), so self-hosted tracker name itself.

**Upload live *in* description, and drawn there — not listed beside it.** Linear put both in description's markdown: image as `![](…)`, file as `[name](…)`, both pointing at `uploads.linear.app`. So there no attachment list to build — override `img` and `a` on that one `Markdown` and leave everything else exactly as it was, since ordinary link in issue = ordinary link and rewriting it take app's own link dialog off it.

**Upload sit behind same auth API do, which why webview cannot fetch either.** `<img src>` resolve to 401 and browser draw its own broken box — reading as "Dray cannot show this" rather than "this need key". `fetch_issue_asset` put key on that request and hand back `data:` URL; only then is there something `src` can point at. `csp: null` in tauri.conf, so `data:` need no scope entry.

**Scheme checked with host, and it half easiest to leave out.** Host check alone accept `http://uploads.linear.app/…`, and that request carry key in cleartext for anyone on path — description = text somebody else wrote, so right host over wrong scheme = one line of markdown away. Rejected not upgraded: rewriting URL somebody else supplied to make it acceptable = guess about what they meant, and Linear's own uploads are HTTPS.

**Host checked exactly, and that not defensive.** Description = text somebody else wrote, and it name URL this fetch get handed — so without check, issue could name any host and have app post credential to it. Compared on **parsed host**, never prefix: `uploads.linear.app.evil.test` pass `starts_with` and is not Linear. Stated twice (Rust `is_upload` decide where key go, [IssuePanel](apps/desktop/src/components/IssuePanel.tsx)'s copy decide what get drawn as asset), pinned on Rust side.

**Image open full size in transcript's own lightbox.** Earn its place here more than there: pane = third of window, so screenshot of screen unreadable at only width it can be given. **One image per lightbox**, not description's whole set — these spread through prose rather than gathered in row, so there no set arrow would step through.

**Image render as image, everything else as file card.** Card = icon, name, size, download glyph on hover — whole row = control, so glyph = hint about what click do not second target. Fallback one direction only: anything webview won't draw (unknown format, SVG, failed fetch) *become* card, since file somebody can download beat grey box. `onError` = second net under mime check, because mime can say `image/svg+xml` and still not render.

**Failed upload cached too, and only generation get it back.** Not caching one worse than it look — failed fetch retried on every render of description holding it, which = retry per keystroke in search box. But `null` kept forever = screenshot reconnect and Refresh both fail to recover, leaving reader pressing button that provably do nothing. So entry carry generation, and older one = miss.

**Size capped before body read, and body *streamed* to that cap.** `content_length` checked first so oversized file refused rather than read into memory then rejected — same reading `cat-file --batch-check` exist for on git side. But advertised length = courtesy: server may send none, or send one that lie, and `.bytes()` drain whole body into memory *before* anything could reject it. So chunk loop stop at cap, which = cap actually being enforced. Asset cached per URL across mount, `null` included: description re-render on every keystroke in search box, and each would otherwise re-download every screenshot in it.

**Panel read Linear's API with stored key. MCP nowhere near it.** Two channel answering two question and they never touch: key fill *this app's* screens (description, attachment, comment, status), MCP let *agent* read same issue in its own turn. That why connect form say MCP out loud — reader who set up one and not other otherwise find out from model working off one-line title.

**Panel row order = priority, identifier, status, title.** Same left-to-right issues page read in, so two surface scan alike. Priority lead because it one fixed-width mark and ragged left edge read as disorder; title last since it only part giving way to truncation. Priority drawn even before detail land (`none`), so row don't reflow when read arrive.

**Issues pane say "Details" where tab row would be (`heading`).** One thing in it and nothing to switch to, so row of one tab = control that cannot do anything and keycap beside it name chord stepping between one place and itself — but *empty* strip worse than either, reading as chrome that failed to load. So row keep height, lose control, say what pane is. Strip cannot simply collapse: it what clear titlebar, and without it pane's first row sit level with traffic lights on far side.

**And it lose its bottom rule.** That line separate row of *controls* from what they act on; over heading belonging to thing underneath it, it cut title off own body.

**⌘E only ever close there.** Nothing for it to reopen — row = what pick issue — so toggle that could open have to guess which one, and last pick rarely one wanted on way back. Closing = half with unambiguous meaning.

**Guard live on chord, not only on `handleTogglePanel`.** ⌘E bind **raw** `togglePanel` deliberately — `handleTogglePanel` pick tab on way open, right for button reader aimed at and wrong for chord that draw nothing. So guard put in that function alone = button honour it while chord sail past into pane not on screen. Same for ⌘1/⌘2: view tab row not drawn there, so switching invisible tab look like nothing happening then show up as wrong view on way back.

**Panel tab = `issue`, drawn immediately before Subagents, hidden with no link.** Rows drawn from session's own `IssueRef`s, so tab exist moment something link one and need no read to wait on; detail (description, status, comments) fetched per identifier and fill in. **Linking = agent's, through `dray issue link`** — system prompt tell it to, so tab appear when work actually get taken up, not when reader happen to type identifier. No link = no tab, and empty state name no cure for that reason. Description drawn here where PR panel deliberately leave PR body out, and difference = who wrote it: PR body = reader's own text restating diff beside it, issue description = somebody else's and whole reason tab exist.

**MCP = one sentence in connect form, and no check anywhere.** Key fill *Dray's* screens and give agent nothing; agent reading issue in full, or moving one, want Linear's MCP server. Said in empty state where somebody already setting this up, linked to Linear's own docs, and said **once**.

Live check existed and was removed. `mcp.rs` ran `claude mcp list`, cached per directory 5 min, and drew notice in issue panel — wrong place twice over: reader open that panel to read *issue*, not audit own tooling, and by time session tagged the moment to say it long past. Cost was better part of ten second per uncached read, for line that belong in setup. Whole module deleted; `git log` hold it if health check ever earn a surface of its own.

**Right pane hidden while page up, and preference kept.** `panelShown = panelOpen && !issuesOpen` — two different question, and folding them = bug: page fill main column, so pane left open beside it went on describing session reader had *left*, with nothing on screen saying whose changes and whose PR those were. Everything that draw or read read `panelShown`; `panelOpen` stay standing preference, so coming back restore pane as it was. ⌘E no-op there too — toggling thing not on screen flip preference reader cannot see effect of.

**Header name page while it up.** `SessionHeader` take `standIn`, and `App` pass `"Issues"`: page fill main column but = not session and never become one, so header otherwise sit at "New session" over list of issues — naming thing reader not looking at.

**Issues page = sidebar row under New task, main column view.** Not session, so opening it **keep selection** — session reader was in still there coming back, and page hidden not unmounted so its filters and scroll survive trip. Sidebar's *highlight* still go though (`selectedSessionId={issuesOpen ? null : …}`): column showing issues, so lit row name session nowhere on screen. Two different question, and folding them cost trip back. Row drawn whether or not tracker connected: page's own empty state = where connecting offered, and row that appear only after you found settings dialog can only be found by people who not need it.

**Page read, and clicking row open it in pane beside list.** Row opened tracker in browser first, and that = trip taken for something app already had: pane draw description, people, attachment and conversation off *same key* list was read with. Linear stay one click away — pane's own row carry button — but it second thing offered, not first. Dray still write to tracker nowhere at all: no status move, no comment, no attachment, and skill say so out loud, because agent assuming otherwise tell user their issue moved when nothing of sort happened.

**Pane describe whatever main column show, and that one rule cover both case.** Session on screen → session's panel; issues page → picked issue. Same `RightPanel` frame, one tab, `onTabChange` no-op — second panel component = second set of chrome to keep in step. Also *why* session's pane hidden on that page: left up it went on describing changes and PR belonging to work reader had left.

**Picked issue held as whole row, not identifier.** List already read every field header draw, so pane complete before own detail read land — same bargain session panel make with session's links. `useSessionIssues` serve both, since a page pick = one-element link list.

**Toggle drawn only once something open to close.** Nothing on that page can *open* pane — row do that — so toggle at rest = control with one dead state. ⌘E close pick for same reason, and ⌘R follow session rule: pane win where open, list otherwise.

**Every route to a session go through one helper.** `goToSession` in `App` close page then navigate, and chord, sidebar row, New Task, notice card and settle-then-follow all take it. Two sidebar button closed page and chord beside them did not, which made ⌘N and ⌘⇧↑/↓ read as **inert**: they moved selection under column still full of issues, and change only showed up on way back. Page itself left as it was — filter and scroll come back with it — so this navigation, not dismissal.

**No Start button, and removing it was the fix not the gap.** It create session, so it must name project — and page workspace-wide, so button either guess which repo work belong in or grow picker of own beside every row. Tagging with `#` in composer already start work against issue, from place that know which project it in.

**Two chip, everything else behind one control.** Assigned / Created = two question worth one press: what mine to do, what did I ask for. Team and project narrow *within* whichever chip on, so they sit in menu — more control across header = more thing to read past on every visit to change none of them. Team or project list with **one entry not offered at all**, and menu with neither **hidden outright**: filter whose only option = one you already have = control that cannot do anything, and this solo tool often pointed at single team. Trigger lit while anything on, so list narrowed on previous visit say so rather than read as empty workspace.

**Settled half = second read, asked for only on expand.** Done and Cancelled header always drawn and always start closed; opening either fire one `list_issues` with `settled: true`. `IssueQuery.settled` = which *half* to read, not flag widening single read — backend answer complement (`state.type` `in` vs `nin`), so page never pull whole workspace back to fill two group it drew collapsed. No load-more: one capped page, and cap named rather than paged. Header carry **no count until loaded** — zero there = claim, not blank, hence `loaded` on hook separate from `issues.length`. Priority sort skipped on that half: priority on closed issue = fact about decision already taken, and sorting by it bury thing that just landed.

**Grouped by state *kind*, not by state name.** Name = per-team prose ("Shipping", "In Review", "Icebox"), so grouping on it turn list spanning three team into dozen heading for what really same few state. Kind = fixed six-way vocabulary, which what make grouping stable across whole workspace. Order = In Progress, Triage, Todo, Backlog, Done, Cancelled, Other — order work move through, which also order attention should reach it in. Order *within* bucket left exactly as arrived, since backend already sorted by priority and re-sorting = second opinion on same question.

**Search bar carry no fill and no border, glyph instead.** It one control always in same place, so it need no edge to be found — and filled field above borderless list draw box round least interesting third of page. Magnifier do work border was doing: say "type here" without enclosing anything. Override need **`dark:bg-transparent` as well as `bg-transparent`** — base `Input` carry `dark:bg-input/30`, more specific rule, which win; plain override therefore read as removed in source while fill still on screen.

**Refresh sit far right, not among chip, and ⌘R reach it.** It act on whole page where chip narrow it, so in that row it read as third chip. Chord = same one right panel use and `App` pick between them (`issuesOpen` win, since page = what reader looking at). Page hand its `refresh` up through ref not state: handle re-made every hook run, and state there = render of whole app per keystroke in search box.

**Group gap = hair, not band.** Two collapsed header a row apart read as adrift, and `mb-4` between them left more space than either header occupy. Gap only have to say "different bucket".

**Status glyph on heading, never on row.** Row already gathered under heading that carry one, so second copy per row say what row's own position just said. Heading also carry **no fill** — tinted band across page draw box round quietest line on it — and group separated by gap instead.

**Priority glyph on every row including "none".** Glyph appearing on only some row shift every title beside it, and ragged left edge read as disorder not information. Linear draw no-priority as three flat dash for exactly this reason: column same width on every row, and *height* of bars = signal.

**Glyph set = Linear's own paths, redrawn** ([IssueStateIcon](apps/desktop/src/components/IssueStateIcon.tsx)). Two vocabulary reader arriving from tracker already know by shape — part-filled ring = progress, rising bars = priority — and lucide stand-in for either = second vocabulary to learn for no gain. Shape from **kind**, colour from **state's own** where caller have one (panel, picker); heading name kind, so it fall back to Linear's default per kind. Ring wedge computed from fraction rather than stroke-dasharray: dashed stroke read as dotted outline at 14px.

**Row's hover hint sit before project, avatar and date.** Nothing else on row say click leave app, so hint name it — and placed there it take its width from title, which truncate, so marks on right stay put instead of sliding sideways under cursor.

**Date = "Today", "Yesterday", then "Aug 23"** (`calendarDay`, [format.ts](apps/desktop/src/lib/format.ts)). Deliberately not `relativeTime` next to it: that count elapsed time, right for session that moved four minutes ago and wrong for issue — "20m" and "1d" invite arithmetic, and nobody reading backlog want to work out which afternoon "2d" was. Calendar day = unit tracker itself use. Year appended only past this year, and comparison count **midnights not hours**, so 11pm yesterday read as Yesterday at 1am.

**Debounce gate on there being text, not on there being cache to protect.** First version gated on both, which debounced nothing that matter: every keystroke make key nothing cached under, so every one take un-debounced path and fire own request — exact run debounce exist to collapse. 300ms here against picker's 200ms, since this = box whole phrase get typed into.

**Cache short-circuit must clear `loading` itself.** Only path that clear it without request having finished — cancelled read never reach own `finally`. Backspacing to already-cached query cancel in-flight read for longer one then short-circuit, so spinner turned forever with nothing behind it until some later read happened to end.

**One generation counter over every issue cache** ([issue.ts](apps/desktop/src/lib/issue.ts)). Bumped whenever answer to "who are we, what may we read" change — key connected, key disconnected, reader pressing Refresh. List, opened body and fetched upload each stamp entry with generation it was read under, and read that start under older one **refused rather than written**. Same counter `usePrMarks` keep, against same failure: clearing cache not enough on own, since read issued *before* clear land after it and put entry straight back — and damaging half not stale row but **stamp**, which tell every later reader answer current and suppress read that would correct it. Also `useSyncExternalStore`d, so hook holding answer read under old key re-read rather than sit on it until something remount it.

**Reads cached module-level, keyed on whole query, capped at 12.** Same bargain `useChanges` make: switching chip, opening page, coming back from session all hit cache, and 60s freshness window decide whether refetch run underneath. Failed read **change nothing** — no entry written, no stamp — so blip leave last good list on screen. `forgetIssues()` = one escape hatch, called from both integration write.

**Refresh forget, then bump — and bump alone must never gate cache.** `generation` re-arm effect; `forgetIssues()` beside it = what make read actually happen, since effect's rule = "fetch what not fresh". Counter only ever go up, so reading it as "don't use cache" left every later chip flip and every later visit to page refetching for rest of session.

**Opened issue cached separately, keyed by identifier, capped at 24.** List cache cannot serve it — one hold row, other hold whole body with description and comments — and two read on different rhythm, so second map beside first rather than second use of it. Cap higher because key = *one issue* not one whole query, so reader working through handful fill it faster. Without it panel re-downloaded description on every tab switch, every reselect, and every second visit to row on page: "reading the issue…" over text already read. Only identifier past freshness window asked for, so session tagged with three issues and two of them just read cost one request. `forgetIssues()` clear both map — key that changed make every cached answer meaningless whichever shape it in.

**Cached answer picked *during render*, not in effect.** `useEffect` run after paint, so state alone left one frame of previous issue's description under new issue's title — most visible on page, where picking row = key change and nothing else. Hence `Read` carry key it was built for and mismatch resolved off cache in render.

**`loading` stay "a read is out", unmasked by what already cached.** Every reader of it per-issue and each draw own body when it have one, so session holding one cached issue and one still arriving need it true — else second row read as unreadable rather than pending. Refresh **forget then bump**: effect's own rule = "fetch what not fresh", and dropping stamp what make that rule answer yes.

**Filters live in `useIssues`, not in view.** Default = assigned to me, unfinished, priority order. `IssuePriority` = enum not Linear's `0..4` integer, because `0` = *no* priority and ordering by wire number put least urgent issue at top of page. Sorted in Rust after read, since Linear order by `createdAt`/`updatedAt` and nothing else — API order asked for as tiebreak inside level. `IssueScope` = `Assigned`/`Created`/`All` and it what chip write; `assignee.isMe`/`creator.isMe` = filter Linear take, no user id lookup needed.

**`Issue` and `IssueDetail` separate types, not one with empty fields.** List query ask for no description and no comments; struct carrying them anyway hand panel issue whose body silently missing. Every field read out of `Value` field-by-field, `map_model_usage`'s reason: schema Linear extend must cost one absent field, never whole list failing to deserialize and leaving page empty.

**GraphQL fail with 200 and zero exit**, same trap `gh` document — `errors` checked before `data`, and auth failure recognised both by status *and* by sentence, since Linear report bad key as ordinary GraphQL error too.

**Issue looked up by team key and number, not by handing identifier to `issue(id:)`.** That argument = UUID; whether it also resolve human identifier = convenience nothing in schema promise. Filter on two halves exactly as precise and documented.

**Send answer with links as written, every path.** Created, live, queued, resumed — `--issue` expanded and recorded on all four, and frontend have no other way to learn what prompt just linked. Without it tag typed into existing session persisted in Rust and reached panel only on reselect or restart: Issue tab went on drawing old links while index on disk held new. Whole list not delta, for `link_session_issue`'s reason — re-tag *replace* entry, so what changed = not set caller could work out from its own request.

**Link matched on tracker id *or* identifier, within tracker — both directions.** Two writer put different things in `id`: resolved link carry Linear's UUID, blind one (`dray issue link`, or tag no key could resolve) carry identifier itself. Keyed on `id` alone, `DRA-53` linked blind and `DRA-53` resolved moment later = two row for one issue. Unlink already read it this way; link now match same.

**Detail read by UUID first, identifier as fallback.** Identifier not stable — issue moved to another team renumber, `DRA-53` become `ENG-12` — so lookup by recorded spelling answer "no such issue" for work very much still there. UUID survive move. Fallback not other way round because identifier = *only* thing blind link carry, so `id` that not UUID name nothing Linear-side and skipped rather than asked about (`is_stable_id`). Empty UUID answer fall through too.

**Link = copy, not pointer.** `IssueRef` hold identifier, title, url, tracker id — so sidebar and prompt need no network call, and row still draw with tracker unreachable. It go stale (retitled issue keep old words until panel read it back), which right way round. Re-tagging **replace** entry with same id rather than append, so stale title refresh instead of issue drawn twice.

**Unlink match tracker id *or* human identifier.** Two caller hold different things: panel have whole ref and pass id, person at CLI type `DRA-53`. Neither spelling collide — one = UUID.

**Fork inherit links; relayed message carry none.** Fork continue same conversation so it against same work. `dray send`'s prompt tag whatever its own text tag and must not re-aim session it arrive at.

**Protocol at v4.** v3 = `issues` and `LinkIssues`; v4 = that request's reshape, above.

**v3 bump for `issues` and `LinkIssues`.** Same test `from` earned bump on: old app ignoring `issues` start session against no issue, with no line in prompt saying what work about, and answer **identically to success**. Wrong work that look like right work = what earn bump.

## Opening the working directory

**Split button in right panel's tab row** ([OpenInButton](apps/desktop/src/components/OpenInButton.tsx)) hand session's `cwd` to installed app. Left half open in app reader picked last, chevron open menu to change it. Detection = [apps.rs](apps/desktop/src-tauri/src/apps.rs), macOS only — `open(1)`, `.app` bundle and `.icns` all one platform's, everything else answer empty list.

**Tab row, not Changes body, because directory belong to *session* not to one tab's answer about it.** Reader on PR tab wanting their editor otherwise go via Changes to find way there. Sit outside tab row's own logic: Refresh change meaning tab to tab and go entirely on Subagents, this don't. Both share one `ml-auto` group — Refresh absent on Subagents and button absent off a session, so whichever survive hold same edge. Absent on issues page, which show somebody else's issue and have no working directory of own.

**Detection = `read_dir` over known dirs, matched on bundle file name exactly.** `/Applications`, `/Applications/Utilities`, `/Applications/Setapp`, `/System/Applications`, `/System/Applications/Utilities`, `~/Applications`; first dir win, so machine-wide install outrank user's copy — order Launch Services itself prefer. **Exact, never substring**: `Cloudflare WARP.app` not `Warp.app`, and contains-check list it as terminal that then ignore directory handed to it. Both pinned by test against temp dir of fake bundles — `resolve` split from `detect` so order testable with nothing spawned.

**No `mdfind`.** Spotlight can be off or still indexing, and common case = app not installed at all — where per-app query = spawn answering nothing.

**Table = the guarantee, not `CFBundleDocumentTypes`.** Reading each found bundle for `public.folder` = wrong gate: `open -a` name app outright rather than asking Launch Services to rank handler, so it reach app declaring nothing — MacVim declare no folder type and open one fine. App absent from table cost one entry, never list.

**Address = bundle path, not bundle id.** `open -b` hand id to Launch Services, which pick whichever copy it indexed — second install of editor, or stale index, silently open wrong one. Path = what scan know, and what stored preference keyed by. Name no good either: two build of one editor differ by path alone.

**Icon = app's own, `CFBundleIconFile` → `.icns` → `sips` → `data:` PNG at 64px.** Two spawn per bundle, cached per path for process life; list itself re-scanned every call. Measured: 7 app, icons included, 0.17s cold. Full-colour brand mark = same exception file icons make. `None` ordinary (bundle keeping icon in asset catalog) and fall back to glyph.

**Kind = Editor / Terminal / Files, and Finder sit last.** "Open in Cursor" and "open in Ghostty" = different ask, and flat list of both read as one — so inset dotted rule between run, `PickerMenu`'s idiom, at `border-border/80` (opacity on token so it stay 8% black on light menu). Heading per kind rejected: more furniture than list they organise. Finder at end because it = entry every machine have; leading with it put least specific answer where eye land first.

**Menu pick, left half open, and split deliberate.** Menu entry that both reseat default *and* launch have no way to say "next time, this one" without launching something reader didn't ask for. So `select` and `open` separate in [useOpenApps](apps/desktop/src/hooks/useOpenApps.ts).

**Frontend hold last answer, trust none of it.** `load` ask Rust every time — read = handful of `read_dir` with icons cached Rust-side, so nothing worth a freshness window. Called on mount and on menu open; panel hide rather than unmount, so mount alone run once for life of app and editor installed after never appear. Menu opening = one moment list must be current. `list_open_apps` infallible on its side — `invoke` only reject when IPC itself broken, at which point nothing in app work — so no retry, no failed flag, no key. First version carried all three against that phantom.

**Failed launch reach reader, on button itself.** `open_in_app` answer `open`'s own sentence, only thing naming cure — bundle that moved, directory that gone. Button take alert glyph and destructive colour for 4s, sentence in tooltip **forced open** (Radix close tooltip on click, so red glyph with no sentence otherwise) and `text-wrap`, since truncating clip exactly where cure start. Tooltip `key`ed on failure state: flipping `open` between `true` and `undefined` swap controlled↔uncontrolled and Radix keep stale open state across it. **Word stay "Open"**: swapping label make failure read as different control.

**Pref = `ade.openWith`, global not per-session.** Which editor you use = fact about you, same standing preference `ade.diffStyle` is. Per session it would be learned again on every new session — where it least likely to be right.

**Border = `border-border dark:border-input`, matching `outline` button variant.** That = app's edge for bordered *control*; `--border` alone (10% white) = token for surface edge or rule, and `/60` on it multiply to 6% and vanish.

**Button draw nothing where no app detected.** Every mac have Finder, so empty list mean scan found nothing rather than reader missing an editor — no cure to name.

**Three surface, one link component.** [FileLink](apps/desktop/src/components/chat/FileLink.tsx) draw all of them: tool row's filename ([ToolCall](apps/desktop/src/components/chat/ToolCall.tsx)), reader's own `@mention`, and absolute path an agent write into sentence. Span with `role="link"`, never button or anchor, because tool row's copy sit *inside* row's expand button — second interactive element there = invalid markup and click toggle row instead. `stopPropagation` on click **and** on key what keep two apart.

**Fork record parent's cwd on every copied prompt, and that not optional.** Fork carry conversation into *different* tree — new worktree fork even fork from `origin/<default>`, so it hold different copy of same file, or not hold it at all. Mention resolved against fork's own cwd there silently open fork's copy, not one message named. `repoint_events` therefore set `user_message.cwd` beside repointing `session_id` and attachment path, same reason those exist. `get_or_insert`, not plain set: fork of fork keep *first* ancestor to record one, which = tree message actually written in. `None` = ordinary and mean "this session's own cwd", true for every message session log itself and for every prompt logged before field existed. Transcript = record everywhere else here — turn's baseline and closing tree both frozen — and this same rule.

**Mention resolve against session cwd, and cwd ride context.** `@src/lib/a.ts` = relative, so `absolutePath` in [filePath.ts](apps/desktop/src/lib/filePath.ts) join it onto [ChatCwdContext](apps/desktop/src/hooks/useChatCwd.ts)'s value. Context not prop: only reader = mention four component below `Chat`, and three between would carry string they never read — same bargain `WorkerPoolContext` make. No cwd = mention stay inert coloured text, same resting state unresolved issue tag have. Resolving against wherever app happen to run open *wrong* file, worse than opening none.

**Path in agent's prose = rehype pass, after sanitize and *before* harden.** `rehypeFilePaths` in [markdownPlugins.ts](apps/desktop/src/lib/markdownPlugins.ts) split text node and wrap each path in span carrying `FILE_PATH_CLASS`; `Markdown`'s `span` override turn marked one into `FileLink` and pass every other span through untouched. After sanitize or it strip what pass add; before harden or href already rewritten by time this could read one. Hand-written walk, not `unist-util-visit`: walk = twenty line, visitor = dependency, and splitting one node into several = case visitor make awkward.

**Href decoded before judged.** `[x](/Users/me/My%20Project/x.ts)` = only way to write path holding space as markdown link, since bare space there end href — so encoded form = shape to expect, and it name no file left as it is. Decode can smuggle nothing past `isFilePath`, which still run on result; malformed escape throw, and link nobody can decode still link.

**Markdown link whose href name file get *converted*, not descended into.** `[Footer.js](/Users/me/app/Footer.js)` = shape agent write most readily, and left alone it stay anchor — so click raise Streamdown's external-link confirmation for thing that not URL, then have nowhere to go. `anchorToFile` swap whole anchor for marked span, keeping anchor's own children so label agent wrote survive. Checked **before** `NOT_PROSE`, which still hold `a`: link that not converted left whole, so path sitting in real link's label stay plain — that text already belong to link, and nesting second one fire both on one click.

**Path ride `title`, not span's text.** Two not same thing: path found in prose = own label, converted link have label of its own. `title` = what reader want on hover either way, so it carry fact rather than smuggle one. Re-checked with `isFilePath` at render, since class = plain attribute and raw HTML in agent output can carry one.

**Converted link keep resting underline; every other file link underline on hover alone.** Second class (`FILE_LINK_CLASS`) carry that, and it not style preference: author *wrote* `[Footer.js](…)` as link, so it have to read as one and sit beside message's other link without looking half converted. `FileLink`'s `writtenAsLink` branch copy Streamdown's own anchor classes (`wrap-anywhere font-medium text-primary underline`) — no way to reach its link renderer from here, and matching neighbour = whole point of branch. Two class not one, because "is ours" and "was written as link" = two fact and only first decide whether thing open. Hover-only stay everywhere else: permanent underline through sentence read as correction, and in agent's prose it mark up every path mentioned.

**Second plugin list, not flag.** Which surface get this = part worth reading. Issue description and PR comment name path from somebody else's checkout, so link there offer to open file reader haven't got — `linkFilePaths` on `AssistantMessage` alone.

**Match rule written to under-match** ([findFilePaths](apps/desktop/src/lib/filePath.ts)). Path must *open* word — preceded by whitespace, opening bracket (`([{<`) or quote — hold two segment at least, and carry no `//`. Each half stop real failure: letter-then-slash rule keep `https://host/a/b` and `and/or` out, two-segment rule keep `/compact` out. `pre` and `a` skipped in walk — fence already drawn by highlighter and splitting its text break token, and Streamdown autolink bare URL so by then it element with path safely inside. Nothing ask whether file exist: read would be async on every message drawn, and `openFile` reveal as fallback so over-match cost dead click not error.

**Path holding space get dropped, not halved.** Scan stop at whitespace, so `/Users/me/My Project/a.ts` cut in half — and half = *real* path that can exist and open wrong directory, which worse than no link. Read run forward to **end of line**, not one word: path hold several space, and `/Users/me/My Project Sub/a.ts` put two plain word between break and slash that give it away. Line = bound, since path don't span one.

**"Whitespace" = same set both side, and mismatch there = whole bug back.** Match stop on `\s`; read forward resume on `[^\S\r\n]`, so tab and non-breaking space break path exactly as space do. ASCII space alone left `/Users/me/My<NBSP>Project/a.ts` halved — and `&nbsp;` in agent HTML make that ordinary input, not exotic one.

**Trailing `:12`, `:12:5`, `#L12` stripped before path judged.** App's own harness prompt ask for `file_path:line_number`, so that = commonest shape absolute path take in transcript — left on, link name file that not exist and click do nothing. `open -a` can't be handed line, so number stay prose. Strip run **after** punctuation strip, so `(/a/b.ts:12)` lose bracket first and locator second, and **before** `isFilePath`, so `/a:12` still refused rather than conjured into path.

**Word straight after break decide it wherever it can, and it can twice.** One holding slash = rest of this path, so match = truncation — hold however finished match look, which what catch `/Users/me/project.v2 source/a.ts`. One *opening* with slash = path of own, which tell `open /a/b now and see /c/d` from break.

**Only past that word do shape of match matter.** Match whose last segment hold dot stop read at one word; one without read to end of line. Without that stop, `Updated /a/b/x.ts and src/foo.ts` lose its link to relative path four word later. Dot = **guess** (`project.v2` = directory), so it only ever stop read early, never accept match outright — which what keep guess from deciding anything alone. Nothing here conclusive: `see /a/b and/or c` read as truncated and isn't, so that link lost — losing link = side to be wrong on.

**Transcript's filename link ride same launcher, own preference.** Row naming file draw filename as link; click hand it to editor picked in Settings, through same `open_in_app`. Second key (`ade.openFileWith`), **not** `ade.openWith`: that one hold whatever panel opened last, terminal and Finder included, so reader who last opened checkout in Ghostty find filename opening terminal — no answer to "show me this file". [openWith.ts](apps/desktop/src/lib/openWith.ts) hold both key, app-list cache both read, and `openFile` itself; hook next door consume it, so cache = one scan however many control mounted. Menu offer editor and Finder alone — one file handed to terminal answer nothing.

**Finder = default, and it *reveal*.** `open -a Finder` on source file hand Finder document it have no use for; selecting it in window = what picking Finder mean. Every failure land there too — bundle moved, editor refuse file, nothing detected — so worst this click do = what link did before setting existed. Transcript row have nowhere to put error sentence, so failure must be working link, never message. `pickFileOpener` therefore fall back to Finder not to first editor, unlike panel button next door: that button must open *something*, this one have quiet correct answer, and reseating on whichever editor lead table open wrong app in silence.

**Row = Settings' Integrations tab, disabled where it cannot apply.** Off macOS no detection at all; on macOS with no editor installed list = one entry, menu that cannot change anything. Both draw row disabled with sentence naming which, since that sentence = only place reason can be said. `null` app list = read not landed, disabled rather than guessed, same bargain analytics switch make. Copy say **chat**, not transcript: main column's own tab labelled Chat, and reader never meet second word for it.

## Handing work back

**Composer hide row of canned prompt behind itself.** [HandoffRow](apps/desktop/src/components/composer/HandoffRow.tsx) sit above composer card, clipped to sliver, open on hover. Buttons = Commit, Create PR, Run server. Mostly hand work *back*; Run server start work instead and sit here because bargain identical — click = prompt reader didn't type. Name predate that second kind and kept anyway: churning `HandoffRow`/`handoffActions`/`HandoffAction` through five file buy nothing doc comment can't say.

**Every button send prompt.** Click = reader typing "commit" without typing it, straight through `handleSendMsg`. So no confirm dialog and no error surface — agent write message with context it already have, and whatever go wrong report in transcript like any other tool failure. This a shortcut *into* conversation, not around it.

Cost of that worth naming: agent not deterministic. Commit might come back with different message style, or agent might run tests first. Every button here = **suggestion, not command**.

**Prompt = few word**, literally `"commit your changes"`, `"create a PR"`. Model know how to commit and whether branch have upstream better than sentence written here do — and longer prompt = spec competing with repo's own instruction, which firm about commit message. Pinned by test (≤5 words).

**Run server = one exception to that count, and test skip it by name.** `RUN_SERVER_PROMPT` ([runServer.ts](apps/desktop/src/lib/runServer.ts)) = `"start the dev server in the background"`, six word, and **"in the background" load-bearing**: bare "run server" make CLI run `pnpm dev` in *foreground* Bash, which block till that tool's timeout and take server down with it. Pinned in `runServer.test.ts` instead, and skipped by id — not dodged by leaving `hasSession` default, which read as covered while testing every button but one it miss.

**There was a second kind, and it went on width.** `push` ran `push_branch` direct — one correct implementation, nothing to decide — and owned both end of its own feedback since it report into no transcript: spinner on button, error banner above composer, forced `work_status` re-read to fix count it drew. Whole discriminated union on `HandoffAction` existed for that one button, and `useWorkStatus` exported `refresh` for it alone; both gone with it. Nothing out of reach — `create a PR` push on the way, and bare push = sentence anyone can type.

**Hidden, not contextual-visible, and that the whole shape.** Turn touching file = most turns, so row drawn on "there are changes" = row drawn always — exactly what make every other tool's commit button noise. Reverse hold too: finishing turn ≠ wanting to commit. Peek cost discoverability once and buy quiet every turn after.

**Hiding also what let Run server be offered unconditionally.** Nothing track whether server already up, and cheap signal — `tasksBySession` — answer "some background task live", not "this project's server up", so gating on it hide button through unrelated `Monitor` run. Real answer = config-and-detection feature deliberately dropped. On permanent display button ask question it cannot answer; behind sliver only somebody who went looking see it, and going looking = wanting it. Two cost accepted: with session open row never hide, so `handoffActions` returning `[]` near-dead and composer permanently carry 4px reserve.

**Which button exist = [handoff.ts](apps/desktop/src/lib/handoff.ts), pure and tested.** Dirty tree → Commit. Create PR hidden on default branch (PR against itself), where no remote resolve default branch, where branch **already have PR**, and where branch hold **nothing new**: level with base and clean tree = PR with no diff in it. Run server want session and nothing else, so it survive both of those and sit **last** — Commit sit where eye land, and third kind of action at head displace thing most often wanted. Nothing read `ahead` or `upstream` any more: those only ever answered "anything to push", and row stopped asking.

**Commit & push, Draft PR and Push all existed and were dropped, on width.** Composer `max-w-3xl` shrink with its column, so right panel open leave ~391px inside padding, where five labelled button = ~523px and four = ~411px. Zone `absolute w-fit` bound by nothing, so overrun don't clip — it draw **over right panel**. No removal put anything out of reach: committing leave clean tree, so Commit & push = two click one turn apart; draft and bare push both = sentence in composer, same bargain every button here already is. Row's standing budget now **three button** (~289px). Fourth want measuring, and see [DESIGN.md](apps/desktop/DESIGN.md) for why wrap and icon-only both rejected.

That last check read `ahead_of_base`, **not** `ahead`. Second one count against *upstream*, so branch pushed in full read zero — exact state branch in when its PR get opened. `ahead_of_base` count against remote-tracking base ref (`origin/<default>..HEAD`), since local `main` can be stale or absent in worktree. `None` = "couldn't tell" and count as something: `origin/HEAD` can be symref onto ref never fetched and `symbolic-ref` resolve it without checking, so over-offer (one wasted click) beat under-offer (action gone). Empty = resting state, and row hide entirely on it.

**`hasPr` come from sidebar's own per-repo read, not fourth git call.** `usePrMarks.prFor` already answer it for every visible row.

**One backend command, not three stitched.** `work_status` = `dirty` count, `branch`, `upstream`, `ahead`, `default_branch`, `ahead_of_base`. Superset of `sync_status` because every field answer same question — "what left to do with this work" — and reading them separately let row draw Commit from one snapshot beside Create PR from another. `upstream` and `ahead` now unread by the row and kept anyway — one command answering the whole question beat trimming it each time a button go. `default_branch` arrive **stripped of remote** (`main`, not `origin/main`), so "am I on default branch" = one comparison and not parsing rule free to drift. Infallible like `sync_status`: non-repo answer default, row read that as nothing to offer.

**Read on falling edge of turn, and on arriving at session. Nothing else.** Those two moment it can change from inside app. Between turns only reader in another window move tree, and polling for that = several `git` spawn a second to catch something rare. Row going one turn stale = the trade.

**Row live in `ChatInput` as `handoff` node**, like `toolbar` — so component keep owning layout and spacing, including that row's cut edge land on card's own top edge. Absent on new task: no session to send into.

## Deleting a worktree

**Nobody else clean these up, verified twice over.** Docs say sweep "never removes worktrees you create with `--worktree`", and that `-p` runs have no exit prompt so Claude don't clean up their worktrees at all — and `-p` = exactly how Dray spawn. So keep/remove dialog that live in CLI never fire here, and every worktree Dray create is Dray's to remove.

**Lock = required step, not defensive one.** Same docs say `-p` run "leaves the lock it took on each one at creation in place". Verified live against v2.1.239: after `claude -p --worktree` exit, tree still carry `locked claude session <name> (pid N start <date>)`, and `git worktree remove --force` refuse it outright — exit 128, "use 'remove -f -f' to override or unlock first". So [remove_worktree](apps/desktop/src-tauri/src/git.rs) unlock first, and that string = what pid check parse.

Pid = whole reason to read reason rather than unlock blind. Live pid mean some other session working in that directory *now*, and unlocking pull tree out from under it — so live lock = only thing that refuse this. `kill(pid, 0)` answer it (`libc`, one line in `Cargo.toml`), `EPERM` counting as alive since process owned by another user still hold that lock.

Order load-bearing at both end: unlock before remove because lock refuse it, `branch -D` after remove because git refuse branch some worktree still have checked out. Path guard sit ahead of all of it and key on **shape not index**: direct child of `<project>/.claude/worktrees/` or nothing, so empty worktree name resolving to project root can never reach a delete.

**Session survive, and CLI meet us there.** Removal rewrite index entry — `cwd` = `project_path`, `worktree_name` cleared — and `cwd` = load-bearing half, since `send_msg` read it off index rather than trust caller. Docs describe other half: CLI "resumes the session in the directory you launched Claude from" when worktree gone, "tells you the worktree is gone and clears the session's worktree binding". Transcript follow too — it recorded under session's cwd, and `--resume <id>` fall back to scanning every `~/.claude/projects` dir for `<id>.jsonl`, taking it when exactly one match. So transcript, log and everything in them survive; only directory go.

**`branch` stay and `worktree_removed` go on, and that keep PR tab alive.** Field hold `worktree-<name>` — branch CLI make and work land on, written by `SessionIndexItem::new` — not base it forked from. `sessionBranch` fall back to it when no worktree name, so relocated session still name own branch and PR tab still find own PR after tree and local branch both gone. Clearing it was first version and took tab away from every worktree session moment reader settled it, which exactly when PR most likely open. Second version kept field and still lost tab, because `sessionBranch` prefer observed HEAD — hence `worktree_removed`, flag saying "this session no longer have checkout of own", which decide which of two win. `#[serde(default)]` on it so entry predating field read as tree still there, right way round: session that genuinely own its directory must keep trusting its own HEAD. Tree settled *before* flag existed therefore need `backfill_removed_worktrees`, one startup pass recognising relocation by shape it leave — no worktree name, `cwd` back at project root, `branch` still carrying `worktree-` prefix only `SessionIndexItem::new` mint. Write only when something changed, so read on every launch after first. Frontend copy relocated field off returned item rather than restate them, since restating = how two drift.

**"Unpushed" mean no other ref hold it, not "no remote hold it".** First version counted `rev-list HEAD --not --remotes` and was wrong in plainest case: repo with no remote report its whole history at risk. Now `--not --exclude=<branch> --branches --remotes --tags`, which read as "commits only this branch hold". Two spelling traps, both fail silently to zero: `--exclude` apply to **next** ref-enumerating option only (so `--branches` lose own branch while `--remotes` stay whole, which what let pushed branch read as safe), and its glob relative to `refs/heads` — `--exclude=refs/heads/foo` match nothing.

Squash-merged PR still count, since its commits genuinely on no other ref whatever landed on `main`. CLI's own exit prompt have same blind spot. Over-warn = safe direction.

**Lock lookup canonicalize both side.** Git print real path, so tree under `/var/…` come back `/private/var/…` and plain `==` find no record — which read as "not locked", one wrong answer that function can give.

Two key, deliberately. ⌘G press **Skip**, keeping it non-destructive across whole stack — chord that usually navigate but sometimes delete directory = shape that burn someone once. ⌘D press **Delete**, and live on card not on stack: it must run same `confirm` button do, since "Deleted" state = card's own, and key reaching past it would delete worktree while card still sat there offering to. Both guard on `isNext`, so stack have exactly one target; ⌘D also guard on `idle` so repeat press can't land mid-flight.

And it only card that **stay after being pressed**: `phase` go `idle` → `working` → `done`, button become "Deleted" with check, Skip go. **Countdown = WAAPI `Animation`, not CSS class, and that a bug fix.** One object own both bar and dismissal, so still exactly one clock and store still hold no `setTimeout`. CSS version had **no single object to ask**: duration arrive as inline style, pause as `group-hover` rule, and between them hover leave bar visibly frozen while card go away moment cursor leave.

`element.animate()` fix it by construction. `pause()` freeze `currentTime` outright, `play()` pick it up there. `onfinish` fire only on real finish, so paused card cannot expire, and neither can one whose window occluded and animation throttled. `duration` change on `done` re-run effect, cancel old animation, mint 1.4s one — that how confirmation ride same clock.

Do **not** "fix" this by restarting on mouse-leave. Tried, wrong: hover mean reader still reading, not that they earned fresh window. `@keyframes notice-timer` and `.notice-timer` deleted with it.

Hover-pause drop in `done` and have to: past that press no target left to protect, and card waiting for mouse to leave read as stuck. `removeWorktree` return bool for this alone — failed delete already reach reader through error banner, so card leave rather than claim something that didn't happen.

**Already-gone tree ask nothing.** Disposition read *before* deciding whether to ask, so worktree deleted by hand tidy up silently. Same read make stale registration prune itself.

**Delete take tree with it, no second question.** Folded into `SessionManager::delete`, best-effort beside attachments, with one cost worth naming: failed removal there orphan tree with no UI left to retry from. `git worktree remove` by hand = recovery. Failing whole delete instead worse — session reader asked to be rid of would still be there.

## Orchestration

**One agent can fan work out into several sessions.** "Work through these 3 Linear issues" become three Dray sessions, each own worktree, each row in sidebar user can open, interrupt, delete like any other. Three commands: create, list, send.

**First inbound channel into app.** Every other command travel frontend → Rust; this one travel agent → Rust → frontend, so frontend learn about session from *event* rather than from return value of thing it called. That inversion = whole of what [orchestration.rs](apps/desktop/src-tauri/src/orchestration.rs) add. Work itself go through `SessionManager::send_msg` — same function composer reach, not parallel path — so session created this way not second kind of session.

**Three shipped pieces, one line of glue.** App serve unix socket; `dray` = standalone CLI in own crate; skill document it; and one line in [system_prompt.md](apps/desktop/src-tauri/src/harness/claude_code/system_prompt.md) name capability plus install command. Agent check for `dray`, install if missing, read skill, get on with it. **App install nothing** — it inform, agent do.

**CLI deliberately not part of app.** It have to run on linux later, where no Dray app exist at all. So `apps/cli` = own crate (package `dray`, reserved name), own `cli-v*` release tag, `curl -fsSL https://www.drayhq.com/install.sh | sh`. Links neither app nor tokio: one connect, one write, one read, exit — startup instant, which matter when caller = agent shelling out.

**`install.sh` resolve newest `cli-v*` tag itself, and `dray update` re-run it.** App cannot push CLI update — Tauri updater swap `.app` bundle only, and CLI not in it. So upgrade = re-running installer, which mean installer must not pin. `/releases/latest/download/` still unusable for reason pin existed: app and CLI publish into same repo, both non-prerelease, so that URL belong to whichever released last and app release there carry no `dray-*.tar.gz`. Instead ask releases API (`?per_page=100`) and take first `tag_name` starting `cli-v` — API answer newest-first, so no version sort, and `sort -V` not portable anyway. `DRAY_VERSION` stay as literal-tag override; `latest` spelled as request to resolve, not as tag.

**Failed resolution refuse, never fall back.** Rate-limited or unreachable API quietly installing something ancient = exact failure being removed, so die naming `DRAY_VERSION` and releases page. `per_page=100` = other escape hatch's reason: 100 app releases between two `cli-v*` ones and resolver find nothing, which that same line cover.

**`dray update` shell out to installer, not reimplement it.** Two copies of fetch-verify-swap drift on exactly step verifying what about to be executed. Set `DRAY_INSTALL_DIR` to dir `current_exe()` sit in, so upgrade land where install did rather than default back to `~/.local/bin`. Replacing running executable safe on unix — installer rename over path, running process keep inode it started from. Fetch script to temp file then `sh <file>`, **not** `curl … | sh`: pipefail not POSIX, so pipe report success when curl what failed.

**Version check split across the two halves, and split that way because each own one fact.** Running version = Rust's, off `CARGO_PKG_VERSION`; resolved tag = script's, and script = only place that resolve. Passing version *down* as `DRAY_CURRENT_VERSION` move fact Rust own into place holding other one; passing tag *up* want second script mode or second resolver, and second resolver = repo slug and tag prefix stated twice, drifting into wrong early exit — worst failure here, since it skip real upgrade in silence. So compare live in `install.sh` and `dray update --force` = simply not setting variable (and `env_remove` it, or exported value beat flag). Check sit **inside resolve branch alone**, so `DRAY_VERSION` stay what it was: forced install of that tag, downgrade included. Refusal on resolution failure untouched and sit above check — unreachable API still `die`, never install something ancient. Installer too old to know variable ignore it and install unconditionally = exactly old behaviour, so stale deploy cost one wasted download, never skipped upgrade. Early exit still run `dray skill install`, or stopping early become one route leaving deleted skill in place — chain in _Skill freshness_ below rest on `dray update` rewriting it every time.

**Mismatch error name cure, and which cure depend on direction.** `envelope.v < PROTOCOL_VERSION` = CLI behind, say `dray update`; `>` = app behind, say update app. Naming wrong half worse than naming neither — reader run command that cannot fix what they have. Skill document `update` for same reason, pinned by test: whole point of naming command = agent reading refusal can self-heal.

**`prerelease: false` hard-coded in [release-cli.yml](.github/workflows/release-cli.yml) = what keep resolver honest.** Resolver take newest `cli-v*` tag without reading flag, so prerelease CLI would go to everyone re-running installer. Beta channel = moment to teach resolver about flag, not before.

**Wire types live in third crate, and that the point of split.** `crates/dray-proto` compiled into both side, so request shape cannot drift. Drifted shape here fail way [control.rs](apps/desktop/src-tauri/src/harness/claude_code/control.rs) warn about — no error, command simply stop working. No root Cargo workspace and this add none: `src-tauri` have own `.cargo/config.toml` carrying ts-rs export path, and workspace move target dir out from under it. Path dep work fine between separate cargo project.

**Unix socket, not HTTP port.** `~/.dray/dray.sock` — nothing on network reach it at all, no port to pick, collide on, or accidentally expose. Stale socket unlinked at bind: socket file outlive process that made it, so crash leave one behind and bind fail "address in use".

**Dev build listen on `dray-dev.sock`, and that what make unlinking safe.** One path for both build mean whichever start last own channel: `bind` unlink other's socket, so release app left behind keep listener no `dray` ever reach again, and reader have to quit and restart it — every time they run `pnpm tauri dev`, which while building this app = all day. Silent both way, since neither app read socket it no longer own. `tauri::is_dev()` pick name (`dray_proto::socket_path`), same call notification path already branch on.

**Child get `DRAY_ENDPOINT` injected, not left to CLI's default.** CLI resolve release socket, rightly — `dray` typed in terminal mean app reader installed — so dev app's own agent would file its session into release app's sidebar. Endpoint = one value already ([above](#orchestration)), so this = one `.env` beside `DRAY_SESSION_ID` and nothing above it change.

Two build now run side by side and **share `~/.dray`** — same index, same session logs. `INDEX_LOCK` = in-process mutex, so cross-process write = last-writer-wins on whole file. Not split, deliberately: separate dev store hide exactly session reader testing against. Live with it or split store, don't add file lock for it.

**And older build don't merely lose write, it downgrade schema.** Index rewritten whole, so build reading it round-trip every entry through *its own* struct and drop silently every field it cannot represent. Measured: released 0.8.2 open beside dev build erased `thread_id` from every Codex session moment after `thread/start` wrote it, and resume then answer "this session has no Codex thread to resume" for work still perfectly alive — 214 entry on disk, all carrying exactly 0.8.2's nineteen key. File lock fix none of this: serialized write drop field just as thoroughly. `SessionIndexItem.unknown` (`#[serde(flatten)]`) = what actually fix it, by carrying unknown key through untouched. It protect only version carrying it, so it go in **before** field it save, never after — and running released app beside dev one stay a thing to avoid until every shipped build have it.

**Unknown *variant* = different failure, and flatten cover none of it.** `unknown` catch key this build never heard of; value it cannot spell fail serde outright, and index parse as one `Vec`, so failed value fail line and line = whole file. Measured: dev build write `"harness":"pi"`, released app answer ``unknown variant `pi``` and read 256 real session as **none** — sidebar empty, every chat gone. Three field on `SessionIndexItem` carry that hazard: `harness`, `permission_mode`, `status`.

**`Harness` fixed by carrying spelling, and that only work because nothing must resolve from it.** `Harness::Other(&'static str)` hold name verbatim, hand-written `Deserialize` fall into it, `wire_name` write it back unchanged — so old build rewriting index leave newer build's session exactly as found. Placeholder there **worse than crash**, not milder: it parse fine then silently rewrite harness of every session it not recognise. Name interned (leaked once per distinct spelling) to keep type `Copy` — it pass by value through most of `session.rs`, and `String` there put `.clone()` on 44 call site. `Harness::ALL` exclude it, so picker and availability read cannot offer it; `names_a_cli()` = what every path to spawn ask, and it answer false, since running wrong agent in somebody's session = failure this protect against not lesser one.

**`ApprovalPolicy` and `SessionStatus` stay unfixed, deliberately.** Neither can carry string: both must resolve to something real to spawn with, and `ApprovalPolicy` falling back to `Auto` make session **freer than reader asked** — worst direction available. Per-entry tolerance no good either, because "fail its own entry" can only mean *drop* it, and index rewritten whole, so entry dropped from read = entry **deleted** by next write. Preserving unreadable entry across that rewrite want raw `Value` threaded through every `write_session_index` caller; not built. So file still fail whole on unknown value in either — fixing one of three save nothing on own, and `harness` = one that actually happened and one where verbatim carry is both possible and right.

**Boundary = directory's `0700`, not socket's `0600`.** `bind` apply process umask, so socket land world-writable under permissive one and stay that way until chmod run moment later — window another local account connect through and reach session creation unauthenticated. Measured: umask 022 give 0755, umask 000 give 0777. Directory cannot have that window, since connecting need search permission on every dir in path — so `0700` settle it *before socket exist*. Socket's own `0600` stay as second line, not only one.

**`~/.dray` narrowed in `get_home_app_dir`, and that fix privacy bug too.** It was `0755`, so every transcript — holding whole files agent read and wrote — readable by any local account.

**Connect fail three way, and only one of them about app being up.** `NotFound` and `ConnectionRefused` = two shape closed app leave (no socket file; file with nobody behind), and they *only* kind saying anything about liveness — so `connect_failure` name them outright rather than use them as fallback. Full listen backlog answer `EAGAIN`, call get interrupted, connect time out: each = this connect failing with app very much alive, and old blanket `map_err` reported every one as "Dray isn't running", sending reader to restart something never down. Unrecognised kind now carry underlying error instead of being translated.

**`PermissionDenied` = its own answer, and deliberately not stated as sandbox.** Dray spawn Codex into `workspace-write` by default (`approval_for`), so agent's own `dray new` get denied on app's *own* default path and blanket sentence reported user's running app as closed. But kind cover `EACCES` as well as `EPERM` — `connect(2)` return it for search permission on path component and for write access to socket itself, neither of which escalation fix — so sentence name both cause and make cure conditional on one escalation help. First version said "that is a sandbox" flatly and was too sure; hedge pinned by test for that reason. Cure named in three place — error, [SKILL.md](apps/cli/skill/SKILL.md), [developer_instructions.md](apps/desktop/src-tauri/src/harness/codex/developer_instructions.md) — all pinned, since error reworded alone leave both doc answering sentence nothing emit any more. Test pin **whole clause** not word out of it, and match on words not on line wrap: prose, so where author break line = not test's business.

**Codex-side unix-socket allowlist looked for and not there.** Codex's own seatbelt generator do carry `(allow network-outbound (remote unix-socket (subpath (param …))))` fed by `allow_unix_sockets`, and primitive verified working under bare `sandbox-exec`. But only config surface reaching it = `[permissions.<name>]` profile, and on `codex-cli 0.151.0-alpha.7.1` **any** custom profile abort with SIGABRT and no output — `-c` override and real config file alike. Stable `[sandbox_workspace_write]` table carry no such key and ignore one in silence. So nothing to recommend that don't crash reader; revisit when profile route settle. Broad unsandboxed shell = not the trade, and escalating one command already the narrow answer.

**Narrowing best-effort, so `serve` check rather than assume.** App must start whether or not chmod land; socket must not bind where it can't be guarded. Dir still group- or world-reachable → refuse to bind with readable line naming `chmod 700`. Cost feature, never app — same bargain rest of module make. Verified live with `chflags uchg` forcing chmod to fail: dir stay 0755, no socket, app fine.

**Address = one value, and that what let app move to server.** `DRAY_ENDPOINT` read from env child already get injected: `.sock` path today, HTTPS URL and token in cloud build. Types, subcommands and skill all unchanged by that swap — only ~30 lines that open connection. Socket = same-machine only, which hold if manager and its agent children move to server *together* and break if agent ever run where manager isn't.

**Protocol version checked before request even looked at.** Two release pipeline mean old CLI can meet new app; `v` field refuse mismatch with readable line rather than guess what it meant. Line name *which half* behind, and skill teach both — cure differ, and only one runnable from agent, so refusal naming wrong half send agent running `dray update` at problem it cannot touch. v2 = current; see `from` below for what earn bump.

**`session_created` carry index item, never `SessionSnapshot`.** Frontend's `agent_event` listener write into sessions it already hold and *drop* events for id it don't — so snapshot would start transcript in memory that later event could miss. Index item leave transcript unread until row clicked, and `handleSelectSessionIndexItem` already load it whole from disk at that point. That close window rather than live with it. `session_status` and `session_title` still land: both write by id into maps sidebar read, not into `sessions`.

**Row appear, and deliberately not selected.** User mid-conversation in session that spawned this one; yanking them out = opposite of what fanning out for. Listener sit in `[]` effect so it need `showArchivedRef`, same reason `selectedSessionIdRef` next to it exist.

**Spawned session always take worktree, and no flag turn it off.** Three issue in one checkout overwrite each other, and changes panel already cannot tell two writer apart — so opt-out = footgun with no good use. `--no-worktree` existed and removed. **Name not caller's either** — `--worktree-name` and its proto field went the same way: agent have no basis for picking one, app already generate readable name, and supplied name = one more thing that collide.

**`--from` move where tree start, not who own it.** `-w` fork from `origin/<default>` whatever checked out, so spawned session could not see work of session that spawned it — which put obvious use, *second model review what first just did*, out of reach. `--from <session-id | branch | ref>` answer it: still new worktree, based at that point. Sharing live checkout stay out of scope, and `--from` is not a way in.

**Mechanism = Dray make tree itself.** `-w`'s flag surface expose no base ref (`worktree.baseRef` = settings key, not flag), so [create_worktree](apps/desktop/src-tauri/src/git.rs) run `git worktree add --no-track -B worktree-<name> <path> <base>` and child spawn **into** that directory with no `-w` at all — symmetric half of `remove_worktree` next to it. Falls out of that: tree exist before child do, so baseline = real `snapshot_tree` not `base_ref_tree`'s approximation; and tree carry no lock, since only CLI lock trees and only `-p` fail to release them.

**Branch, never detached HEAD.** git refuse checking out branch another worktree hold, so `--from` cannot mean "same branch" — leaving detached-vs-new-branch as real choice. Detached suit session that only read, and cost four surfaces: PR tab look branch up, handoff row offer to push it, `remove_worktree` delete it, `sessionBranch` name it. So `--from` always mint same `worktree-<name>` branch `-w` would have, starting at given ref instead. No second flag. `-B` not `-b`, matching CLI: branch left behind by tree deleted outside Dray otherwise make that name fail forever, and `-B` cannot reach branch some worktree hold — exactly case where it somebody's live work.

**Committed work only, and skill say so out loud.** Worktree at branch tip carry what was committed, not what author have open. Usually right for review; unsaid, it = reviewer reporting confidently on tree missing very change user looking at. Pinned by test, like `dray update` is.

**Session id resolve through [`session_branch`](apps/desktop/src-tauri/src/store.rs), same reading `sessionBranch` in [pr.ts](apps/desktop/src/lib/pr.ts) take.** Two reader, neither can call other — PR tab need it in frontend, `--from` need it in Rust — so rule stated twice and tested twice against same four cases. What it must not become = two *different* rules: `--from` starting reviewer on one branch while header beside it name another = disagreement nothing on screen could explain. Id tried before ref, since id = address everywhere else in `dray` and v7 uuid = no branch name anybody type.

**`from` bump `PROTOCOL_VERSION` to 2, and that sharpen the bump rule.** Old rule = "bump when field change meaning, not when one added". Too narrow. Real test = whether default old side fall back to is **detectable**: old app ignoring `model` run session on own default, which caller can see and judge; old app ignoring `from` start worktree at `origin/<default>` and answer *identically to success*, so session spawned to review unpushed work review none of it and report everything fine. Wrong work that look like right work = what earn bump.

**Cost fall where it cheapest, which why bump beat softer signal.** Refusal cost *every* command, not just new one — but CLI behind app get told `dray update` and fix itself in one step, while app behind CLI cannot be fixed from agent at all, and that exactly direction silent default do most damage in. So updating app first = smoother order: it leave CLI behind, half that self-heal. Softer signal shipped first and removed — `Response::Created`'s absent `baseRef` stood in for "app too old", duplicating `mismatch()` which already name which half behind and already pinned by test.

**`base_ref` stay, for own reason.** `--from <session-id>` name session; branch it resolve to = something only app know, so CLI print it back. Reporting, not compatibility.

**Envelope must still parse at version app no longer speak.** Version check = layer *above* parse, so v1 line have to deserialize or app answer "could not parse the request" where it should answer "run `dray update`" — refusal that name no cure = refusal agent cannot act on. Pinned by test.

**`dray send` go both way, and that one command not two.** Child reporting summary up and parent handing child extra context = same operation, so no reply channel beside a send. Message arrive as ordinary prompt and *start a turn*, so it wake idle agent; target mid-turn queue it and CLI say so, since queued not failure. Unrestricted to parent/child pair on purpose — id = address, and naming relationship = one more rule to get wrong.

**Relayed message name its sender twice, and neither copy do other's job.** `user_message.from` = `MessageSender { session_id, title }`, set only by `send_message`, `None` everywhere else, persisted so attribution survive replay. Prompt text carry `[message from the Dray session "title" (id)]` as well. Both built from one lookup in `attribute`, so two cannot name different sessions.

**Agent have no channel but prompt text.** Verified: every control-request subtype carry a setting (`set_model`, `set_permission_mode`, `interrupt`, `stop_task`, `initialize`), none carry metadata, unknown field dropped in silence not refused, `--append-system-prompt` fixed at spawn. Codex same — `codex exec` take prompt and nothing beside it. So prefix not one option among several, it the only one. Id ride along because it = address: agent answer `dray send <id>` without paying `dray ls` to learn who asked.

**Transcript have no business parsing it back out.** Field-only rendering shipped first and cost job prefix was doing; parse-the-prefix considered and refused. Not for forgery — `from_session_id` come from `DRAY_SESSION_ID` in child env, settable by anything reaching socket, so **field no more authentic than prose**. Refused because parse *fail silently*: title holding bracket, reworded prefix, harness with differently shaped prompt each break regex and leave relayed message drawn as user's own. Field either there or not.

**Bubble mute that line, and rebuild it rather than parse it.** Prefix echo avatar's label right above it, so drawn it = same fact twice. [stripSenderPrefix](apps/desktop/src/lib/relay.ts) build exact string `attribute` build — same `MessageSender` off event's own `from` — and drop it only on `startsWith`. That not parse-the-prefix line above refuse: no regex, no guess where line end, and drift (reworded prefix, another harness's shape) fail by leaving line **drawn**, never by eating sentence after it. Log untouched — persisted text stay what model was given, same rule attachments follow. Both bubble strip, delivered and queued, or relayed prompt read one way waiting and another way sent.

**Sender draw on user side of transcript, above bubble.** Agent's message arriving in session where that agent not the assistant = still not this session's assistant speaking, so it keep user's column. Mark plus title, whole row a button opening that session through same `handleSelectSessionIndexItem` sidebar row use. Row sit above attachment tray too: who talking read before what they sent.

**Mark = blobatar, and it own component not `Avatar` with generated fallback.** [SessionAvatar](apps/desktop/src/components/SessionAvatar.tsx) seed `blobatar` on **session id**, never on title: app write title itself and rewrite it, and mark changing when session get retitled = not mark. Separate from `Avatar` on purpose — that one draw *person*, where `d=404` on Gravatar deliberately leave initial standing rather than cover missing account with pattern reading as face somebody chose. Session = one place generated mark say something true, so blobatar must not reach PR panel or commit history. Initial stay as answer for blobatar that can't draw at all, and it **swapped** not layered the way `Avatar` do it: figure = `data:` URI built locally, so no load to cover.

Drawn with **no backdrop** and at `size-5`, both against component's own defaults. Blobatar's own plate = near-white disc that stay near-white in dark mode, which put brightest thing on row beside quietest line of text on it. And figure only reach ~70% of its viewBox, so at `size-4` it read lighter than 13px title beside it while its own slack read as gap — hence one rung up and `gap-1` on row.

**Sender can outlive session it name, so selection roll back on empty read.** Attribution persisted, session it point at need not be — click avatar of deleted sender and `get_session_by_id` answer null. Leaving id selected look harmless and isn't: `selectedSession` go null while `selectedSessionId` still hold dead id, and `centered`/`isNewTask` both derive from that null — so reader get *new task* composer while `handleSendMsg` still find id, compute `isNewSession: false`, and resume session that gone. `handleSelectSessionIndexItem` therefore restore previous pick and say "Session not found" — not "deleted", since all it know is id resolved to nothing. Fix sit there and not on avatar, so stale sidebar row covered too.

**Two ref, and they answer different question — collapsing them was the bug.** `selectedSessionIdRef` mirror state, so it a **render behind**: read landing in that gap still see itself as current and overwrite click that already happened. `selectionRequestRef` written at *call* time instead, claimed at every site selection move (`handleSelectSessionIndexItem`, `handleSendMsg`'s new id, `handleNewSession`, rollback itself), and rollback fire only where it still name this read. Roll-back target likewise cannot be "whatever selected": selection **optimistic until own read land**, so it may itself be id about to be rolled back — restoring it recreate exactly the state this exist to prevent. Hence `restorable` = previous pick *only if loaded in `sessions`*, else `null`. Two dead id clicked in row therefore land on empty composer, which safe; single one — real case — land back where reader was.

**And that validity judged at rollback, not at capture, off `sessionsRef`.** Closure's `sessions` = render's copy, and rollback run after `await`. `deleteSession` drop row from `sessions` and only clear selection where deleted row *was* selected — which by here it not, since dead id hold selection. So session validated before read can be gone by time read answer, and rollback onto it recreate same dead end. Three attempt at this line, each narrower race, all same root: **state read across an await must come from ref, not closure**.

**Attribution reach queued path as well.** `QueuedMessage.from` hold it rather than flush looking it up: relayed message can wait out long turn, and sender may be renamed or deleted before boundary that deliver it. Spawned session's *opening* prompt carry none — creating session = parent, which sidebar already draw by nesting, and brief is not message relayed into conversation under way.

**Send pass target's *own* recorded model/effort/permission back in**, which what make it inert: `send_msg` compare them against what child run, find no change, so neither `set_model` nor respawn fire. Message must not reconfigure session it arrive at.

**Depth cap = 2, walked not stored.** Spawned session may spawn; its children may not. Walk `parent_session_id` up index at create time with cycle guard, rather than storing `depth` number free to disagree with chain it describe. Chains three long, so walk cost nothing. Refusal = readable sentence, since agent read it as tool output.

**`dray ls` carry parentage, and table name it rather than column it.** `SessionSummary.parent_session_id` mirror index's own field, so `--json` get it free and agent can answer "who spawned that" without reading index. Table print `spawned by <id>` trailing row instead of second id column: two bare uuid under no header = table nobody read, and most row have no parent at all. Field `#[serde(default)]` because it landed after CLI shipped — older app send no such key, and that must read as no parent, not as failed list.

**Model, effort, harness and permission mode inherit from parent**, each overridable by flag (`--model`, `--effort`, `--harness`). So fanned-out session run way one that spawned it do. No parent (call from user's own terminal) = Rust's own default, because composer's remembered pick live in frontend localStorage where Rust cannot read it. `ModelId::default()` cannot serve — it `Unknown`, which exist so old index entry still deserialize and which have no CLI alias — hence `default_model()`.

**That default = Opus, and composer seed same.** Composer seeded Haiku once, on reasoning that it open picker reader about to touch — in practice that make every untouched session weak, and cost of weak session = work redone by hand. Stated twice, Rust's `default_model_for` and [model.ts](apps/desktop/src/lib/model.ts)'s `DEFAULT_MODEL_FOR`, since neither side can call other. Effort follow from model's own default (`High`) through `resolve_effort`, so no second constant.

**Composer remember model *per harness*.** `ComposerPrefs.modelByHarness`, not one `modelId`: model belong to exactly one harness, so single remembered pick can only ever be right for harness that made it. Switching to Codex and back used to find pick new list cannot run, fall to `usableModel`'s old fallback — head of list — and land on Fable or Sol however deliberately reader had chosen otherwise. `setHarness` now move model with it (`rememberedModel`), and `usableModel`'s repair fall to **harness default**, since list head = picker-ordering decision and reading it as answer = whole of that bug.

**Model and effort both stop at harness boundary.** `resolve_model` filter parent's model on `runs_on` and `resolve_effort` filter parent's whole entry on `p.harness == harness`, so Codex session spawned from Claude one inherit neither. Model half obvious — Codex cannot run `opus` and spawn would fail. Effort half not: two ladder share every name (`low`…`max`) and Codex accept whichever passed, so Claude parent's `high` land silently on Codex child whose own default = `medium`. Same name, different scale — Codex reason at every level and start lower on purpose. `None` there fall through to model's own default, which = whole cure.

**Whether to inherit at all = agent's question, and it live in [SKILL.md](apps/cli/skill/SKILL.md) alone.** App cannot ask, so nothing here enforce it: parent on Fable, or above **its harness's own default effort**, want user's answer before fanning out, since one chat's pick multiply by however many session get started. Threshold per harness for same reason inheritance stop at boundary — `xhigh` on Claude Code sit two rung above its `high`, where on Codex `high` already one above `medium`. Single threshold across both either ask about Codex's resting level or never ask about Codex session running well over it. Stated once, in skill — which `skill install` now write for both harness — and pinned by test there. Restating in `system_prompt.md` = second copy on app's release train drifting against CLI's.

**CLI resolve project = main worktree, and `--show-toplevel` cannot do it.** Caller here almost always agent standing *inside* linked worktree, where that command answer tree not repo — so `project_path` went onto wire naming worktree, and app computed `cwd` of `<that tree>/.claude/worktrees/<name>` which `claude -w` never make, it resolve repo for itself. Result = session whose Changes, commit and PR all read directory that don't exist, silently, since app cannot tell CLI's guess from deliberate `--project` and rightly take caller's value first. First record of `git worktree list --porcelain` = main worktree whatever you run it from; bare repo answer `None`, since nothing checked out there. Not `-z` — that want git 2.36, and older one fail command outright and answer nothing, which = same silence one rung down.

**Project deliberately not attached.** Sidebar's `projectFilter` default null and list every session whatever its project, so session under unattached repo already reachable — while `add_project` bump `last_selected` and resort list, which would let agent's call quietly reorder user's project picker.

**`dray` raise no consent card, and that one flag.** `--allowedTools "Bash(dray:*)"` on spawn — additive allow rule, everything else still route through `can_use_tool` exactly as before. Verified against v2.1.241, not assumed: pattern that fail to match fail *silently*, as unexpected card rather than error. Measured with `mkdir` under `manual` — `Bash(mkdir:*)` and `Bash(mkdir *)` both ran, `Bash(git *)` reported `permission_denied`. **Test with command that mutate**: read-only one like `echo` auto-allowed whatever rule say, so it report success for pattern matching nothing.

**Child get `PATH` put back, and that load-bearing.** Bundled `.app` launched from Finder inherit launchd's `PATH` (`/usr/bin:/bin:/usr/sbin:/sbin`), so `dray` installed to `~/.local/bin` simply not there for agent — same trap [binpath.rs](apps/desktop/src-tauri/src/binpath.rs) exist to solve for `claude`, one layer out. `known_dirs()` now `pub` for this. Appended not prepended: user's own `PATH` should still win where two name same binary.

**Skill embedded in binary, written by `dray skill install`.** Downloaded separately = exactly how skill end up describing different version of CLI than one installed. Global at `~/.claude/skills/dray/` **and** `~/.codex/skills/dray/` — same SKILL.md format, each agent read own home — not scoped with `--plugin-dir`, because CLI meant to work from any session, terminal one included. Both written every install, since CLI cannot know which agent user run.

**Codex get Dray's rules too, as `developerInstructions`.** Claude take `--append-system-prompt`; Codex take that field on `thread/start` *and* `thread/resume` (rollout carry none across). `baseInstructions` next to it = wrong one: it *replace* Codex's built-in prompt, tool docs included. Verified live — codeword placed there come back when asked. Prompt = own file ([developer_instructions.md](apps/desktop/src-tauri/src/harness/codex/developer_instructions.md)), not Claude's shared: Claude's name `AskUserQuestion` and Agent tool, neither exist on Codex, and Codex's name its own skill path. Test pin both. Codex's `request_user_input` deliberately not named — Dray don't handle it yet, so prompt say ask in reply and end turn.

**Skill freshness ride CLI, never app, and chain close on own.** `include_str!` bind skill to binary at compile time; `install.sh` run `dray skill install` after landing binary; `dray update` re-run `install.sh`. So every CLI update rewrite skill on disk, and **app update do nothing to it** — right way round, since skill document CLI. Property that make it safe: skill and `PROTOCOL_VERSION` travel in *same binary*, so skill describing wrong protocol impossible without CLI also being wrong — and stale CLI = exactly what version refusal already catch and tell agent to cure. Nothing extra to build. Residual = Claude session already running hold old skill in context until next session.

**Skill teach *how to cure a refusal*, never which flag need which version.** Enumerating "`--from` want v2" age badly — every later flag want own line, and agent cannot check versions itself anyway. Run command, read refusal, run named cure. Both halves documented because only one runnable from agent; pinned by test.

**Sidebar nest spawned session under its parent**, `sortSessions` in [Sidebar.tsx](apps/desktop/src/components/Sidebar.tsx). Exported and shared with ⌘⇧↑/↓, so order stepped = order drawn. **Walk depth-first, not one pass over roots** — depth cap allow spawned session to spawn, and single pass emitted neither grandchild nor anything below it, so row simply vanish from sidebar. Caught by test, not by eye. `seen` set also mean cycle in index cost strange order rather than hung sidebar, and unreached row appended not dropped.

**Sidebar group by project in All Projects view.** `sessionGroups` gather `sessionRows`' output under each row's **root** project — child follow parent whatever own `projectPath` say, or nest split across two heading and child draw under parent that isn't there. Heading = project name, muted, no icon, full path on `title`; project with no session open no group at all, so heading come from row present not from attached list. **Group order = project list's own**, not recency of session inside. Recency read fine in screenshot and badly in use: reply to any session lift its whole project over others, so heading move under reader's eye mid-turn. Project list reorder only on project being *selected* = reader's own act. Detached project keep first-appearance order after attached one. `sortSessions` take same list, or walk step order different from one drawn. Filtered view draw no heading — label above already name that one project. `sortSessions` flatten group, so ⌘⇧↑/↓ still step order drawn, and single-project list come back exactly as before grouping existed.

**Pinned lead, and it group not sort key.** `splitPinned` take item out before grouping, so pinned session draw under **Pinned** heading and nowhere else — twice on screen and reader work out which copy = one they pinned. Group first whatever project order say: it built by hand, and pick sorting in with rest no easier to find than row it made out of. It span project too, so no place in that order for it to take. Kind on `SessionGroup` = discriminated union not nullable path, since Pinned name no one repo. **Filter need no code** — caller narrow `items` first, so group hold that project's pin alone and open nothing when empty. Pinned heading = one word, and drawn **even under filter**, unlike project one: project name repeat label above, where Pinned name set nothing else on screen say. Run drawing no heading but not first get `h-3` spacer instead, or filtered list read as everything sitting under Pinned.

**Pinned-side = pinned *or under pinned*.** Child follow pinned parent out of its project run, same reason nest never split across two heading. Rest closed under parentage by construction (nothing with pinned ancestor stay behind), so both half hold whole nest and `sessionRows` draw each half's root at depth 0 — pinned child of unpinned parent reach group as root, and parent it left behind open no rail at all. Walk up carry cycle guard like `sessionRows` do: cycle cost strange grouping, never hung sidebar.

**Search = `filterSessions`, and it run before grouping — that ordering do all the work.** Case-insensitive substring on `title` alone; no fuzzy, no transcript. Fuzzy rank, and ranked list cannot hold recency order rail drawn from — child sit under whatever scored above it rather than under parent. Applied in `App` over `visibleSessions`, not inside sidebar, so list drawn and ⌘⇧↑/↓ walk read one array; **layered over that memo rather than folded into it**, since `usePrMarks` and `usePrReady` read `visibleSessions` to decide what to watch, and session leaving it as query typed would stop its repo being polled and make notice forget PR already ready. Blank query hand **same array back**, identity included, so memo hold while nothing searched for. Everything downstream fall out free: project heading and Pinned group alike draw only where group still hold row, pin that match stay pinned, child whose parent filtered out draw top-level exactly like `isNested` already say, and empty result name query over project and settled split — reader holding that filter in their hands.

**Button become field in place**, same row same height: bare input, no fill, no border, no focus ring, and `border border-transparent` on its row because every button carry one and icon otherwise sit pixel further out. Escape clear query *and* close, since filter left behind closed input hide row with nothing on screen saying why; blur close only where query empty. Sidebar return `null` when collapsed rather than unmounting, so caret and query both survive collapse.

**Child whose parent not on screen draw top-level.** Ordinary case not edge one: parent may be archived, filtered to another project, or deleted. `isNested` judge it same way `sortSessions` place it, so marker can never point at parent that isn't drawn.

**Marker = `|-`, two character, not indent.** 250px sidebar have no room to spare and title = one thing on row that must not get shorter. `aria-hidden`: marker = picture of list's own shape, and screen reader already read rows in drawn order.

**Detach one-way, and no re-attach.** Parentage record who *created* session = fact about past; session detached then re-parented elsewhere describe history that never happened. `detach_session` leave `modified` alone for `set_session_flags`' reason — it order list, and detaching must not jump row to top. Menu item absent on un-nested row rather than disabled: disabled item on every row = noise, not promise of something coming.

**Socket failure cost feature, never app.** `serve` error logged and dropped in `setup()` — app refusing to start because socket in use would trade whole product for side channel, and reader could act on it either way.

## Forking a session

**Fork = one conversation carried on twice.** Sidebar row's right-click menu hold
it, as submenu: **Fork in new worktree** and **Fork here**. Both copy whole
conversation — CLI have no way to fork at chosen message, `--fork-session` take
session and nothing narrower — so two item differ only in *where* copy run.

**Fork lazy, and that whole shape.** Two half to fork and they cost different
thing. App's half — copy log, write index entry — instant. CLI's half only
happen on **spawn**, so doing it eagerly cost child process per fork and turn's
wait before row appear. So `SessionManager::fork` write app's half now and leave
`fork_from` on index entry as instruction; **first send** spawn
`--resume <parent> --fork-session --session-id <new>` and clear it. Every send
after = ordinary resume. Copied log = what fork replay meanwhile, so it open
reading exactly like parent.

**`--fork-session` honour `--session-id`**, verified against v2.1.246 — that
what let frontend mint fork's id like it mint new session's, keeping one rule
(app choose id, CLI adopt it) rather than two. Without it CLI mint own and app
have to read it back off first `result`, which arrive turn later. Also verified:
CLI write fork **complete standalone transcript** holding parent's history, so
`--resume <fork>` after work with no reference to parent; and `-w` combine with
all three, which what make worktree item possible at all.

**Refused while parent's *turn* in flight, and nothing wider.** CLI fork by
*reading* parent's transcript, which live child appending to mid-turn, so fork
taken there inherit half a turn. Background task outstanding = not that case: it
append *after* turn ended (how subagent report back), and fork = copy at point in
time. Backend check `turn_in_flight()`, submenu trigger disable on
`in_progress` — **same question**, since `InProgress` *is* `turn_in_flight` by
construction, pinned by test in `session.rs`; frontend state rule once in
[fork.ts](apps/desktop/src/lib/fork.ts) rather than inline in menu.

Guard was `has_outstanding_work()` and that = bug: it safe-to-replace-the-child
question, and fork replace no child — it borrowed guard written for path that
kill one (effort respawn, update install, which keep wide reading). `local_bash`
task never end, so session running dev server could not be forked again for rest
of its life, **while menu item stay enabled** — same `result` had already moved
status to `completed`. Two guard disagreeing = what made Fork read as broken
rather than busy, which why they now answer one question.

**Refused too where parent have no conversation.** Index entry written before
spawn, so session whose child failed to start sit in sidebar with empty log and
no CLI transcript under its id. Answered here as one sentence; left to first send
it come back as CLI's own "no conversation found", turn later.

**Fork here leave `worktree_name` `None`, even forking worktree session.** Field
mean "this session own that tree", and settling or deleting fork would otherwise
pull directory out from under parent still working in it. `cwd` and `branch`
inherit either way, so fork still run in parent's tree and its PR tab still find
branch. Cost = two session writing one checkout, same trade two plain sessions
already make, and changes panel attribute either's edit to whichever turn open.

**`worktree_removed` inherit though, and that not same question.** Flag decide
whether recorded `branch` or git's own HEAD believed, not who own tree. Fork in
place of **relocated** session sit in shared checkout exactly as parent do, so
HEAD there name whatever else going on in it — hardcoding `false` there took PR
tab off every fork of settled worktree session, silently, since guess fail closed
same way. Fork into new tree read HEAD straight and carry `false`.

**Fork in new worktree = one resume whose tree don't exist yet**, so it need
creation's treatment inside `send_msg`: `-w` to make tree, project root as spawn
dir because missing directory can't be `chdir`ed into, `base_ref_tree` as
baseline because there no tree to snapshot. Name resolved against **project**,
not against parent's own, so fork of fork can't collide with tree it came from.
Item name that cost out loud: `claude -w` fork *tree* from `origin/<default>`,
not from wherever session is, so copy carry whole conversation onto code that
may not hold work it was about. Cure now exist next door — `create_worktree` take
base ref, and `send_msg` already spawn into tree it made — so this = wiring, not
missing machinery. Wanted a base of parent's own branch tip; not done here.

**Name resolved against index too, not disk alone.** `resolve_worktree_name` ask
filesystem alone, and lazy fork open window that never had: fork's tree not exist
until first send, so its name live **only in index** until then. Anything else
drawing name — another fork, or ordinary new worktree session — take one pending
fork already hold, and that fork's `-w` then fail against tree other one made.
**Permanently**, since name on its index entry by then and every retry redraw
same one. Only 16³ name exist, so not vanishing odds it look like.
`resolve_unclaimed_worktree_name` read both, and **both** call site use it —
creation path too, since it the one most likely to draw name a fork hold.

**Copied log repointed, twice, and both about outliving parent.** Every event
carry `session_id` and frontend route live event by it, so log left alone open
claiming to be parent's then grow new event under own id — one log describing two
session. And `ImageRef.path` name file under
`~/.dray/attachments/<session-id>/`, so verbatim copy draw picture out of
parent's directory and go blank moment parent deleted; attachment directory
copied beside log and path rewritten onto it. `id` deliberately **not** re-minted
— these same event, and nothing join across session on it. `repoint_events` split
out from copy so rule testable with no `~/.dray` to write into.

**`parent_session_id` inherit, because fork = copy and copy sit where original
sit.** Sidebar draw fork **beside** its source under same parent, not under
source, and depth cap count it at same depth. Reset to `None` look tidier and is
hole: copy surface top-level and free to spawn where session it copied could
not — depth cap a copy walk around. Detach = way out for anyone wanting fork
standing on own, and it already one-way, so nothing lost. Pinned by test.

**`fork_from` = instruction, not lineage.** Cleared once CLI carry fork out, and
that timing load-bearing both way: cleared **after** spawn, so child failing to
start leave instruction standing and next send fork again; **before** prompt go
out, because from there CLI own session under this id and forking parent second
time abandon it. `#[serde(default)]` so entry predating field read as nothing to
do — reading it any other way fork every existing session on its next send.

**Title = parent's plus `(fork)`**, truncated to same 60 chars everything else
is, and suffix take its room from parent's text rather than being cut off. Fork
have no first prompt, so title generation have nothing to run on; mark = what
stop two identical row telling apart only by timestamp.

**Fork of fork keep one suffix, not one per generation.** `fork_title` strip
`(fork)` off parent's title before adding own — nothing here track lineage
either (`fork_from` cleared once CLI carry it out), so counting generation in
title would promise more than rest of feature keep.

**Submenu's digit picks by position, and the listener sits above the portal
it names rows in.** `1`/`2` on Fork in new worktree / Fork here, same rule
`VIEW_TABS` accelerator follow. `SubContent` render through Radix portal, so
handler placed there only fire once focus — not just open submenu — move
inside it; hovering trigger alone leave focus behind on trigger. Listener
instead live on outer `ContextMenuContent`, gated on `onOpenChange`'s own
`open` flag rather than focus location — React still deliver event there
through component tree not DOM one, so key fire moment submenu draw, hover or
keyboard alike.

**Restoring composer's controls split out for this.** Fork open selected — forking
= asking to work in copy — but it can't go through
`handleSelectSessionIndexItem`, which read `sessionIndexItems` and won't hold new
row until next render. So `restoreSessionControls` take *item* not id, and both
path call it. Without it fork open under whatever model composer last left on
rather than one it inherited.
## A missing agent CLI

**Answered before the reader writes a prompt, and refused before a session
exists.** `agent_availability` reports which harnesses can run here; the picker
reads it on mount and marks the one that can't, and `send_msg` checks again in
the pre-flight block under `if is_new_session`.

That ordering is the whole feature. The index entry lands **before** spawn on
purpose, so a session failing for a reason nobody predicted stays visible — but
a missing CLI is predictable, and taken through that path it leaves an empty row
pointing at an agent that can never start, which every retry fails against
identically. Refusing earlier means there is nothing to delete, nothing to
select, and no retry choreography: the composer never unmounts, `useDraft` still
holds the text under the new-task key, and retry is pressing send again.

**"Is it installed" is read off the cached path, not probed again.**
`binpath::agent_available` calls the ordinary resolver and asks
`is_absolute()` — a successful resolution is always absolute, and the bare-name
fallback both resolvers end at is the only relative answer either can give. Free
after the first call, which matters because the *failing* call is the expensive
one (it ends in a login shell reading the whole rc chain). For Codex it covers
the stale binary for free: one with no `app-server` subcommand never satisfies
`speaks_app_server`, so it falls through to the bare name exactly like an absent
one — and "installed but undriveable" is the same answer to the reader.

**Marked, not disabled.** A disabled mark leaves nowhere to say why: a tooltip
is the only slot left, and the cure is two lines and two buttons. Picking the
agent is what draws the notice, so the mark invites finding out. Drawn as a dot
rather than a colour, since the marks are brand art and recolouring one says
"Codex" louder than it says "missing".

**Notice, not error.** `ChatInput` takes it as its own `notice` slot beside
`error`, because the two say different things — `error` reports something that
was attempted and failed, this reports that nothing can be attempted yet, and
only the second has a cure to offer, which is why it is a node and not a string.
It gates `canSend` *and* returns early from `submit`: Enter has its own path in,
so a disabled button is not the guard.

**Dray installs nothing** — it names the command and links the page, the same
call the CLI already makes for itself. `install_command` is each vendor's own
install script (`curl -fsSL https://claude.ai/install.sh | bash`, and Codex's
equivalent), not a route Dray picked on its behalf: running someone else's
script for them is still installing it for them, and a failure inside it is
still ours to debug where a failure on the vendor's page is theirs to follow.
The link sits *beside* the copy button, not behind it, for the reader without
`curl` or wary of piping one into a shell.

Known cost: `binpath`'s cache never invalidates, so a CLI installed while the
app runs still reads as missing until restart — the same bargain `gh` makes. It
would have to be made clearable the day an Install button lands.

## Demo pages

**A demo is its own page, never a flag on the real one, and gone once its
question is answered.** The pattern, for whichever surface needs it next: an
HTML entry at the package root (`demo.html`) loading its own `main.tsx`. Vite's
dev server serves any root HTML, so it is reachable under `pnpm dev`;
`vite.config.ts` names no extra `rollupOptions.input`, so `pnpm build` emits
`index.html` alone and nothing there can reach a shipped bundle. Delete the
whole thing — the HTML entry and its `src/demo/` tree — once it has done its
job; it is scaffolding for showing someone a behaviour, not a fixture worth
keeping alive.

Gating on a query flag was the rejected alternative: it puts demo-only branches
inside production code paths, where they can fire for a real reader and have to
be reasoned about on every later edit of that surface.

A demo mounts the **real** components with faked inputs — not a second
implementation of them — so a regression in any of them shows up on the page.
Any test seam built only for the demo's sake (a module-level setter, say) goes
with it; leaving one behind after the demo is deleted is a route into
production state that nothing exercises any more.

**A demo page has to bring `App`'s own providers with it.** `TooltipProvider`
wraps the whole app, so mounting a control with a tooltip in it —
`ModelSelector`, for one — throws `Tooltip must be used within TooltipProvider`
without one. That failure is a blank page and an empty `#root`: React unmounts
the tree, and nothing in the dev server's output says so.

**And a browser is not a webview.** `getCurrentWebview()` and
`getCurrentWindow()` **throw** outside Tauri rather than rejecting, so an
unguarded call in an effect takes the tree down the same way. `useDockBadge` and
`useFullscreen` already carry a `try` for it; `ChatInput`'s drag-and-drop
listener did not, and the fix stayed after the demo that surfaced it was
deleted — it broke plain `pnpm dev` for the composer too, whether or not a demo
page is mounted. Reach for the guard whenever an effect touches
`@tauri-apps/api` synchronously — `invoke` is safe, since it rejects.

## Persistence

Everything live under `~/.dray/` ([store.rs](apps/desktop/src-tauri/src/store.rs), [projects.rs](apps/desktop/src-tauri/src/projects.rs)) .

- **`sessions/<session-id>.jsonl`** — one mapped `AgentEvent` per line, append-only. Single writer per file, so `O_APPEND` alone enough; no lock. On resume, `next_seq_by_session_id` tail-read last line to continue counter.
- **`sessions/index.json`** — one `SessionIndexItem` per session, holding both `cwd` (where agent run) and `project_path` (repo root, used as grouping key so worktree sessions still list under their project). Rewritten whole, so take process-wide lock and land via write-temp + `rename`.
- **`attachments/<session-id>/`** — copy of every image sent from that session, deleted with session. Only images: non-image attachment referenced by original path and never copied.
- **`projects.json`** — attached projects and which last selected. Own file and own lock, because share none of index's semantics. Paths canonicalized at attach time; without that, `/x/proj` and `/x/proj/` become two projects and split sidebar's grouping.

Asymmetry = point: appending to private file atomic, rewriting shared one not.

`cwd` on index authoritative on resume — `send_msg` read it rather than trust caller's argument, since project picker make two able to disagree and resuming in wrong directory silent.

## Updates

**Shipping one = `apps/desktop/RELEASING.md` (gitignored, local only), and follow it rather than reconstruct it from here.** This section say why pipeline built way it is; that file say what to type and, more important, what to _check_ after — green tick alone prove nothing, since bundler only warn when notarization fail.

**Two signatures, conflating them first mistake to avoid.** Minisign keypair (`pnpm tauri signer generate`) = updater's own integrity check: public half sit in `plugins.updater.pubkey` and private half build-time env var, and bundle built without it refused by every client. Apple's Developer ID signature different question entirely — it what stop macOS blocking download, and say nothing about whether payload one this app published. Both set in [release.yml](.github/workflows/release.yml); only first needed for local build, why [install.sh](apps/desktop/scripts/install.sh) export key itself and fail early with readable message.

**Tag's shape pick channel**, semver do rest. `v0.3.0` stable, `v0.3.0-beta.1` beta, and because `0.3.0-beta.1` sort _below_ `0.3.0`, beta user offered stable release moment it ship — no logic anywhere reproduce that rule. What release job do encode = other half: stable release write both manifests, beta release write only `beta.json`, so beta superset not fork.

**Manifest only ever move forward** (`promote` in [release.yml](.github/workflows/release.yml)). Beta line run *ahead* of stable for its whole life — that ordinary state, not edge — so unconditional `cp` was bug: stable hotfix shipped while beta open overwrote `beta.json` with older version, and fresh beta opt-in could never reach open beta at all (existing beta user just saw nothing, client never downgrade). Guard = same semver comparison plugin make, prerelease rules included, in inline node — **not `sort -V`**, which put `0.9.4-beta.2` *above* `0.9.4`, wrong on exactly case that matter. Equal version rewrite, so re-run republish own manifest; missing manifest written, never error. Release moving nothing skip commit, or empty commit fail job.

**Manifests live on `updates` branch served by GitHub Pages, not in release.** `/releases/latest/download/` obvious host and cannot work here: it skip prereleases, so beta have no fixed URL. Artifacts still live on release — manifest only point at them.

**Channel chosen per check, in Rust, not in `tauri.conf.json`.** [updater.rs](apps/desktop/src-tauri/src/updater.rs) build updater with channel's endpoint each time, so switching channels need no rebuild; config endpoint only what caller naming no channel get. Channel = `ade.updateChannel`, read by [useUpdater](apps/desktop/src/hooks/useUpdater.ts), default stable.

**Beta = row in Settings → About, and channel own by `useUpdater` not by row.** `useLocalStorage` per-component, so second copy in dialog write value hook never see — and `channel` = what re-arm checking effect, so change land on next launch and not before. Same trap `useTheme` became module store for; here one owner plus prop enough, since `App` already hand `integrations` down that way. Change therefore re-check for free — immediately, or when in-flight check settle (its `finally` re-ask). Lives in About because that tab = where app talk about itself: which build you run, and what it report back.

**Button arming confirm, not switch — switch was first draft and wrong with confirm on it.** Change want confirming, because it make app start downloading different build on own; switch that must be confirmed cannot move on click, and switch that not move read as broken. Button carry ask honestly: label name act (Turn on / Turn off), which also say which channel live. Confirm = disconnect row's shape — Cancel + **Confirm** replace button, not verb again: same word twice read as press not having landed. Cancel take focus unmounting button drop (keyboard user was on that very spot, and Cancel not Confirm so habitual double-Enter change nothing). Description stay put through it — consequence sentence tried and taken back out.

**Description = one line, and deliberately not mechanism.** Earlier draft spent second sentence explaining that switching back not downgrade — true, and nobody ask: reader want to know what they get, not how updater compare version. Client refuse anything not strictly newer (`release.version > current_version`, no `version_comparator` set), so switching back roll nothing back and there nothing to warn about. That fact live in [useUpdater](apps/desktop/src/hooks/useUpdater.ts), not on screen.

**Nothing emitted until there is update**, so `null` = frontend's resting state and cover every failure. Check that can't reach manifest = common case, not error worth row. Bundle download as soon as found and held in memory until user press install; progress emitted only on change of whole percent, since chunks land every few KB and per-chunk event = thousands of renders per bundle.

**Install blocked while any session mid-turn, and button wait rather than warn.** Swapping bundle relaunch app, killing every child mid-turn. Check = `statusBySession` in [App.tsx](apps/desktop/src/App.tsx) and complete on own: no child survive restart, so session from earlier run cannot still be running. Check live at button not in `install_update` because that command = point of no return — never return on success, since `restart` diverge, and `invoke` resolving at all mean install failed.

**Except when user ask.** App menu's "Check for Updates…" = question, so it answered either way — "Up to date" and "Couldn't check" both drawn, both retire themselves after 4s. Difference = who asked: scheduled check say nothing because nobody asked it, hand-triggered one leave menu item looking broken if it do same. Menu item **emit to frontend** rather than check in Rust, because channel live in frontend's local storage — emitting also mean manual check reuse scheduled path, in-flight guard included. Verdict read off `check_update` resolving with no `update_status` having arrived: command emit nothing when nothing newer, so absence = whole of signal. Still nothing while sidebar collapsed, so manual check there answer into void — real gap, see _Known issues_.

## Settings

**One dialog, three tab** ([SettingsDialog.tsx](apps/desktop/src/components/SettingsDialog.tsx)). Gear in sidebar's titlebar strip, ⌘, from anywhere. **Appearance** hold theme picker and mode segments, **Integrations** hold external-app pick and connected tracker, **About** hold analytics opt-out and two link out through `openUrl`.

**Tab row, not rail, and dialog width = why.** 28rem, and rail take third of it from prose — analytics sentence already broke across three line at 25rem. One long scroll was first shape and stopped working at five group: reader come to change one thing and read past four others to find it, worse with every group added. `SETTINGS_TABS` = set *and* order, same shape `VIEW_TABS` carry.

**About hold privacy and feedback**, one grouping worth arguing about. Both answer what app do *with* you rather than *for* you — what collected, and how to reach person who wrote it. Privacy alone too thin for tab and read oddly beside Appearance.

**Body switched, not hidden**, against right panel's own bargain. No scroll position and no expensive render to keep here, and mounting all three run external-app scan on every open whichever tab wanted. Pick reset on close, same reason dialog's open state not persisted.

**Heading = exception now, not rule.** Tab's own label name what under it, so section heading repeating it = second copy of one word. What still earn one = block carrying no label of own, which = feedback links and nothing else. `Section` untitled still worth being: panel space group apart at `gap-7` and it hold rows together at `gap-4`, which = whole of how heading end up nearer what it name than what it follow.

**Tab drawn with [TabButton](apps/desktop/src/components/TabButton.tsx), shared with view tabs and right panel's.** Three copy of one class string = shape that drift on whichever row nobody looking at. Extras stay at call site: count badge, keycap tooltip, roving `tabIndex`.

**Floating surface take glass, raised one take veil, and notice take neither.** `--card` become 5.5% white veil under transparency — right for surface sitting *in* page. Menu, dialog and tooltip float *over* it, so same veil there composite onto backdrop and leave page with their text on top; `--popover` take `--veil-float` instead, wash of its own colour (62% dark, 74% light) plus `backdrop-blur-xl` on every floating frame. Low number load-bearing: card transmit ~95% of what behind it, where menu sit over backdrop already at 80%, so 86% wash put ~3% of desktop through and read as slab. Blur = what keep that readable, and cost nothing where surface opaque. `--composer` take same pair — it float at window's edge over transcript scrolling under it. Both were opaque fill once and **both reason fixed at source**: `HandoffRow` clip itself rather than let composer occlude it, and blur make alert readable over unfilled sidebar. All three alias `--surface-card`, so palette bind them and transparency block part them.

**Theme carry own background, and separate axis for it was built then removed.** `--composer` must stay opaque fill (handoff row parked behind it), so backdrop picked apart from palette leave grey slab along window's bottom edge under any tinted background — and reaching it mean overriding palette token, which end the independence that justified split. Background = part of what theme *is*.

**Colour = three layer, and which layer token live on = whole filing system.** `:root` hold what neither theme nor mode change, plus every **alias**; `[data-mode]` hold ramp; `[data-theme][data-mode]` hold palette. Alias = what keep third layer short and honest — `--card`, `--popover` and `--composer` all `var(--surface-card)`, so theme cannot set one and forget another.

Ramp live on `[data-mode]` and **not** `:root`, deliberately: two have same specificity, so light document matching both would take any dark token light block happen to miss — leak showing up as one dark card on light page. index.html hard-code `data-mode="dark"` in markup as well as stamping it, so no unstamped case for `:root` to cover.

**Two way to write theme.** Derived = `--hue` + `--chroma`, fixed lightness per rung times per-step multiplier, so single-hue theme cost two numbers; `--chroma: 0` collapse every `calc()`, which why `default` = exactly greys it always was. **Ported theme not one hue**, so `catppuccin` and `gruvbox` name their rungs outright with palette's own token name in comment beside each. Both route end at same alias.

**Alias resolve where declared, and that bit swatch not palette.** `:root { --backdrop-top: var(--background) }` resolve *at `:root`* and inherit already-computed, so any **descendant** setting own `--background` still paint document's. Harmless for `--card`/`--popover`/`--composer` — palette block match same `<html>` element `:root` do — and fatal for `.theme-swatch`, where it drew three identical near-black square. Fix = re-declare both stop in `.theme-swatch`; theme setting own stop still win, since palette block unlayered and unlayered beat `@layer utilities` whatever specificity say. Backdrop = **two stops** (`--backdrop-top`/`--backdrop-bottom`), both falling back to `--background` — no shipped theme carry gradient today, machinery kept for one that will.

**Ported theme take surfaces and text accent, not semantics.** `--accent-merge` stay GitHub green (colour = meaning there), border stay ramp's alpha (`oklch(1 0 0 / 10%)` and black twin work over any palette). Credit live in root [README](README.md); test fail if ported theme ship without one.

**Light = second palette, not filter, and `darkOnly` = opt-out nothing set now.** Rung reorder rather than flip — `--surface-raised` sit between background and card in dark, **below background** in light, since only direction reading as inset on near-white page = down. Veil direction follow what surface *mean*, not mode: one saying "raised" go white in both (`--veil-card` = 5.5% dark, 60% light), one saying "inset or highlighted" go black. Accent drop hard in lightness. Green = `--accent-add`, paired with `--destructive`, since Tailwind literal cannot flip with mode and every one went invisible on light page. Default's light side built, so `darkOnly` now carried by no theme; `modeFor` guard stay for next palette arriving without one.

**Mode = three segment, not switch, because there three answer.** System/Light/Dark; switch can only ask light-or-dark, which leave `system` reachable from nowhere — and `system` = one that keep following OS after being set, so it the answer for anyone who already told their OS once. Drawn off `mode` as **chosen**, never `resolvedMode`: whole point of System = it read Dark today and Light tonight, and control drawn from what on screen show Dark and lose distinction. Dark-only theme disable **whole group**, not drop its light segment: two segment where there were three read as broken control, and `system` unofferable there anyway since OS can resolve it light. Selected segment stay honest because `modeFor` already force dark.

**Both picker share `useRovingGroup`.** `role="radiogroup"` = promise to screen reader that arrow move inside one Tab stop with selection following focus, and two copy of that = two chance for one to quietly stop keeping it. Roving `tabIndex` live at call site — without it every option own Tab stop, so tabbing dialog walk palettes one at a time.

**Swatch carry its own mode, not document's.** `hasLightMode(name) ? resolvedMode : "dark"` — dark-only theme in light mode match no palette block and fall through to light ramp's neutrals, so swatch would draw light Default that clicking it don't give. Same class of bug as backdrop stops below, one layer out.

**`neutral` → `shadcn` → `default`, and nothing migrate stored value.** `coerceTheme` reject unknown id and fall back to `DEFAULT_THEME`, which = same palette under current name. Pinned by test; that test = what should fail if default ever stop being that palette.

**Transparency = token set, and vibrancy nest inside it.** `html[data-transparency] body` carry exactly declarations vibrancy block used to, so both on set each token once instead of veiling a veil. **Windowed = always on**, stamped pre-paint with nothing read to decide it. Fullscreen answered by **palette**, never by reader — nothing behind fullscreen window, so whether layering still worth it = fact about that backdrop. `keepsGlassInFullscreen` weigh two thing in order: **light always flat** (light veil = black, and with nothing behind it that = grey smudge, where windowed it read as depth because desktop genuinely show through), then `flatInFullscreen` for dark palette whose backdrop not worth layering over. One function, so rule testable in one place. [useGlass](apps/desktop/src/hooks/useGlass.ts) own both attribute and guarantee vibrancy ⊆ transparency. Neither attribute persisted; `ade.transparency` retired.

**Material blur in appearance it *given*, and `useGlass` give it app's own.** NSVisualEffectView otherwise inherit **system** appearance, so light palette on Mac set to Dark composite over dark blur and go grey — which what held light's `--vibrancy-alpha` at 92%, near-opaque, window having given up being glass to avoid looking wrong. `setTheme` fix it and alpha now **70%**, below dark's 80%: light blur under near-white page read as tint on paper where same fraction under near-black read as wallpaper itself, so light need more through before it look like glass. App-wide, which what `set_theme` **is** on macOS — traffic light, menu bar and native dialog follow Dray's mode, cost accepted. Want `core:window:allow-set-theme` in [capabilities](apps/desktop/src-tauri/capabilities/default.json), not in `core:default`, same silent ACL refusal `set-badge-count` document.

**`null` there ≠ "mode on screen", and passing `resolvedMode` unconditionally break System.** Pinning appearance also pin what webview report for `prefers-color-scheme`, only thing `watchSystemMode` read — so reader on System freeze at mode app launched in and never see OS change again. Appearance released exactly where Dray's own mode free to follow system, and `modeFor` already draw that line: it answer `system` only for theme with light palette to switch to, and pin dark-only one to `dark` where material must be pinned with it.

**`useTheme` = module store, and that not tidiness.** `useGlass` read theme, so per-hook copy meant dialog set theme its own copy knew about while window kept old one's fullscreen behaviour — and stale copy's `watchSystemMode` callback re-applied old palette on next OS colour-scheme change, reverting theme while dialog still showed new one. Caught by Greptile on first pass. One store, one watcher.

**Rules go on `body`, never on `html`.** Palette blocks = `[data-theme][data-mode]`, two attributes, so they out-specify any `html[…]` aimed at same element and override lose **silently**. Same trap vibrancy hit; every new attribute hit it again.

**Mounted in `App`, not beside gear that open it.** Sidebar unmount whole when collapsed, so dialog living there take ⌘, with it — and that chord = one route into settings that survive collapsed sidebar. Open state not persisted: settings opened to change something and closed again, so reopening app into them = app remembering wrong half of session.

**Gear share titlebar strip with sidebar toggle, and order swap in fullscreen.** Strip `justify-end` normally (clearing traffic lights), `justify-start` in fullscreen (they gone). Toggle also drawn in app header when sidebar collapsed, so it must hold strip's outer edge in both layouts and never change which end it at; gear have no second home and move instead.

**Row shape = `SettingRow`**, label and control on top line, reason full width beneath. Side by side was first shape and it broke on widest control: two button push sentence into third of dialog, where four word take three line and row height jump every time control change. Description = prose and want measure; control = fixed thing and want edge to sit against.

Two rules it encode: description **not optional** — it where "why is this off by default" live — and setting that cannot apply on this platform **disabled, not hidden**, since row that vanish read as setting app forgot and sentence under it = only place reason can be said.

**Analytics row = two sentence: what it for, what it never touch.** Second one = row's whole job. "Analytics" read as behavioural tracking to most people, and for tool that watch you work on own code, saying plainly conversation and activity not collected = part worth space. Deliberately **not** itemised — listing every field read as something to be wary of rather than something to skim, which why row don't name ping, version or OS one by one.

**`Dialog` = `alert-dialog`'s frame exactly, `showClose` the one difference.** To reader two are same object and differ only in whether app asking question or reader opened something — alert answered by own buttons so carry no dismiss, dialog dismissed rather than answered, and Escape alone = way out only for people who already know it there. `--popover` not `--card`: under vibrancy `--card` become 5.5% white veil, right for surface sitting *in* page and wrong for one floating over it.

## Analytics

**One event, `app_started`, and that whole of it** ([analytics.rs](apps/desktop/src-tauri/src/analytics.rs)). Hosted Aptabase over `tauri-plugin-aptabase`. Question it answer = how many people run Dray, on what version, on what OS — and plugin stamp `appVersion`, `osName`, `osVersion`, `locale`, `engineVersion` and `isDebug` on every event itself, so call site carry no props. Nothing about what reader *do* in app measured, deliberately.

**No persistent identifier sent, and that shape not accident.** Client mint session id rolling over after four idle hours and write nothing to disk. So this count **launches, not people**: actives and version adoption answerable, retention cohort not. That Aptabase's own trade, and why no install id sit in `~/.dray` beside it — second id would answer question this deliberately don't.

**Empty key = inert plugin, and that ordinary state not failure.** `APP_KEY` come from `option_env!("APTABASE_KEY")`, so unconfigured checkout and every local build compile with none, and client's `is_enabled` drop event before it reach queue. Plugin still **registered** either way: `track` stay ordinary call rather than `Option` every call site unwrap, and managed state its trait reach for only exist once plugin do. `build.rs` declare `rerun-if-env-changed` for it — `option_env!` resolve at compile time, so key exported after first build bake in as absent until something else force rebuild. Key itself write-only and meant to ship in binary; release workflow pass it as secret so local build stay silent.

**`app_exited` deliberately absent.** It buy session duration and nothing else, and it cannot be had free: Tauri dispatch plugin `on_event` **before** app's own `run` callback (`on_event_loop_event` in tauri's `app.rs` end by calling plugin store, then caller invoke callback), so plugin's flush-on-exit already run by time anything in that callback enqueue. Sending it therefore mean second `flush_events_blocking` on quit path — `futures::executor::block_on` around request with **10s** timeout, on main thread, after window gone. Duration figure not worth putting that in front of quit.

**Flush interval 15s, against plugin's own 60s default.** Longer than good many launches — open Dray, look at running session, quit — and those run would then report only through blocking flush on exit. Free when queue empty: poll return without request.

**Opt-out live in one `AtomicBool`, because plugin cannot answer it.** Plugin decide enablement once, at `build` time, from key alone, so switch reader flip mid-run reach nothing — hence `ENABLED` here and `set_enabled` beside it, which settings command call so toggle need no restart.

**Persisted answer live in `~/.dray/settings.json`, not local storage, and timing = whole reason** ([settings.rs](apps/desktop/src-tauri/src/settings.rs)). `app_started` send from `setup`, before webview exist — so pref kept where `ade.diffStyle` and every other pick live could not be consulted until after one event it govern already gone. **Anything frontend can read for itself belong there, not here**, or this become second settings store free to disagree with first.

**Read and track folded into one `analytics::start`.** Ordering = point: `track` must not run before persisted answer in hand. Spawned inside `setup` rather than blocking it, since nothing on screen wait on it. `DRAY_NO_ANALYTICS` win one direction only — it turn reporting off, cannot turn it on over stored `false`.

**Read fail *closed*, and missing file not same case as broken one.** Missing or empty = fresh install, read as default (opted in). Anything else — unparseable JSON, unreadable file, no home dir — read as opted **out**, because file that exist and can't be understood far likelier belong to someone who turned this off than someone who never touched it. Never error either way: this sit on launch path, so hand-edited file must not stop app starting. Pinned by test, and the direction is the test worth having.

**`ENABLED` start `false`, not `true`.** `analytics::start` spawned, so window exist at launch where consent not yet read; anything reaching `track` inside it would report for someone who may have opted out. Nothing do today — `start` own only call — but second call site = exactly change that wouldn't think to check.

**Dialog draw *effective* state, not stored one.** `get_settings` answer off `analytics::enabled()`, and `SettingsView` carry `analytics_locked` beside it. Two differ whenever `DRAY_NO_ANALYTICS` set, and switch drawn from file there sit at `on` while nothing being sent — so row disable itself and name env var instead. `env_opt_out()` read in one place for that reason: two site reading same variable = how flag and switch drawn from it drift apart.

## Notifications

Three events hand session back to reader — it finished, it want permission, it asked question — and each announce itself on **exactly one channel**, chosen by where reader is. `announce` in [useSessions](apps/desktop/src/hooks/useSessions.ts) = that split, written once and shared, so no event end up on two channels:

| focused | on screen | outcome |
|---|---|---|
| no | either | desktop notification |
| yes | no | in-app notice |
| yes | yes | nothing — the transcript *is* the notification |

Middle row = one sidebar's mark alone was failing: mark beside title 400px away easy to work past for minutes. Channels exclusive not additive — card drawn for something OS already told reader = second interruption for one event, and in-app card invisible from another app anyway.

**Fourth event ignore that table entirely: PR turning ready to merge.** [usePrReady](apps/desktop/src/hooks/usePrReady.ts) raise in-app card **unconditionally** — every focus, every selection, PR tab open or not — and post no banner. Table's question = "has reader seen this happen", and for other three answer sit on screen: turn's own output = notification. This one have no such moment. CI report on someone else's schedule, and panel's own line going from "Checks not passing" to "Ready to merge" = silent two-word swap nobody watch for, so *being on PR tab ≠ having noticed*. Worst case = card duplicating something reader looking at, which cost glance; missing it cost merge. Card survive unfocused window because countdown = WAAPI animation and browser throttle it while window occluded, behaviour that section already want.

**Nothing retire it but its own clock.** Other three report something about session, which opening session settle; PR being ready true whether or not anyone look and stay true after. So no read-marking, no `ANSWERED_BY_OPENING` entry, no rail mark — it nudge toward pull request, not record of one.

**Card say "Ready to merge" and no more**, like completed and asking. Those lean on sidebar rail marking their row and this have no rail to lean on, so card name nothing at all — button = what answer which session, one card per session. Trade taken deliberately: two ready at once = two identical cards, and pressing top one still land right place.

**Signal = transition, not state.** First reading of session recorded silent, only change out of it = news: app cannot tell PR that turned green second ago from one green since last week, so announcing on first sighting open card for every landed branch on every launch. `readyTransitions` ([pr.ts](apps/desktop/src/lib/pr.ts)) own that rule and pruning that come with it — session that stop being watched (archived, filtered, repo's read not landed) **forgotten**, so it come back as first sighting. Safe direction: re-seed cost announcement never made, where remembering `false` across absence raise one for PR ready whole time row was gone. Cost of whole rule = PR turning ready while app closed never announced; row still carry it.

**Read off sidebar's marks, not panel's own fetch**, and no choice about it: panel poll gate on its tab being visible *and* active, which = exactly case with nothing to announce. So `QUERY_MARKS` grew `mergeable mergeStateStatus` on **open half only** — merged PR cannot become ready, and `mergeStateStatus` = one field GitHub compute *on being asked*, so putting it on merged connection spend that work hundred times to answer question nobody ask. `None` there read as **unknown, not ready** (`mergeVerdict`), or merged mark announce itself.

**One ordered rule, two presentations.** `mergeVerdict` = order (closed PR's merge state stale, conflict outrank failing check, `UNKNOWN` mean not-worked-out); `mergeReadiness` turn verdict into panel's sentence, `readyToMerge` ask one question notice turn on — three-valued, `null` where GitHub not worked it out, so `readyTransitions` can hold last reading instead of writing false over it (merge move base, every other open PR read UNKNOWN for window, and settle-back read as news = card per open PR per merge). Predicate written *beside* that order rather than out of it = second copy of thing that took while to get right.

**Notice now key on session *and kind*.** Store keyed on session alone before, resting on "session cannot both be blocked on question and have finished turn" — true for three kinds, false for fourth: CI report while agent stand still waiting for permission, and one card replace other. So `dismissNotice` take kind or list, every card's own countdown name its kind, and `ANSWERED_BY_OPENING` spell out three kinds opening session answer — `pr` absent, because selecting session ≠ looking at its PR.

**In-app signal = sound and card**, fired side by side from `announce` rather than one from other, so removing either leave other working. [playNotification](apps/desktop/src/lib/sound.ts) = half that carry with eyes: card in corner easy to miss while reading middle of window.

**⌘G take card without reaching for it.** Whole point of card = not having to leave what you were doing, and mouse trip to 40px button undo most of that. Act on **oldest** card — top one, next to expire — which make key repeatable: pressing twice clear two cards in order they arrived, where "newest" reshuffle what key mean every time one land. Binding live in `NoticeStack` not `App`, so it exist only while card do and ⌘G stay free otherwise. Cap drawn **on** card it act on, for [ImageLightbox](apps/desktop/src/components/chat/ImageLightbox.tsx)'s reason — card gone in ten seconds, so hint behind hover = hint nobody see — and putting it on only one card also how stack say which one key take.

**Progress bar = the timer, not picture of one.** Store hold no `setTimeout` at all: bar's `animationend` call `dismissNotice`. One clock instead of two mean hovering pause it with single CSS rule and dismissal pause with it — so card cannot vanish under cursor reaching for its button. Also mean card can't expire while window occluded and animation throttled, behaviour we want anyway. `completed` run 10s and `asking` 15s: one = news that keep, other = session standing still.

**Card going away ≠ signal going away.** Both kinds time out, and `asking` one leave session still blocked behind it — fine, because yellow rail mark stay lit until request answered and card only ever shortcut to it. `permission_decided` and opening session both dismiss it early.

**Reading require looking, so `completed` on selected session only retired when window have focus.** Other half = focus listener marking it read on return; without it session finishing in background stay unread forever, since nothing else fire for session already selected.

**Sidebar rail carry both, and they mean different things.** Green = *unread* — turn over, mark clear when row viewed. Yellow = *waiting on you* — turn still open and only answer clear it, so viewing row leave it lit. Yellow win where both could apply. Yellow = `--accent-command`, not fresh amber: app keep to one yellow, and that one already mean "this is for you" wherever slash command drawn. Card's progress bar use same pair, so thing that raised alarm and mark it send you looking for are same colour. Waiting set frontend-only (`asksBySession`, request ids so `permission_decided` retire right one) and deliberately **not** folded into `SessionStatus`: backend report these sessions `in_progress` and right to, since turn genuinely hasn't ended — only agent stopped. Unpersisted for same reason requests themselves are, and cleared when status leave `in_progress`, what stop stranded request marking dead session as waiting forever.

**Dock badge = that same pair, counted** ([attention.ts](apps/desktop/src/lib/attention.ts), [useDockBadge.ts](apps/desktop/src/hooks/useDockBadge.ts)) — one predicate shared with rail (`asking || status === "completed"`), so number = promise about what opening window show rather than second definition free to disagree with list. Need no clearing path of own: both marks retire themselves, so count drain through same route rail empty by, and `0` go out as `undefined` because that remove badge where zero would draw one.

Counting read three sources, each covering hole others leave. `statusBySession` empty at launch, where index carry `completed` that survived last run; index list hold one side of archived split at a time, so session can leave it while still unread, which live map catch; and `asksBySession` nowhere in either, being frontend-only. Live status win over persisted where both exist — reading row clear it this run while index item still say `completed`.

Two Tauri facts. `core:window:allow-set-badge-count` **not** in `core:default` — default set stop at `allow-internal-toggle-maximize` — so it named in [capabilities/default.json](apps/desktop/src-tauri/capabilities/default.json) for `start-dragging`'s reason and with `start-dragging`'s failure mode: ACL refuse and report nothing, which look exactly like badge never wired up. And unlike desktop banner this one **does** work under `pnpm tauri dev`, since it dock tile rather than `UNUserNotificationCenter` and want no bundle.

**Focus read imperatively, never as state** ([focus.ts](apps/desktop/src/lib/focus.ts)). One caller that matter sit inside Tauri event listener registered once with `[]` deps, where state value = mount-time one forever — same reason `selectedSessionIdRef` exist beside it. Source = Tauri's `onFocusChanged`, not DOM's `blur`: webview blur whenever focus leave document, which native menu or devtools do without user leaving app, and each would have fired banner. `getCurrentWindow()` *throw* rather than reject outside Tauri, hence `try` around it and DOM-event fallback for `pnpm dev`.

Notice store ([useNotices.ts](apps/desktop/src/hooks/useNotices.ts)) module-level for [useDraft](apps/desktop/src/hooks/useDraft.ts)'s reason: push site and render site far apart, and threading setter between them put toast plumbing through `useSessions`' return. Keyed by session id alone, so session raising second notice replace own row rather than stack duplicate — nothing lost to that, since session cannot both be blocked on question and have finished its turn.

**Desktop banner posted from Rust, not from `tauri-plugin-notification`** ([notifications.rs](apps/desktop/src-tauri/src/notifications.rs)). Plugin cannot deliver click on desktop and no configuration make it: its desktop path spawn `show()` and drop returned handle, only thing click reported through, and its `onAction` listener wired to event only mobile backends emit. So banner it post inert — worth knowing, because it *look* like it work: macOS raise app on click by itself, so window come forward and then sit on whatever session was already open.

Posting directly = what buy click. `notify_session` wait on handle, and `"default"` — banner body, against `"__closed"` that dismissal and expiry both report — raise window and emit `notification_activated` with session id, which `useSessions` turn into select. Wait block until reader act or banner age out, hence `spawn_blocking`: one parked thread per banner on screen. **Raising window and selecting session separate and both needed** — being frontmost select nothing.

Banner = mirror of card: verb = **title** ("Needs permission", "Task finished") and session title = body. Project name dropped — least useful of three when reader choosing whether to switch, and banner have room for two lines.

**Banner with no sound name delivered silently**, wrong default here — this channel only fire when reader in another app, where they can neither see in-app notice nor hear sound it play. notify-rust call `setSound` only when `sound_name` set at all, so fix = one call, and value = trap: `""` read like "no sound" and is opposite, being name `UNNotificationSound.soundNamed:` resolve to **system default**. Verified by ear against named one. Kind pick between them (`sound_for`) and travel from `announce` for that alone: `asking` get **Ping** because question left unanswered hold session open, so it should not sound like default reader hear from every app all day; `completed` take default, since it news that keep.

**`preview-macos-un` not optional feature here — without it nothing delivered at all.** notify-rust's default macOS backend = `NSUserNotificationCenter`, deprecated one, and current macOS not deliver it for app. Measured from inside running app on 26.5: every shape — plain/async, button/async, button/sync — timed out at exactly 2.0s with nothing on screen, while *same code* in plain CLI process delivered clickable banner. Process = whole difference, so no amount of tuning notification fix it; `tauri-plugin-notification` post same way and would fail identically.

**Desktop banner cannot work under `tauri dev`, and guard against trying = `is_dev()`.** `UNUserNotificationCenter` reach for running process's bundle and raise **uncaught** `NSInternalInconsistencyException` — `bundleProxyForCurrentProcess is nil` — when there isn't one, aborting app rather than returning error. Dev binary run from `target/debug`, exactly its case. `check_bundle` *not* guard to reach for: it only ask whether bundle *identifier* exist, and embedded `Info.plist` satisfy it — it answered `Ok` for dev binary right up to frame that killed it. So dev get in-app card and sidebar rail, and that whole signal there.

**Bundle need signing identity or macOS refuse permission silently.** Tauri's bundler leave app linker-signed under generated identifier (`dray-bdb0d4e7ac1e468d`), not matching `CFBundleIdentifier`, and with that mismatch `request_auth` return `Ok(false)` with status `NotDetermined` and **no prompt ever shown** — failure look exactly like broken notification path. `bundle.macOS.signingIdentity: "-"` in [tauri.conf.json](apps/desktop/src-tauri/tauri.conf.json) fix it: ad-hoc, but signed as `com.yogesh.dray`, after which prompt appear and banner land. Real distribution build want Developer ID for other reasons; this = floor below which notifications don't work at all.

**Permission asked once per process, on first banner rather than at startup** (`request_auth_once`). Call **block until reader answer dialog**, so per-banner ask park thread per notification behind one prompt, and posting before answer land refused outright. Asking on first banner also put dialog in front of someone who just seen why app want it. Nothing branch on result: denial silent and permanent, refused post already log, and in-app notice cover reader either way.

Whole path best-effort: failed post logged and dropped ([notify.ts](apps/desktop/src/lib/notify.ts) swallow invoke too). It *secondary* channel — sidebar rail survive it — so failure must never reach reader as error. On macOS OS-level permission = only gate that matter, and denial silent; plugin's `isPermissionGranted` never that gate, since its desktop implementation return `Granted` unconditionally.

## Parser conventions

[parser.rs](apps/desktop/src-tauri/src/harness/claude_code/parser.rs) file most likely to need extending, and it have firm conventions:

- `ClaudeCodeEvent` = externally-tagged enum on `type` (`#[serde(tag = "type", rename_all = "snake_case")]`). `SystemEvent` and `ResultEvent` nest **second** tag on `subtype`. Adding new CLI event = adding variant at correct level.
- `stream_event.event` fully modeled as `StreamFrame`. Every stream enum carry `#[serde(other)]` catch-all so one unknown frame type don't cost whole line.
- Genuinely volatile payloads (`message`, `usage`) stay as `serde_json::Value`.
- Fields CLI may omit need `#[serde(default)]`. CamelCase wire fields need explicit rename — see `permissionMode`, `apiKeySource`, `modelUsage`.
- **Field CLI may send as `null` need `null_as_default` as well as `default`.** Two not same thing and difference invisible until it bite: `default` answer for key that _absent_ and do nothing for key present and null, which then fail against any non-`Option` type. `usage.iterations` = captured case — ordinary message omit it, **synthetic** one (`model: "<synthetic>"`, reply to built-in slash command) send it as null. That failed whole line, so every built-in command silently produced empty turn while skills, which answer through real model turn, worked fine. Reach for `Option<T>` where absence meaningful and `null_as_default` where not.
- **Failures swallowed, per line, and filed.** `read_stdout` log and continue rather than propagate — one bad line can't kill loop — so schema mismatch present as missing UI update, not error. Every one also land in `~/.dray/parse_failures.jsonl` with raw line: one file for whole app, because these describe how well _this build_ cover wire format. `stage` = `parse` (no variant matched), `map` (mapper errored), `unknown_subtype` (`#[serde(other)]` arm caught it, so line survived but we learned nothing), or `unsupported_request` (control request we had to refuse to keep turn moving — only stage changing what agent do, so treat as urgent one). Read it after testing session — `jq -r '.stage + " " + .detail' ~/.dray/parse_failures.jsonl | sort | uniq -c` — rather than grep stderr.
- **Line worth no UI still worth modelling, to keep that log a signal.** `tool_progress` = liveness ping every 30s on long call, all `heartbeat: true`, and it was **a third of whole failure file** — which only useful while everything in it = real gap. Parsed and mapped to `None`; nothing drawn, since tool row already shimmer for exactly as long as call pending. Same reading apply to next high-volume line that turn out to say nothing.
- `McpServer` and `ApprovalPolicy`/`PermissionMode` defined once in `events` and re-exported by parser. Don't reintroduce per-harness copies.

**Outbound lines typed too, in [control.rs](apps/desktop/src-tauri/src/harness/claude_code/control.rs).** `ControlRequest` = enum tagged on `subtype`, `ControlLine` = envelope minting `request_id`; adding control = adding variant, same as inbound. Typed despite nothing here being able to fail at runtime, because wrongly shaped request not reported — CLI answer what it recognize and stay quiet otherwise, so drifted envelope present as control that silently stopped working. Same failure mode malformed `control_response` have going other way. `write_line` take `impl Serialize`, so `json!` still fine for one-off shape and struct earn its keep where envelope repeat.

## Test fixtures

Tests use `include_str!` against real captured CLI output under `harness/<name>/fixtures/`:

- `claude_code/fixtures/printed.jsonl` — small smoke fixture.
- `claude_code/fixtures/complex.jsonl` — 176 lines with subagent/task traffic. Assertions hard-code exact counts, so editing this file break tests by design.
- `claude_code/fixtures/multi_turn.jsonl`, `interrupted.jsonl` — turn boundaries and mid-turn interrupt.
- `claude_code/fixtures/interrupted_tools.jsonl` — `interrupt` control request landing mid-tool-call: `control_response` ack, `terminal_reason: "aborted_tools"`, `local_bash` background task (no `subagent_type`, no `usage`), and only capture with `thinking_tokens`.
- `claude_code/fixtures/background_bash_monitor.jsonl` — `Bash` with `run_in_background` plus `Monitor`, captured live against v2.1.247. Both register as `local_bash`; `result` land with both outstanding. What settled that tasks must not hold turn.
- `claude_code/fixtures/permission_allow.jsonl`, `permission_deny.jsonl` — same `touch` under `manual` with `--permission-prompt-tool stdio`, approved and refused. Only captures of inbound `control_request`, and what pin field names reply built from. Note what denied one _lack_: no `permission_denied` line, because question was answered.
- `claude_code/fixtures/permission_denied_system.jsonl` — same `touch` with no answer channel open, so CLI refuse alone and say so on `system` line.
- `claude_code/fixtures/ask_user_question.jsonl` — one `AskUserQuestion` carrying two questions, second `multiSelect`, plus tool result answered call produce. Only capture of `requires_user_interaction`.
- `claude_code/fixtures/builtin_command.jsonl` — `/rename` answered by CLI itself. Three lines, and only capture of **synthetic** assistant message: `model: "<synthetic>"`, every token count zero, `usage.iterations` sent as explicit `null`. That null what made every built-in command look broken, so this fixture keep `null_as_default` honest.
- `claude_code/fixtures/compaction.jsonl` — manual `/compact`, driven over stdin like any other prompt. Only capture of `compact_boundary`, of `result` with null `stop_reason` and no `terminal_reason`, and of `isReplay`/`isSynthetic` user lines.
- `claude_code/fixtures/image_read.jsonl` — `Read` of 8×8 `.png`, captured live against v2.1.241. Only capture of `image` block in tool result, and of same bytes riding `tool_use_result` sidecar as `file.base64`. Tiny image deliberate: fixture pin shape, not size.
- `claude_code/fixtures/file_write.jsonl` — 396-line (12KB) `Write`, then `Edit` and `Read` of same file. Only capture of tool call whose arguments take real time to stream: 60 `input_json_delta` fragments over 39.5s, what streaming preview built and tested against. Also what pin key ordering that preview depend on (`file_path` before `content`, `replace_all` ahead of both on `Edit`). Read by `pnpm test`, not by `cargo test`.
`github` fixture sit outside that tree, at `src-tauri/src/fixtures/pr_graphql.json`: real `gh api graphql` capture of PR carrying Vercel status context, two app-owned check runs, two bot comments, review with body, two **bodyless review envelopes**, and four inline threads split across three reviews — one resolved, two hanging on line GitHub since forgot, and one review holding two at once. It what pin both rollup shapes, null `reviewDecision`, thread-to-review join, and **avatar on every one** — each an image no `<login>.png` guess could have produced. Thread with actual **reply** absent from it, so that shape hand-written beside it. Not JSONL — one GraphQL answer = one JSON document.

- `codex/fixtures/rollout.jsonl` — session _replay_ log, not live protocol. Do not write Codex parser against this.
- `codex/fixtures/live_simple.jsonl`, `live_tools.jsonl` — real `codex exec --json` output, what Codex parser must target: much simpler item lifecycle (`thread.started`, `item.started`/`item.completed`, `turn.completed`).

To add coverage, follow same pattern: capture real CLI output, commit as fixture, assert against it. Shapes absent from every fixture (Claude Code `thinking` blocks) get hand-written tests pinning documented shape.

Fixtures = shared asset here, not Rust test suite — frontend test needing real wire output read same file rather than commit second capture. Both `Bash` and `Read` appear in several fixtures; `Write` and `Edit` appear only in `file_write.jsonl`, why streaming preview shipped before anything covered it.

## Rendering code

Every surface showing code — `Edit` diff, ranged `Read` slice, markdown code blocks — go through **one** Shiki highlighter, shared instance inside `@pierre/diffs`. That single instance = whole design:

- [DiffView](apps/desktop/src/components/chat/DiffView.tsx) render `file_edit` call's two sides via `FileDiff`.
- [CodeView](apps/desktop/src/components/chat/CodeView.tsx) render ranged `file_read` via `File`.
- [codePlugin.ts](apps/desktop/src/lib/codePlugin.ts) = Streamdown `code-highlighter` backed by same instance, replacing `@streamdown/code`'s runtime (package survive as type-only import).

Sharing not just deduplication. Stock Streamdown plugin build _second_ Shiki with own theme and grammar registries — which both duplicate grammar loading and cannot see `pierre-*` at all, failing with "Theme `pierre-light` is not included in this bundle".

**Themes = `{light, dark}` pairs, never one name** ([codeTheme.ts](apps/desktop/src/lib/codeTheme.ts)). App's mode can change under mounted view — `system` follow OS — and dark syntax theme on light page unreadable. User pick one entry; resolved mode pick side. [useCodeTheme](apps/desktop/src/hooks/useCodeTheme.ts) = `useSyncExternalStore` not `useLocalStorage` because several diffs and code blocks mounted at once and per-component state desync them.

Three failure modes, all present as _code that render but blank or grey_ rather than as error:

- **View must not mount before _its own_ language and theme attached.** `FileDiff`/`File` kick off own load when they hydrate without one, then drop promise and never re-render — so premature mount paint empty or unhighlighted `<pre>` and stay that way until something remount it. [useHighlighter](apps/desktop/src/hooks/useHighlighter.ts) = single gate both views use, check `getLoadedThemes()`/`getLoadedLanguages()` for specific pair and language. Do not gate on `isHighlighterLoaded()`: it only report _instance_ exist, so view whose grammar still loading mount moment any other view warmed highlighter, and render grey until collapsed and expanded again.
- **Themes and grammars load independently.** Tokenizing with theme unattached return every token with empty style; tokenizing with _grammar_ unattached silently yield one plain-text token per line. `codePlugin` therefore check `getLoadedThemes()` _and_ `getLoadedLanguages()` and report not-ready instead of caching either result — caching plain-text fallback what left blocks permanently grey.
- **Fence's info string = language id, not filename.** `getFiletypeFromFileName` map _extensions_, so it turn `typescript` and `rust` into `text` while only `ts` happen to work. Use for path (`CodeView`, `DiffView`), never for fence tag.

**Streamdown's link hardening write into prose, so we replace its rehype list** ([markdownPlugins.ts](apps/desktop/src/lib/markdownPlugins.ts)). `rehype-harden` drop href it cannot resolve — right — then leave literal ` [blocked]` beside link, which land in reader's text as if agent typed it. Two ordinary shapes hit it: Greptile's severity badge = `<a href="#">` round image, and harden's hash-only branch compare `new URL("#", base).hash` against `"#"` where it `""`, so bare fragment fall through to parse that throw; and bare relative path in agent output (`src/foo.tsx`) start with none of `/`, `./`, `../`, so never parsed either. `linkBlockPolicy`/`imageBlockPolicy` = `text-only` unwrap instead of annotate. Streamdown expose no option for it, so whole `rehypePlugins` list passed — raw and sanitize named beside harden, and **harden's own function taken back out of `defaultRehypePlugins`** rather than from direct dep, which pin it to version Streamdown itself run.

`File` number file from 1 and expose no starting-line option, so `CodeView` rewrite gutter in `onPostRender` — which hand back _host_ element, whose rows live in its shadow root. Padding content with blank lines also work and then collapse: `offset` of 420 render 419 empty rows.

**Every diff side carry content-derived `cacheKey`** (`diffSide` in [diff.ts](apps/desktop/src/lib/diff.ts)). Library fall back to file *name* as key and worker pool cache highlighted lines on key alone — so second `Edit` to same file, or `index.ts` from another dir, reuse first one's tokenized result and longer diff walk off its end: "deletionLine and additionLine are null", thrown mid-render. Key = full path + length + FNV-1a of text, so new content can only miss cache. Never hand `parseDiffFromFile` bare `{name, contents}`.

**`+N -M` come from library's hunks, not hand-rolled scan.** `countChanges` parse diff and sum `hunk.additionLines`/`deletionLines` so collapsed row can never disagree with diff it open. Prefix/suffix scan look equivalent and isn't: `Edit` fragments usually arrive without trailing newline, so diff algorithm treat boundary line as changed on both sides — appending two lines to `"a\nb"` render as `+3/-1`, not `+2/-0` scan report.

**Group header carry same figure, summed over its calls** ([ToolGroupRow](apps/desktop/src/components/chat/ToolGroupRow.tsx)), from those same per-call counts. Without it run collapsed to "Edited 1 file · 4 calls", which say nothing about how much changed. These _region_ counts, not file counts: `Edit` diff its replaced fragment not file, so sum = run's total churn and not what `git --stat` report. Memoized on call count not on `calls`, since committed call's input immutable and run only grow; keying on array re-parse every diff in group on each render of streaming turn.

**Where time go — two costs, scaling with different things.** Grammar _attach_ per language and one-off: entire `COMMON_LANGS` set attach in **~54ms** batched, while **Ruby alone ~390ms**, since it drag in HTML, CSS, JS and SQL for embedded syntaxes. _Tokenizing_ per file and scale with whole file, not change — `renderDiffWithHighlighter` force `startingLine 0 / totalLines ∞` and tokenize both full sides. With grammars attached: 300-line TSX ~110–180ms per side, 850-line TS ~750ms, 1300 lines of Rust ~160ms — TS/TSX = expensive grammars by nearly order of magnitude. Transcript `Edit` diff only carry its fragment, so tokenize cost round to zero there; changes panel diff whole files, where this bite.

**Long session open on its newest turns, and backfill the rest.** Opening 11MB, 61-turn log measured ~700ms, and bytes not why: Rust parse 17–34ms, serialize ~10ms, `JSON.parse` ~20ms, `buildTranscript` 5ms. What cost = mounting every collapsed turn's answer through Streamdown at once — 150–260ms in `renderToString` for 53 answers, before DOM commit and layout. So [Chat.tsx](apps/desktop/src/components/Chat.tsx) draw newest `FIRST_MOUNT` turns on first commit (4 answers, ~12ms) and mount older ones above in `MOUNT_STEP` chunks, one per macrotask ([turnWindow.ts](apps/desktop/src/lib/turnWindow.ts)). Each step grow content *above* what reader look at: pinned, bottom re-taken; unpinned, oldest mounted turn's node anchored before step and `scrollTop` moved by exactly what it moved — height diff wrong there, since delta or highlight landing below anchor in same gap would count as backfill. Rail list every turn either way, and jump at unmounted tick mount all then jump once node exist. Not virtualised: backfill finish in well under a second and then whole transcript = ordinary DOM, so nothing else here need to know window exist. Withholding tool result bodies from open payload (78% of bytes) considered and left — ~50–80ms, and `buildTranscript` read only result's envelope, so it separate change if ever wanted.

**Diff highlighting run in worker pool** ([DiffWorkerPool.tsx](apps/desktop/src/components/DiffWorkerPool.tsx)) — without one, those whole-file tokenizes ran on main thread and expanding row froze app up to second. `FileDiff`/`File` pick pool out of `WorkerPoolContext` on own; with it present they paint unhighlighted diff immediately and patch colors in when worker answer, and pool failure fall back to main-thread path (`isWorkingPool`) rather than error. Three wiring facts worth keeping: worker built by Vite's `?worker` import (library take factory because it cannot know host's bundler), `worker.format: "es"` in [vite.config.ts](apps/desktop/vite.config.ts) keep worker's conditional `import("shiki/wasm")` from being inlined as ~600KB into iife worker, and pool's theme **override** each view's `theme` option, so `PoolThemeSync` push theme-pair changes to pool via `setRenderOptions` (singleton read `highlighterOptions` only at creation). Pool size 2, not default 8: each worker boot own Shiki, and app open one diff at a time. `codePlugin` (markdown fences) still tokenize on main thread — fences small.

That spread why `warmHighlighter` preload _named list_ rather than everything or nothing. `COMMON_LANGS` in [useHighlighter.ts](apps/desktop/src/hooks/useHighlighter.ts) = set this app actually used on (TS/TSX, JS/JSX, Python, JSON, CSS, HTML, Markdown, YAML, Bash, Rust, Go, SQL, TOML) — cheap enough to pay for once at startup, off critical path. Keep it that way: not "preload everything" list, and adding Ruby-shaped grammar cost more than whole current set. Anything absent still load lazily on mount and pay only own grammar, rendering _unhighlighted but readable_ text meanwhile rather than empty frame.

## Current state

Several things deliberately unfinished — don't mistake for bugs:

- **UI still active area.** Sidebar, transcript, composer toolbar built; no project _management_ beyond attach (no rename, no detach from UI).
- **Only _ranged_ `Read` render its code, whole-file read have no expander at all.** Successful whole-file read = dead end on purpose — no diff, no code, no arguments, and its result = file itself. That read = agent pulling file into context, not showing it to reader. Range come from call's own `offset`/`limit`. _Failed_ read still expand, since its error text only place reason live. **Read of image = exception, see _Picture a tool hand back_ below** — it answer in no text at all.
- **Code theme have no picker yet.** `CODE_THEMES` and `setCodeTheme` = settings surface's whole contract; nothing call setter today.
- **Mapper partial.** `assistant`, `user`, `result`, `system/init`, tasks, `background_tasks_changed`, `compact_boundary`, `permission_denied`, `can_use_tool` (both as consent and as `AskUserQuestion`), and stream frames wired; hooks, `post_turn_summary`, `task_updated`, `control_response` still fall through to `None`. `result.permission_denials` also unmapped — every denial it list already arrived as own event. `status` mapped for two values — `compacting` and `requesting`. `SystemEvent` have `#[serde(other)]` catch-all, so unknown subtype degrade instead of failing line (`thinking_tokens` arrived unannounced and did exactly that). `turn_id` always `None` — deliberately: Claude Code have no turn identifier on wire, UI group transcript by user message, and promptless agent-opened `init` mean minting our own ids split what reader see as one exchange.
- **Compaction = two events, from different lines.** `system/status` with `status: "compacting"` open it; `system/compact_boundary`, carrying `trigger`/`pre_tokens`/`post_tokens`/`duration_ms`, close it. `status` = general channel — `requesting` ride it too — so mapper gate on value, not subtype. Wire also send `status: null` with `compact_result: "success"` between the two; deliberately unparsed, since boundary = same signal with numbers attached. **Live protocol snake_case here and replay log under `~/.claude/projects` camelCase** (`compact_metadata` vs `compactMetadata`) — writing this against replay log fail silently. Every metadata field `Option` so unseen shape still _close_ indicator; parse failure there leave it spinning forever. `cumulative_dropped_tokens` not carried: it sum every compaction in session, so what one compaction saved = `pre_tokens - post_tokens`.

- **Compaction leave two user lines behind and neither conversation.** Summary come back as prompt flagged `isSynthetic`, `/compact` echo as one flagged `isReplay` — one flag each, so dropping them take both. No tool result in any fixture carry either. Mapper drop them: this app mint own user events, and session log serve UI rather than reconstruct model's context.

- **Rate limit only event when bad news.** CLI report `rate_limit_event` on roughly every turn, so mapper emit one only when `RateLimitInfo::is_noteworthy()` hold. Check = "not a known-good state" rather than list of bad ones, so unrecognized _or missing_ status surface instead of being assumed healthy — but `HEALTHY_STATUSES` what grow, and **only from capture**. Started at `allowed` alone and that wrong: `allowed_warning` arrive with `utilization` around `0.93` to say window _approaching_ full, and reading it as trouble put "Usage limit reached" on screen during ordinary turn. Approaching limit want own quiet surface (`is_approaching()`, unused so far). Wire's own strings (`status`, `overageStatus`, `rateLimitType`) carried through rather than collapsed into `blocked` boolean, because vocabulary beyond `allowed`/`rejected` unconfirmed; `five_hour` only limit type captured, so nothing branch on it. `resetsAt` unix seconds and every other timestamp here RFC3339 — `rfc3339_from_unix` bridge that.
- **Three payloads emitted but never persisted.** `read_stdout` drop `Delta`, `UsageUpdate`, `ModelRequestStarted` before log write. Deltas superseded by committed event; usage update = running counter whose final value land on `turn_completed`, and `thinking_tokens` alone fire dozens of times per turn. `ModelRequestStarted` go for both reasons at once: no request survive process that made it, and it fire once per turn _and_ once per tool result — 89 times in one captured session.
- **Context occupancy stored nowhere.** Composer's ring read it back out of session's own events, because everything moving it persisted already: `turn_completed.usage.contextWindow` for turn, `context_compacted.postTokens` for what compaction left. `used` and `max` collected in one backward pass but independently — boundary report what it kept and not how large window is, and turn before it do reverse. `context_compacted` settle `used` even when it carried no count, since earlier turn's figure not fallback there but wrong and high answer.

  **`result.usage` = per-turn sum, not context reading.** Its four counts summed over every main-thread message in turn, and agentic turn re-read whole context once per tool call — so it report context multiplied by number of steps. `multi_turn.jsonl`'s first turn claim 401103 against real occupancy of 41102. Its output figures equally partial: two turns of `complex.jsonl` report 239 and 485 output tokens against 4682 actually produced, so turn's real consumption nowhere in `Usage`'s own fields either. `Usage.per_model` carry `modelUsage` map for that: session-cumulative and monotonic, so turn's figure = difference between consecutive readings. Persisted rather than deferred, because log append-only and CLI's output gone once process exit — anything not captured now = permanent hole.

  `modelUsage` stay `Value` in parser and read field-by-field in `map_model_usage`. Deliberately: this ride `turn_completed`, and serde reject whole `result` line over one field that changed type — which strand session on `in_progress`. Unfamiliar shape must cost one field, never line.

  Two wire facts behind gauge. **Used = one message's four counts summed** — `input + cache_creation + cache_read + output`, disjoint slices of single prompt — and _which_ message = whole subtlety. Must be turn's **last main-thread `assistant`**, tracked in `Mapper::last_occupancy` and handed to `turn_completed` when turn close; subagent's messages skipped, since it run own context. **Single-message turn hide distinction completely**, because sum then = last message — why `compaction.jsonl` agreed with own `pre_tokens` to within two tokens and summing bug shipped anyway. Reading one message cost tail of final message's output: 34 tokens on 31k context. Gauge = proportion, and being slightly light invisible where being multiple out not.

  **Max come from that same map's `contextWindow`**, so no window hardcoded per model and million-token model need no code; mapper remember `init`'s `model` to index it, since subagent on second model put two entries in it. Compaction clear tracked reading, so zeroed `result` landing _after_ boundary can't carry pre-compaction figure over `post_tokens` just published.

- **Session status = state machine in `session.rs`, and it follow the turn alone.** `StatusTracker`: send or `init` → `in_progress`; `result` → `completed`, whatever background tasks outstanding. Background subagent run past `result` and CLI open promptless `init` later to report findings — that `init` reopen `in_progress` on own, so nothing gained by holding. Holding *was* the rule and it hung every session running a dev server, `Bash(run_in_background)` or `Monitor` — all `local_bash` (captured in `background_bash_monitor.jsonl`), and none ever end on own — until reader clicked Stop. Task set recorded beside status for two thing only: `has_outstanding_work()` (model call open *or* tasks outstanding) guard child-replacing paths — effort respawn, update install — and Stop's `stop_task` fan-out name each id. Fork **not** among them: it replace no child, so it guard on `turn_in_flight()` alone (see _Forking a session_). Frontend keep tasks in live `tasksBySession` map, not off log: task outlive its turn, so `busy` no longer say whether log's last set current. `read_stdout` mint empty `background_tasks_changed` when child exit, since CLI cannot announce own death and last set would stand forever — emitted, **never logged**: live map need no closing entry, and it run after delete removed the file, where append would recreate it. Turn ending with task open keep its asks (task's subagent may be one asking); drain with no turn running clear them. `buildTranscript` take live task ids and keep spawning call pending while its task live — join = `SubagentRun.taskId`, since `task_id` ≠ `tool_use_id`. `completed` mean finished _and unread_: frontend clear it to `idle` when user view session (`mark_session_idle`), and persisted `in_progress` reset to `idle` at startup since no child survive restart. Status changes reach frontend as `session_status` events — derived state, never written to `.jsonl` log.
- **Codex run, over `codex app-server`, and it partial.** Session spawn, stream, resume and Stop; transcript draw message, reasoning, shell call and file diff; context ring fill. **Approval wired**, and option = server's own: Codex send `availableDecisions` and each button carry one back untouched, same bargain Claude's `permission_suggestions` make. Real capture offer *no* refusal at all (`accept`, amendment, `cancel`), so `decline` added where server name none — card with no way to say no cannot be answered honestly. Codex split stance into two setting where Claude have one — `approvalPolicy` = when it ask, `sandbox` = what command may touch, OS-enforced — so Dray's mode widen into pair, and composer hide Plan there since Codex name no plan mode. `acceptEdits` removed from Dray outright (Claude included): it apply edit without asking while still asking about command, promise too narrow for button beside Auto; `#[serde(alias)]` keep old index entry loading as `auto`. Fork refuse outright, before it copy anything. Image prompt absent; model, effort and mode change by respawn, since stance = approval policy *plus* sandbox and only first have turn-level form. Worktree work by other route — Codex have no `-w`, so Dray make tree itself at base CLI would have resolved, same path `dray new --from` take. **Read [CODEX.md](apps/desktop/CODEX.md) first** — plain-language, and it carry four thing that bite: `tokenUsage.last` = occupancy where `total` = cumulative (same trap `result.usage` set), stale `codex` on PATH with no `app-server` subcommand answer nothing for 30s, `turn/interrupt` refuse without `turnId` so Stop must track running turn, and `thread/start` drop `effort` in silence so it ride every `turn/start` instead. Deep design, rejected alternative and staging = [CODEX-PLAN.md](apps/desktop/CODEX-PLAN.md).- **Composer toolbar = session's control surface.** [composer/](apps/desktop/src/components/composer) hold one component per control; `ComposerToolbar` hide project, branch, worktree toggle once session exist. `ChatInput` take row as `ReactNode` so it keep owning layout and measurement and nothing else.
- **`isNewTask` = composer's two presentations, not one flag per effect.** Before session exist composer stand alone mid-window, so [ChatInput](apps/desktop/src/components/ChatInput.tsx) drop card's fill, border, padding, move toolbar above input, swap placeholder, replace send button with "Press ⏎ to send" hint. Dropping button safe only because Enter-to-send live in `onKeyDown` rather than in that button being form's submitter — make it submitter again and empty state lose its send path. `AppShell` have own `centered` prop for surrounding geometry. Horizontal alignment hand-tuned to single edge: toolbar's `-ml-2.5` cancel its `px-1` plus ghost button's 6px icon inset so `+` _glyph_ land on text edge. Change that button's size or variant and offset have to move with it.
- **Draft belong to session, not to composer.** [useDraft](apps/desktop/src/hooks/useDraft.ts) key unsent text by session id, with `null` for new task. Store **module-level, and ref would not do**: `AppShell` render footer at different position when `centered`, so moving between empty state and session unmount `ChatInput` and mount fresh one — losing draft on exactly switch most likely to be made. Writes go through to map as they happen, which make switch and unmount same case. Nothing persisted — restoring draft a week later read as composer having text in it for no reason. Caret reset to end on every switch, because picker state left over describe text this composer never had caret in.
- **Slash command = prompt, not protocol.** `/compact`, custom command, skill, plugin's namespaced `railway:deploy` — every one travel as ordinary prompt text on same stdin line as prose, and CLI expand it on own. So _sending_ one needed no new code, and nothing new arrive on wire either. Verified live: custom `/hello world` ran ordinary turn, and unknown `/nope` came back as `assistant` text block plus `result` with no model call in between — so typo cost round trip, not error path.

  Two things follow. Transcript cannot tell command from prose, because CLI never echo prompt back and app's own `user_message` hold whatever was typed — so [UserMessage](apps/desktop/src/components/chat/UserMessage.tsx) re-parse text with `parseSlashCommand` to draw name as chip. And command _list_ = only part that needed backend at all.

- **Command list come from `initialize` control request, not from `init`.** `system/init` carry `slash_commands` array, wrong source twice over: arrive only once turn under way, so cannot populate picker for composer with no session yet, and carry bare names where picker want description and argument hint. [commands.rs](apps/desktop/src-tauri/src/harness/claude_code/commands.rs) instead spawn throwaway child, write one `initialize` control request, read reply, kill it: ~1.5s, 147 commands, **no model call**.

  Reply double-wrap exactly like permission decision do in other direction, and carry `agents`, `models`, `output_styles` and account alongside `commands`. Only `commands` read: everything else already sourced from somewhere this app trust more.

  Walking `~/.claude/commands` and plugin cache = alternative, rejected: CLI merge user, project, plugin and skill scopes and namespace results, so local walk reproduce internals free to change. Results cached per directory on **both** sides — backend for process, frontend across mounts — because project- and local-scoped commands make list per-repo and composer remount on every session switch. Neither cache invalidate, so plugin installed while app open need restart.

- **`@file` = same bargain as `/`, and needed even less.** CLI parse `@path` out of prompt itself, read file, inject as system reminder _before_ model turn — so no tool call on wire, no new event, nothing to map. Verified live: prompt naming three files answered from all of them in one turn (`num_turns: 1`, zero tool calls), and path that don't exist ignored rather than fail turn. Mention resolved against child's own cwd, so worktree session mention paths inside its tree with no rewriting.

  So, like command, whole feature = picker. Unlike command, mention = word _inside_ sentence: can appear anywhere, any number of times, and have to be told apart from `@` in email address. [mention.ts](apps/desktop/src/lib/mention.ts) therefore find token around caret rather than key off position zero, and email guard fall out of that walk for free — scan back from caret stop at whitespace, so landing on `@` prove it open word. Path containing space can't be mentioned; CLI's limit, not picker's.

- **File list = in-memory index, not spawn per keystroke.** [files.rs](apps/desktop/src-tauri/src/files.rs) wrap [`fff-search`](https://github.com/dmtrKovalenko/fff), which walk tree once on background thread and answer from memory after. Measured on this repo: **0.17ms** to hand back handle, **25ms** to index 162 files, **0.4–2.2ms** per query _in debug build_ — against ~15ms of process overhead for single `git ls-files` spawn that then have to rank own output.

  Speed not only reason. Typo tolerance (`evnts.rs` find `events/events.rs`), path-segment matching (`composer/Model` find `ModelSelector.tsx`), and git-status ranking come with it, and last what make **empty query right thing to open on** — bare `@` list what current turn been touching. Filesystem watcher keep index current, one place this differ from command cache next door: file agent just wrote mentionable without restart.

  Two limits deliberate. `SharedFrecency::noop()` — crate's frecency tracker = LMDB store fed by host editor's access log, and this app have nothing honest to write into it. And `MAX_INDEXES` cap live indexes at four, because each = resident memory plus watcher; dropping one cancel its background threads on own. Everything touching index go through `spawn_blocking`: search hold `parking_lot` read guard across whole scoring pass, which must not be held across await.

- **Attachment = two features, because two kinds travel two ways.** [attachments.rs](apps/desktop/src-tauri/src/attachments.rs) decide which from extension _and_ size together, so composer's tile and wire can't disagree. **Image** — png/jpeg/gif/webp under 5MB, what API accept — become base64 `image` content block alongside prompt on same stdin line. Anything else become `@/abs/path` mention appended to prompt text, so non-image attachment need no wire surface at all: it prompt text by time it leave Rust, and CLI read file itself. Both verified live. Cheapness of second route = point — 40MB CSV cost path rather than context window — and also why oversized or unsupported image _degrade_ to mention instead of failing send.

  **Only paths cross bridge.** `read_attachments` hand composer thumbnail as `data:` URL; `send_msg` take back path and re-read file. Paying read twice cheaper than holding every attachment's bytes in frontend and uploading them again.

  **Image copied into `~/.dray/attachments/<session-id>/` before its path recorded**, and `user_message.images` point at copy. Persisting base64 instead put megabytes into append-only log read whole on every open; pointing at original instead break transcript moment screenshot cleared out of `~/Downloads`. Transcript load that copy through `convertFileSrc`, why `assetProtocol` enabled with scope of exactly that directory — and it still fall back to filename on error, since event predating archive have nothing to load. File deliberately **not** copied: its mention have to name real file in real tree.

  Tray = state, not control: [useAttachments](apps/desktop/src/hooks/useAttachments.ts) = module-level store keyed by session, same shape and reasoning as [useDraft](apps/desktop/src/hooks/useDraft.ts). Have second reason too: `+` button live in `ComposerToolbar`, which reach `ChatInput` as opaque `ReactNode`, so two cannot pass props and share this instead.

  **Drop target = window, affordance = card.** Tauri intercept native drop before webview see it, so no HTML drag events to bind — `onDragDropEvent` only source, and it report paths not `File` handles, what backend wanted anyway. Window-wide because file aimed at composer under full transcript otherwise have to hit 60px strip.

  **Picture a tool hand back.** `Read` of `.png` come back as `image` content block and nothing else — no text — so before this row said "Read /tmp/shot.png" and had nothing to open. Most common way it happen = agent take screenshot itself.

  **Bytes arrive twice on one line, and one copy was already being persisted.** Tool result carry `image` block (`source.data`, `media_type`), *and* line's `tool_use_result` sidecar carry same base64 at `file.base64`. Sidecar go straight onto `ToolResult.structured`, which log — so screenshot session was **12MB of base64 in 14MB log**, read whole on every open, drawing nothing. Mapper now read block (API's own shape) and `strip_image_bytes` drop sidecar's copy, keeping dimensions and original size around it.

  **Archived like composer's own image, same directory and same reason.** Mapper mint `ImageRef` carrying `data:` URL — it hold bytes, and only session layer know which session's directory they go in — then `archive_result_images` in `read_stdout` decode, write to `~/.dray/attachments/<session-id>/`, swap URL for path. Before emit, so live transcript and replayed one load same file. Original no substitute: screenshot live in `/tmp` and gone by next boot. Best-effort per image — one that fail to write keep its `data:` URL through emit, and `read_stdout` strip URL before both retained copies (memory + log): base64 must never reach file read whole on every open.

  **Call carrying picture leave its group.** `groupKey` skip it: "Read 3 files" honest summary of three files and no summary at all of three screenshots. Read off `tool_call_completed` sitting unrendered in same `work` array. Turn collapse still hide it like everything else.

- **Picker = one menu that must not take focus.** Every other composer control = Radix menu focusing itself on open. This one can't: textarea have to stay focused so typing keep filtering, so [PickerMenu](apps/desktop/src/components/composer/PickerMenu.tsx) = plain positioned listbox and every key it answer to handled by `ChatInput`'s own `onKeyDown`. Enter complete highlighted row instead of send, single place composer's Enter-sends rule give way.

  **Both pickers = that one component.** `SlashCommandMenu` and `FileMentionMenu` render rows and nothing else — positioning, frame, hint row, container-local scrolling and phantom-hover guard all `PickerMenu`'s. Those last two expensive parts to get right and neither discoverable from reading markup. Two **mutually exclusive without arbitration**: caret sit in exactly one token, and token opening with `/` at position zero not one opening with `@`, so `ChatInput` read both and never have to rank them.

  **Composer's colouring overlay and transcript share one segmenter** ([highlight.ts](apps/desktop/src/lib/highlight.ts)). Textarea cannot style part of its value, so composer paint mirrored overlay over transparent text — and that overlay and `UserMessage` must agree about _what is marked_, or word coloured while typing go plain once sent. `highlightSegments` concatenate back to input exactly, what keep overlay in register with glyphs underneath; test asserting that round-trip = one guarding against ghosting.

  **They deliberately disagree about how mention drawn, and only there.** Transcript show `@ChatInput.tsx` with directory on tooltip. Composer _cannot_ do that: textarea underneath still lay out full string, so dropping characters from overlay slide caret, selection band, and everything after mention out of register. It dim directory instead. `splitMention` serve both, and property making it safe = `dir + name` is segment back exactly — asserted directly, because that half caret bug come from.

  Open/closed test **caret-based, not "the text has no space yet"** ([slash.ts](apps/desktop/src/lib/slash.ts)): backspacing into `/review the diff` to fix name have to reopen picker. Only _leading_ slash count, or menu fire on every file path someone type. And pick set caret by hand in layout effect, because controlled textarea otherwise drop it at end of value — wrong whenever completed command have arguments after it. Both pickers read **whole token**, not prefix before caret, so backing up to fix typo mid-path filter on corrected path not its first half.

  Four commands withheld from picker in `commands.rs` — `clear`, `fast`, `model`, `rename` — because app already own what they do and none of their effects come back on wire. See _Known issues_ for why hiding them stopgap not fix.

  Recents = **recency, not frequency** ([useRecentCommands](apps/desktop/src/hooks/useRecentCommands.ts)) — tally take days to notice you changed what you work on. Stored globally not per project, safe because project-scoped command only appear where defined. Recorded on _send_, not on pick, and read back out of sent text, so picking command and deleting it don't count and typing one by hand do. Group = **partition**: promoted command leave own group rather than appear twice.

- **Command source inferred, and one half of it read display text.** `commandSource` split harness / plugin / user from only two signals `initialize` payload carry: plugin namespace its name (`railway:deploy`), and user- or project-scoped command have scope appended to its _description_ (`… (user)`). No scope field. So `harness` mean "neither of those", filing CLI's built-ins (`/compact`) together with skills Anthropic ship beside them (`/dataviz`, `/code-review`) — nothing tell those apart, and for reader they same thing: nobody installed them. `system/init` not better source; `slash_commands - skills` mix built-ins with plugin and custom `.md` commands, and arrive too late for picker anyway. Description test fail benignly — reworded suffix file command under wrong heading and change nothing else.

- **Bot and human comment not told apart, only pictured apart.** GraphQL's comment author carry `login` and `avatarUrl`, no `__typename` asked for. Adding `... on Bot` to author selection would settle it for real at no extra call, if a badge ever earn its space.

- **PR panel read and act, never write prose.** No commenting, no replying to review, no requesting review, no closing. Every action there = state change moving work toward landing; anything wanting text box, or ending PR, belong to GitHub for now.

- **Worktree cleanup hang off session lifecycle, not off merge.** `--delete-branch` still deliberately not passed — merge button say nothing about tree. Cleanup live on settle and on delete instead. Merged session whose reader never settle it therefore still leave tree behind; that reader's call, not merge's.

- **Fork copy conversation whole, and record no lineage.** CLI expose no
  fork-at-message, so no picker for where to branch from. `fork_from` cleared
  once CLI carry fork out, so nothing on disk say which session a fork came from
  and sidebar draw no link between the two. Both wanted a field each if it ever
  earn one; neither is missing machinery.

- **Dray never write to issue tracker.** Tag record link on session and nothing else — no status move, no comment, no attachment linking session or PR back to issue. Every one = write, and write want rule for when it fire; reader can ask agent instead, which have tracker's MCP.
- **No issue-side project mapping.** Connection workspace-wide, so picker and page never narrowed by which repo session run in. Filter row cover it by hand. Repo ↔ team mapping = field on `Project` if it earn one.
- - **Handoff row have no Revert, no Amend, no Stash.** Each destroy or rewrite work, and button that send prompt for one = button whose blast radius decided by model. Reader can still type it. **No Push either**, and that one went on width not danger — see _Handing work back_.

- **Repo view read, commit and push — no fetch, no pull, no discard.** Ahead count against *last known* upstream, so branch someone else pushed to read as level until push itself fail. Discard-changes and stage-hunk deliberately absent: both destroy work.

- **No count on Changes view tab.** Working-tree file count would force snapshot on every event even while reader sit on Chat — exactly what `active` gate exist to prevent. Sub-tab carry count, since by then reads already running.

- **Blocked commit name no session either.** Same shape as blocked install: button dim while turn run and say nothing about when it free.

- **Sidebar PR mark say open, draft or merged, and checks say running or failing.** No number, no per-check detail, no merge readiness, and nothing at all for passing — row already carry title, unread rail and timestamp. Number ride `title` attribute alone. Closed-without-merging not asked for at all.

- **Spawned session inherit permission mode, so most block immediately.** Default stance = `auto`, which prompt per action — so session fanned out from ordinary session stop at its first `Write` waiting for card nobody is next to. Notification path do surface it (yellow rail, notice card, dock badge), so it not silent, but "create 3 sessions" currently mean three sessions to go and approve rather than three running. `dray new` take no `--permission-mode`, and adding one raise real question: agent in `plan` session spawning `bypassPermissions` child = escalation past stance user set. Clamping child to be no more autonomous than parent = likely shape of fix. Unresolved on purpose.
- **No reading a transcript back.** Create, list and send exist; reading what another session said don't. Agent wanting summary have to ask that session to `dray send` one. Parent also cannot learn child finished except by polling `dray ls` — nothing push.
- **TS event types generated, not written.** `ts-rs` derive them from Rust model into `src/types/events.ts`, checked in so frontend build need no Rust toolchain. `cargo test` regenerate; never edit output. Two settings live in `src-tauri/.cargo/config.toml`: export path, and `TS_RS_LARGE_INT = "number"` because `u64` otherwise become `bigint`, which `JSON.parse` never produce.

## Known issues

Diagnosed defects, not yet fixed. Unlike _Current state_ above, these broken rather than unbuilt. Delete entry when you fix it.

- **"Check for Updates…" answer into void when sidebar collapsed.** Verdict draw in `UpdateRow`, which live inside `<aside>` and show nothing collapsed — right for scheduled check, wrong for one user just asked for, and menu item give no hint it need sidebar open. Fix = surface not tied to sidebar (toast, or menu item's own state), not special-case in row.
- **Quit from Dock's context menu unguarded.** Bypass menu bar, so custom Quit item never see it and confirmation never appear. Nothing in Tauri API reach it today — `applicationShouldTerminate` = hook and not exposed.
- **Blocked install have no way to say when it unblock.** Wait on any session being mid-turn but name none, so on busy app "waiting for the running task to finish" = whole of what reader get. That sentence sit in button's tooltip not under it — reason belong to button and only wanted on approach. Which why button carry `aria-disabled` and guard own click instead of taking `disabled`: disabled button fire no pointer events to open tooltip and leave tab order. Naming session, or offering to install once it settle, still fix.
- **Changing effort respawn child.** CLI have no `set_effort` control request (`set_model` exist and work), so session killed and resumed by id. Harmless today — respawn happen inside `send_msg`, which only run when user type, so no turn in flight. Revisit when queued/mid-turn messages land.
- **Worktree paths computed, not verified.** `worktree_path()` join convention instead of reading `init`'s `cwd`. Correct as of now; reading it back not worth it — `init` fire repeatedly, so each need re-write plus dedup.
- **Permission request stranded by child dying mid-run unanswerable.** Pending map live in `Session`, so killing child without quitting — effort-change respawn only path today — leave card whose buttons error with "no running session". Restart fine, since request never persisted. Request itself not lost either way: CLI re-ask on resume.
- **`requires_user_interaction` parsed and only half honoured.** Mark call whose own card = answer surface, so Allow/Deny not real reply. `AskUserQuestion` one shape this app draw card for and matched by tool name; anything else carrying flag — elicitation-driven MCP prompts, Cowork role picker — still get Allow/Deny, wrong but at least unblock harness.
- **Worktree session's first baseline = guess, and reflog hold answer.** `base_ref_tree` resolve fork point way CLI resolve it, but CLI fetch `origin/<default>` first — so upstream commit landing between our read and its fetch attributed to that turn. Exact value recoverable: `git worktree add -B` write reflog entry naming commit it actually used, readable lazily at panel-read time even after agent commit. Take newest "Created from"/"reset" entry not oldest, since `-B` on pre-existing branch reset it and older entries can predate session.
- **Sparse-checkout write outside cone invisible to panel.** `git add -A` skip it with boundary warning, so snapshot never see it. Only affect repos using sparse checkout.
- **Split-index repos accumulate `sharedindex.*` files.** Each snapshot write can leave one behind; git expire them on own schedule (`splitIndex.sharedIndexExpire`, two weeks). Clutter in git dir, not corruption.
- **Nothing handle command that restart or replace session.** Picker hide `clear`, `fast`, `model` and `rename` for this reason, but hiding not solving: each still reachable by typing it, and underlying problem = app have no answer for command changing session out from under it. `clear` start fresh conversation index never heard of; `rename` retitle session whose title this app own and write itself; `model` and `fast` move running child off what composer displaying. None come back on wire in form app reconcile, so it carry on describing session no longer matching one running.

  General shape of fix = way to notice session was replaced and re-adopt it — same machinery `/clear` button in UI need, so worth building once not special-casing per command. Revisit before unhiding any of them.

  `commands_changed` = related loose end pointing other way: CLI publish it when available commands change, so "restart to see a newly installed plugin" caveat on per-directory cache fixable whenever this picked up.

- **Background subagent's report-back = second `completed`.** Turn end at own `result`, promptless report-back turn end at its own — so session with background subagent raise two "Task finished" notices, one per thing agent said. Honest, but second one may want folding into first if it read as noise.
