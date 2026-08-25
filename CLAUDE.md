# CLAUDE.md

File give Claude Code (claude.ai/code) guidance for work with code in this repo.

## Working practices

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

- `pnpm dev` — frontend only, port 1420 (`strictPort: true`, so busy port = hard failure). `invoke` do nothing in plain browser, so only useful for pure-CSS/layout work.
- `pnpm build` — `tsc && vite build`. `pnpm tauri build` for bundled app.
- `cd apps/desktop/src-tauri && cargo test` — Rust tests (253: parser + mapper + event-model compatibility, plus git and file index). Single test: `cargo test parses_complex_fixture`.
- `cd apps/desktop/src-tauri && cargo check` — fast type check, no linking whole app.
- `pnpm test` — frontend tests (vitest, 149, node environment, no DOM). Scoped to pure logic where being wrong invisible on screen: [streaming.ts](apps/desktop/src/lib/streaming.ts), which read same committed fixtures Rust tests do rather than keep own captures; and composer's caret arithmetic ([slash.ts](apps/desktop/src/lib/slash.ts), [mention.ts](apps/desktop/src/lib/mention.ts), [highlight.ts](apps/desktop/src/lib/highlight.ts)), where same string open picker or not depending only on cursor position. Components not tested — no DOM here.

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

**Permission request never written to log.** Join deltas and usage updates in emitted-but-not-persisted set, and its `PermissionDecided` emitted straight from `Session::respond_permission` with no write. Reason not volume: request can only be answered by child that asked, and no child survive restart — so persisted request come back as card whose buttons cannot work. Nothing lost, because tool call it belong to _is_ persisted and show outcome either way. `QuestionsAsked` dropped on same reasoning, harder — `AskUserQuestion` result CLI write carry both questions and answers.

**Tool call with no result only _pending_ while something could still produce one.** `buildTranscript` take `live` (session's `busy`) and file `ABANDONED` stand-in into `resultByCallId` for every call log leave open — which why one line fix every surface at once, since collapsed row, group header, and shimmer all read pending-ness from that map. Without it call caught mid-flight by quit shimmer forever, most visibly `AskUserQuestion`: it block harness until app answer, so it call most likely open when app go away, and its request not persisted so no card come back to answer it.

Liveness alone not enough — it property of _now_, and next send flip those rows back to shimmering. So `user_message` also abandon everything open before it: new prompt = proof previous turn will not finish what it started. Marks applied after walk and only where no real result exist, because background subagent can report back after turn that spawned it.

Work only because frontend keep loaded session in memory: `handleSelectSessionIndexItem` return early when session already in `sessions`, so re-selecting session with request in flight reuse live state instead of re-reading file. Change that to always refetch and open card disappear mid-flight, agent still blocked behind it.

**`AskUserQuestion` ride this same channel, and is not permission.** Arrive as ordinary `can_use_tool` with `requires_user_interaction: true`, and answer travel back inside _allow_: `updatedInput` = tool's own input with `answers` map added, keyed by each question's verbatim text. So call never in question — always may run — and allowing it with nothing filled in exactly what produce CLI's "The user did not answer the questions." That make Allow/Deny wrong two buttons, which why mapper branch on tool name into `QuestionsAsked` and `PendingRequest::for_questions` carry no options at all.

Other route dead end, worth knowing why: `request_user_dialog` exist as control-request subtype, but CLI only send one for kind host declared in `supportedDialogKinds` during `initialize` handshake, fail closed otherwise, and only kind CLI's own bridge declare = `refusal_fallback_prompt`.

Three answer shapes, all verified live against v2.1.226: option's **label** = answer (no option ids), multi-select answer = one **comma-separated string** not list, free text = any string at all. Question absent from map skipped, partial map honoured, which make Skip real answer not refusal. `answers` also why whole input echoed back untouched: CLI rebuild tool result from same object.

**Two denials, and they mean different things.** `PermissionRequested` → `PermissionDecided` = question user answered; `PermissionDenied` = `system`/`permission_denied`, call refused with no question possible. Durable cause of second = working-directory sandbox, which no answer channel can fix. `PermissionDecided` minted by app when it reply, since CLI's ack carry nothing. **Render as nothing at all** — exist to retire card. Settled request draw no row either way: approval visible in tool simply running, refusal in tool's own error. Event still persisted, because "was this answered" have to survive reload and log only place it live.

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

**Working indicator driven by `model_request_started`, not by "this turn has drawn nothing yet".** That old rule could only ever describe turn's _first_ wait: after one row existed it false forever, and agentic turn mostly later gaps. `system/status` with `status: "requesting"` land within 30ms of every tool result and again at top of each turn, so it mark start of every blank stretch (~1s to first text block, 3s median for thinking one). `Working` in [useSessions.ts](apps/desktop/src/hooks/useSessions.ts) carry one thing, live token count off `usage_update.reasoningTokens` — only number thinking block emit. Two kinds of wait deliberately _not_ told apart: indicator's word picked at random and "Thinking" one of options, so naming wait change nothing on screen. State per-session and live nowhere else: both events driving it unpersisted, so cannot be rebuilt from log.

Three exits clear it, all needed: `block_start` that not thinking (text or tool call draw immediately), `turn_completed`, and any `session_status` off `in_progress` — last cover interrupt or dead child, which other two never see.

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

**Running take timestamp's slot; failing recolour PR glyph instead.** Two different questions, so two different marks. Running = dashed spinner in right slot, behind orb — order load-bearing: agent working = this app's own session doing something *now*, CI = machine elsewhere, timestamp = least useful thing to say about row with anything in flight. Failing = existing glyph go red, because broken build = fact *about* that PR not another thing on row, and row have one slot for what state work in. Passing draw **nothing at all** — marking every green branch green second time make mark that *does* need reading harder to find, so `SUCCESS` and no-CI-at-all both reach reader as `Clear`.

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

## Handing work back

**Composer hide row of end-of-turn action behind itself.** [HandoffRow](apps/desktop/src/components/composer/HandoffRow.tsx) sit above composer card, clipped to sliver, open on hover. Buttons = Commit, Commit & push, Push/Publish branch, Create PR, Draft PR.

**Almost every button send prompt.** Click = reader typing "commit" without typing it, straight through `handleSendMsg`. So no confirm dialog and no error surface — agent write message with context it already have, and whatever go wrong report in transcript like any other tool failure. This a shortcut *into* conversation, not around it.

**Prompt = one to three word**, literally `"commit"`, `"commit and push"`, `"create a PR"`, `"create a draft PR"`. Model know how to commit and whether branch have upstream better than sentence written here do — and longer prompt = spec competing with repo's own instruction, which firm about commit message. Pinned by test (≤4 words).

**Push the exception, and run git direct.** Line = whether there a judgement to make. Push have exactly one correct implementation and nothing to decide, so it call `push_branch` — which already both case, `git push` with upstream and `git push -u origin <branch>` without. Hence no separate **Publish branch** action: one button, count dropped from label when no upstream since "Push 0" answer question nobody asked.

Push own both end of its own feedback, since it report into no transcript: spinner on button while in flight, and error banner above composer. It refresh `work_status` on success rather than wait for next turn's edge, because count on button now wrong.

Cost of that trade worth naming: agent not deterministic. Commit might come back with different message style, or agent might run tests first. Prompt one = **suggestion, not command**. Push is a command.

**Hidden, not contextual-visible, and that the whole shape.** Turn touching file = most turns, so row drawn on "there are changes" = row drawn always — exactly what make every other tool's commit button noise. Reverse hold too: finishing turn ≠ wanting to commit. Peek cost discoverability once and buy quiet every turn after.

**Which button exist = [handoff.ts](apps/desktop/src/lib/handoff.ts), pure and tested.** Dirty tree → Commit + Commit & push. Clean tree with commits ahead → Push (count in label); no upstream at all → Push without count, offered even at zero ahead since branch nobody pushed = one nobody else can see. Push **never** beside Commit: with dirty tree reader want commit first and Commit & push already carry it. Create PR + Draft PR both spelled out, not one behind other's menu — draft = different decision, not variant. Both hidden on default branch (PR against itself), where no remote resolve default branch, where branch **already have PR**, and where branch hold **nothing new**: level with base and clean tree = PR with no diff in it.

That last check read `ahead_of_base`, **not** `ahead`. Second one count against *upstream*, so branch pushed in full read zero — exact state branch in when its PR get opened. `ahead_of_base` count against remote-tracking base ref (`origin/<default>..HEAD`), since local `main` can be stale or absent in worktree. `None` = "couldn't tell" and count as something: `origin/HEAD` can be symref onto ref never fetched and `symbolic-ref` resolve it without checking, so over-offer (one wasted click) beat under-offer (action gone). Empty = resting state, and row hide entirely on it.

**`hasPr` come from sidebar's own per-repo read, not fourth git call.** `usePrMarks.prFor` already answer it for every visible row.

**One backend command, not three stitched.** `work_status` = `dirty` count, `branch`, `upstream`, `ahead`, `default_branch`, `ahead_of_base`. Superset of `sync_status` because every field answer same question — "what left to do with this work" — and reading them separately let row draw Commit from one snapshot beside Push count from another. `default_branch` arrive **stripped of remote** (`main`, not `origin/main`), so "am I on default branch" = one comparison and not parsing rule free to drift. Infallible like `sync_status`: non-repo answer default, row read that as nothing to offer.

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

**One agent can fan work out into several sessions.** "Work through these 3 Linear issues" become three Dray sessions, each own worktree, each row in sidebar user can open, interrupt, delete like any other. v1 = create and list. No sending into existing session, no child reporting back to parent.

**First inbound channel into app.** Every other command travel frontend → Rust; this one travel agent → Rust → frontend, so frontend learn about session from *event* rather than from return value of thing it called. That inversion = whole of what [orchestration.rs](apps/desktop/src-tauri/src/orchestration.rs) add. Work itself go through `SessionManager::send_msg` — same function composer reach, not parallel path — so session created this way not second kind of session.

**Three shipped pieces, one line of glue.** App serve unix socket; `dray` = standalone CLI in own crate; skill document it; and one line in [system_prompt.md](apps/desktop/src-tauri/src/harness/claude_code/system_prompt.md) name capability plus install command. Agent check for `dray`, install if missing, read skill, get on with it. **App install nothing** — it inform, agent do.

**CLI deliberately not part of app.** It have to run on linux later, where no Dray app exist at all. So `apps/cli` = own crate (package `dray`, reserved name), own `cli-v*` release tag, `curl -fsSL https://drayhq.com/install.sh | sh`. Links neither app nor tokio: one connect, one write, one read, exit — startup instant, which matter when caller = agent shelling out.

**Wire types live in third crate, and that the point of split.** `crates/dray-proto` compiled into both side, so request shape cannot drift. Drifted shape here fail way [control.rs](apps/desktop/src-tauri/src/harness/claude_code/control.rs) warn about — no error, command simply stop working. No root Cargo workspace and this add none: `src-tauri` have own `.cargo/config.toml` carrying ts-rs export path, and workspace move target dir out from under it. Path dep work fine between separate cargo project.

**Unix socket, not HTTP port.** `~/.dray/dray.sock` at `0600` — access control = filesystem permission, so nothing outside user's own account connect and nothing on network reach it at all. No port to pick, collide on, or accidentally expose. Stale socket unlinked at bind: socket file outlive process that made it, so crash leave one behind and bind fail "address in use".

**Address = one value, and that what let app move to server.** `DRAY_ENDPOINT` read from env child already get injected: `.sock` path today, HTTPS URL and token in cloud build. Types, subcommands and skill all unchanged by that swap — only ~30 lines that open connection. Socket = same-machine only, which hold if manager and its agent children move to server *together* and break if agent ever run where manager isn't.

**Protocol version checked before request even looked at.** Two release pipeline mean old CLI can meet new app; `v` field refuse mismatch with readable line rather than guess what it meant.

**`session_created` carry index item, never `SessionSnapshot`.** Frontend's `agent_event` listener write into sessions it already hold and *drop* events for id it don't — so snapshot would start transcript in memory that later event could miss. Index item leave transcript unread until row clicked, and `handleSelectSessionIndexItem` already load it whole from disk at that point. That close window rather than live with it. `session_status` and `session_title` still land: both write by id into maps sidebar read, not into `sessions`.

**Row appear, and deliberately not selected.** User mid-conversation in session that spawned this one; yanking them out = opposite of what fanning out for. Listener sit in `[]` effect so it need `showArchivedRef`, same reason `selectedSessionIdRef` next to it exist.

**Spawned session take worktree by default.** Three issue in one checkout overwrite each other, and changes panel already cannot tell two writer apart. `--no-worktree` opt out. Cost already documented above: `-w` fork from `origin/<default>`, not from branch parent sit on, so fanning out from unpushed feature branch give children without parent's work.

**Depth cap = 2, walked not stored.** Spawned session may spawn; its children may not. Walk `parent_session_id` up index at create time with cycle guard, rather than storing `depth` number free to disagree with chain it describe. Chains three long, so walk cost nothing. Refusal = readable sentence, since agent read it as tool output.

**Model, effort and permission mode inherit from parent.** So fanned-out session run way one that spawned it do. No parent (call from user's own terminal) = Rust's own default, because composer's remembered pick live in frontend localStorage where Rust cannot read it. `ModelId::default()` cannot serve — it `Unknown`, which exist so old index entry still deserialize and which have no CLI alias — hence `default_model()`, mirroring `useComposerPrefs`' seed. Two separate constant; move one, move both.

**Project deliberately not attached.** Sidebar's `projectFilter` default null and list every session whatever its project, so session under unattached repo already reachable — while `add_project` bump `last_selected` and resort list, which would let agent's call quietly reorder user's project picker.

**`dray` raise no consent card, and that one flag.** `--allowedTools "Bash(dray:*)"` on spawn — additive allow rule, everything else still route through `can_use_tool` exactly as before. Verified against v2.1.241, not assumed: pattern that fail to match fail *silently*, as unexpected card rather than error. Measured with `mkdir` under `manual` — `Bash(mkdir:*)` and `Bash(mkdir *)` both ran, `Bash(git *)` reported `permission_denied`. **Test with command that mutate**: read-only one like `echo` auto-allowed whatever rule say, so it report success for pattern matching nothing.

**Child get `PATH` put back, and that load-bearing.** Bundled `.app` launched from Finder inherit launchd's `PATH` (`/usr/bin:/bin:/usr/sbin:/sbin`), so `dray` installed to `~/.local/bin` simply not there for agent — same trap [binpath.rs](apps/desktop/src-tauri/src/binpath.rs) exist to solve for `claude`, one layer out. `known_dirs()` now `pub` for this. Appended not prepended: user's own `PATH` should still win where two name same binary.

**Skill embedded in binary, written by `dray skill install`.** Downloaded separately = exactly how skill end up describing different version of CLI than one installed. Global at `~/.claude/skills/dray/`, not scoped with `--plugin-dir`, because CLI meant to work from any Claude session, terminal one included.

**Socket failure cost feature, never app.** `serve` error logged and dropped in `setup()` — app refusing to start because socket in use would trade whole product for side channel, and reader could act on it either way.

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

**Manifests live on `updates` branch served by GitHub Pages, not in release.** `/releases/latest/download/` obvious host and cannot work here: it skip prereleases, so beta have no fixed URL. Artifacts still live on release — manifest only point at them.

**Channel chosen per check, in Rust, not in `tauri.conf.json`.** [updater.rs](apps/desktop/src-tauri/src/updater.rs) build updater with channel's endpoint each time, so switching channels need no rebuild; config endpoint only what caller naming no channel get. No channel picker yet — [useUpdater](apps/desktop/src/hooks/useUpdater.ts) read `ade.updateChannel` from storage and default to stable.

**Nothing emitted until there is update**, so `null` = frontend's resting state and cover every failure. Check that can't reach manifest = common case, not error worth row. Bundle download as soon as found and held in memory until user press install; progress emitted only on change of whole percent, since chunks land every few KB and per-chunk event = thousands of renders per bundle.

**Install blocked while any session mid-turn, and button wait rather than warn.** Swapping bundle relaunch app, killing every child mid-turn. Check = `statusBySession` in [App.tsx](apps/desktop/src/App.tsx) and complete on own: no child survive restart, so session from earlier run cannot still be running. Check live at button not in `install_update` because that command = point of no return — never return on success, since `restart` diverge, and `invoke` resolving at all mean install failed.

**Except when user ask.** App menu's "Check for Updates…" = question, so it answered either way — "Up to date" and "Couldn't check" both drawn, both retire themselves after 4s. Difference = who asked: scheduled check say nothing because nobody asked it, hand-triggered one leave menu item looking broken if it do same. Menu item **emit to frontend** rather than check in Rust, because channel live in frontend's local storage — emitting also mean manual check reuse scheduled path, in-flight guard included. Verdict read off `check_update` resolving with no `update_status` having arrived: command emit nothing when nothing newer, so absence = whole of signal. Still nothing while sidebar collapsed, so manual check there answer into void — real gap, see _Known issues_.

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

**One ordered rule, two presentations.** `mergeVerdict` = order (closed PR's merge state stale, conflict outrank failing check, `UNKNOWN` mean not-worked-out); `mergeReadiness` turn verdict into panel's sentence, `isReadyToMerge` ask one question notice turn on. Predicate written *beside* that order rather than out of it = second copy of thing that took while to get right.

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
- `McpServer` and `ApprovalPolicy`/`PermissionMode` defined once in `events` and re-exported by parser. Don't reintroduce per-harness copies.

**Outbound lines typed too, in [control.rs](apps/desktop/src-tauri/src/harness/claude_code/control.rs).** `ControlRequest` = enum tagged on `subtype`, `ControlLine` = envelope minting `request_id`; adding control = adding variant, same as inbound. Typed despite nothing here being able to fail at runtime, because wrongly shaped request not reported — CLI answer what it recognize and stay quiet otherwise, so drifted envelope present as control that silently stopped working. Same failure mode malformed `control_response` have going other way. `write_line` take `impl Serialize`, so `json!` still fine for one-off shape and struct earn its keep where envelope repeat.

## Test fixtures

Tests use `include_str!` against real captured CLI output under `harness/<name>/fixtures/`:

- `claude_code/fixtures/printed.jsonl` — small smoke fixture.
- `claude_code/fixtures/complex.jsonl` — 176 lines with subagent/task traffic. Assertions hard-code exact counts, so editing this file break tests by design.
- `claude_code/fixtures/multi_turn.jsonl`, `interrupted.jsonl` — turn boundaries and mid-turn interrupt.
- `claude_code/fixtures/interrupted_tools.jsonl` — `interrupt` control request landing mid-tool-call: `control_response` ack, `terminal_reason: "aborted_tools"`, `local_bash` background task (no `subagent_type`, no `usage`), and only capture with `thinking_tokens`.
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

`File` number file from 1 and expose no starting-line option, so `CodeView` rewrite gutter in `onPostRender` — which hand back _host_ element, whose rows live in its shadow root. Padding content with blank lines also work and then collapse: `offset` of 420 render 419 empty rows.

**Every diff side carry content-derived `cacheKey`** (`diffSide` in [diff.ts](apps/desktop/src/lib/diff.ts)). Library fall back to file *name* as key and worker pool cache highlighted lines on key alone — so second `Edit` to same file, or `index.ts` from another dir, reuse first one's tokenized result and longer diff walk off its end: "deletionLine and additionLine are null", thrown mid-render. Key = full path + length + FNV-1a of text, so new content can only miss cache. Never hand `parseDiffFromFile` bare `{name, contents}`.

**`+N -M` come from library's hunks, not hand-rolled scan.** `countChanges` parse diff and sum `hunk.additionLines`/`deletionLines` so collapsed row can never disagree with diff it open. Prefix/suffix scan look equivalent and isn't: `Edit` fragments usually arrive without trailing newline, so diff algorithm treat boundary line as changed on both sides — appending two lines to `"a\nb"` render as `+3/-1`, not `+2/-0` scan report.

**Group header carry same figure, summed over its calls** ([ToolGroupRow](apps/desktop/src/components/chat/ToolGroupRow.tsx)), from those same per-call counts. Without it run collapsed to "Edited 1 file · 4 calls", which say nothing about how much changed. These _region_ counts, not file counts: `Edit` diff its replaced fragment not file, so sum = run's total churn and not what `git --stat` report. Memoized on call count not on `calls`, since committed call's input immutable and run only grow; keying on array re-parse every diff in group on each render of streaming turn.

**Where time go — two costs, scaling with different things.** Grammar _attach_ per language and one-off: entire `COMMON_LANGS` set attach in **~54ms** batched, while **Ruby alone ~390ms**, since it drag in HTML, CSS, JS and SQL for embedded syntaxes. _Tokenizing_ per file and scale with whole file, not change — `renderDiffWithHighlighter` force `startingLine 0 / totalLines ∞` and tokenize both full sides. With grammars attached: 300-line TSX ~110–180ms per side, 850-line TS ~750ms, 1300 lines of Rust ~160ms — TS/TSX = expensive grammars by nearly order of magnitude. Transcript `Edit` diff only carry its fragment, so tokenize cost round to zero there; changes panel diff whole files, where this bite.

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

- **Session status = state machine in `session.rs`.** `StatusTracker`: send or `init` → `in_progress`; `result` _with no background tasks outstanding_ → `completed`; empty `background_tasks_changed` with no open call → `completed`. `result` alone not end of work — background subagent run past it, and CLI open promptless `init` later to report findings. `completed` mean finished _and unread_: frontend clear it to `idle` when user view session (`mark_session_idle`), and persisted `in_progress` reset to `idle` at startup since no child survive restart. Status changes reach frontend as `session_status` events — derived state, never written to `.jsonl` log.
- **Codex = stub.** `Harness::Codex` parse from frontend, but `Session::init` bail on it.
- **Composer toolbar = session's control surface.** [composer/](apps/desktop/src/components/composer) hold one component per control; `ComposerToolbar` hide project, branch, worktree toggle once session exist. `ChatInput` take row as `ReactNode` so it keep owning layout and measurement and nothing else.
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

- **Handoff row have no Revert, no Amend, no Stash.** Each destroy or rewrite work, and button that send prompt for one = button whose blast radius decided by model. Reader can still type it.

- **Repo view read, commit and push — no fetch, no pull, no discard.** Ahead count against *last known* upstream, so branch someone else pushed to read as level until push itself fail. Discard-changes and stage-hunk deliberately absent: both destroy work.

- **No count on Changes view tab.** Working-tree file count would force snapshot on every event even while reader sit on Chat — exactly what `active` gate exist to prevent. Sub-tab carry count, since by then reads already running.

- **Blocked commit name no session either.** Same shape as blocked install: button dim while turn run and say nothing about when it free.

- **Sidebar PR mark say open, draft or merged, and checks say running or failing.** No number, no per-check detail, no merge readiness, and nothing at all for passing — row already carry title, unread rail and timestamp. Number ride `title` attribute alone. Closed-without-merging not asked for at all.

- **Spawned session inherit permission mode, so most block immediately.** Default stance = `auto`, which prompt per action — so session fanned out from ordinary session stop at its first `Write` waiting for card nobody is next to. Notification path do surface it (yellow rail, notice card, dock badge), so it not silent, but "create 3 sessions" currently mean three sessions to go and approve rather than three running. `dray new` take no `--permission-mode`, and adding one raise real question: agent in `plan` session spawning `bypassPermissions` child = escalation past stance user set. Clamping child to be no more autonomous than parent = likely shape of fix. Unresolved on purpose.
- **Orchestration read and create, never drive.** No sending into existing session, no reading transcript back, no stopping one. Parent cannot learn child finished — `dray ls` report status so agent can poll, but nothing push.
- **Beta channel have no picker.** `ade.updateChannel` in local storage = whole switch, and nothing write it. Backend take channel per check, so picker = control and `setChannel`, not protocol change.

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

- **Status flash `completed` between task drain and its report-back turn.** When background subagent finish, `background_tasks_changed []` mark session completed, and promptless `init` CLI open few lines later to narrate findings flip it back to `in_progress`. Milliseconds today; debounce edge before notifications hang off it.
