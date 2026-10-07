# Changelog

What each release changed, newest first, in terms of what you'd notice using it.
The release job reads the matching section into the GitHub release notes, and
drayhq.com/changelog and the app's Settings → Changelog are built from this
file, so it is what a release says about itself — not a second description of
it. GitHub's generated commit list is appended below it.

Format, which the site's parser ([changelog.ts](../web/src/lib/changelog.ts))
reads:

- `## <version> · <date> · notify` — date is `YYYY-MM-DD`. `notify` raises a
  card in the app for people who update to it; leave it off and the release is
  listed quietly.
- `### New`, `### Improved`, `### Fixed`. Any other heading reaches GitHub
  only.
- `- **Title.** Description.` or a plain one-liner.
- An image or video goes on its own line, indented under its item:
  `![](changelog/servers.mp4)`. The file lives in `apps/web/public/changelog/`
  and is served by drayhq.com.

## 0.27.0-beta.1 · 2026-10-06

### New

- **Connect to your own Dray servers.** Settings → Servers adds one by
  address and token. Its projects join the sidebar and the project
  picker, marked with the server's name, and its sessions run there.
  Pairs with `dray` 0.9.0, which installs a server on Linux in one line.
- **The header names the server** a remote session runs on:
  `server / project / title`.
- **A server that drops shows dimmed** in the sidebar, and picks up
  where it left off when it reconnects.
- **Save a task without starting it.** ⌘S on a new task saves it as a
  draft under its project in the sidebar. Open it to keep editing, or
  send it to start the session. Agents can make them too with
  `dray draft`.

## 0.26.0 · 2026-10-01

### New

- **Rename a session from its header.** Double-click the title. A
  name you give it is kept, and no generated title replaces it.
- **Type or paste from anywhere.** A key or ⌘V pressed while focus
  is on the transcript, the sidebar or a panel lands in the composer.
- **Pick several issues from the `#` list.** ⌘-click or ⌘⏎ adds one
  and keeps the list open. Tagged issues show a check.
- **Rearrange the split view by dragging a pane's header.** Drop it on
  a pane to swap the two, or on an edge to move it.
- **Screenshots and recordings show on a finished turn** without
  opening its tool calls. Several draw as tiles that open the
  lightbox, which now plays video.
- **Filter GitHub issues by type** on the Issues page.
- **⌘⌥E moves the side panel** between left and right.
- **⌘⇧←/→ steps browser tabs.** ⌘⇧[ ] does too in the Browser view
  while the side panel is shut.
- **Agents can zoom the browser** with `dray browser zoom`. Needs
  `dray` 0.8.0, which updates itself.

### Improved

- **The side panel hides in Diff and Files** as it does in Browser.
  ⌘E brings it back, and Chat restores it.
- **Stepping sessions with ⌘⇧↑/↓ is quicker.** The rows either side
  load ahead, and a held chord opens only the row it stops on.
- **Running subagents draw their own orb.**
- **The browser runs Chromium 154.** It downloads once on first launch.
- **Agents hide review sessions by default.**

### Fixed

- **A question card keeps its answers** when you switch session and
  come back.
- **The composer keeps focus while an agent drives the browser.**
- **⇧⏎ in a long draft scrolls the new line into view.**
- **Command colour goes once the command is deleted.**
- **Long sessions no longer wobble** while older turns load.
- **Paired keys in shortcut hints**, like `[ ]`, no longer touch.

## 0.25.2 · 2026-09-30

### Improved

- **New thinking orbs.** The working indicators are redrawn in the
  text colour, so they read the same on every theme and in both
  modes. Background tasks get their own spiral.

## 0.25.1 · 2026-09-26

### Fixed

- **The browser follows its pane when the side panel is on the left.**
  Collapsing or resizing the sidebar left the page drawn where the
  pane used to be.

## 0.25.0 · 2026-09-26

### New

- **Hidden sessions for reviews.** A session started with `dray new
  --hidden` stays out of the sidebar and shows only in the crew beside
  the session that started it. Right-click it there to show it in the
  sidebar. Agents hide review sessions by default. Needs `dray` 0.7.0,
  which updates itself.
- **The side panel can sit on the left.** Settings › Appearance ›
  Panel side.
- **The side panel remembers its width per session.**
- **Drag to reorder tabs** in the Browser and Files views.
- **Grok Build takes a message mid-turn** into the turn it is running,
  instead of holding it until the turn ends.

### Improved

- **On a 14" screen with the side panel open, the crew sits under the
  chat** instead of squeezing in beside it.

### Fixed

- **Leaving the Browser view gives the side panel back** if arriving
  there closed it.
- **A session opened from a notice moves the sidebar's project filter**
  so its row is visible.
- **Merging a PR keeps the panel on the PR tab.**
- **Tooltips no longer stick** after closing the project or permission
  menu.

## 0.24.0 · 2026-09-25

### New

- **Agents can record the browser.** `dray browser record start` and
  `record stop` save an MP4 that plays inline in chat, so checking a
  feature is watching a video. Typing, hover and animation are captured.
  Needs `dray` 0.6.0, which updates itself.
- **Device sizes in the browser.** Pick a device from the icon's menu,
  set a responsive size and save it, rotate any device. MacBook Pro 14
  and 16, 1080p and 4K are new presets.
- **⌘R reloads the browser page and ⌘T opens a new tab.**
- **The Files view plays videos** (mp4, m4v, mov, webm).
- **Drag to reorder projects and spaces** in Settings → Spaces. The
  sidebar and the composer's project picker now keep that order.

### Fixed

- **fx lists the newest Codex and grok models**, read from fx itself.
- **Browser tabs show their favicons** again.
- **`/compact` on a resumed Claude Code session stays busy** until it
  actually finishes.
- **A file the Files view can't show says why**, instead of "Not text".
- **Answering a card in the crew column keeps you on the parent session.**

## 0.23.7 · 2026-09-24

### Improved

- **Faster everywhere.** Streaming a reply no longer redraws the whole
  app per token, long sessions open on their newest turns and load the
  rest as you scroll, and the app starts sooner.
- **Quieter in the background.** An idle Dray barely touches the CPU:
  PR checks pause while the window is hidden, the browser stops ticking
  when no tab is open, and git is no longer run on every agent event.
- **One busy session no longer stalls the others.** Restarting an agent
  in one session used to hold up Stop and sends everywhere else.

### Fixed

- **The window opens at the size and place you left it.**
- **The crew column fits a narrow window.** When there is no room beside
  the chat it starts hidden, and ⌘⇧C draws it under the transcript.
- **Background task rows no longer scroll under the Stop all bar.**

## 0.23.6 · 2026-09-23

### Fixed

- **Codex, fx and grok no longer hang on a permission question after a
  restart of the agent.** The sidebar turned yellow and the sound
  played, but no card appeared to answer.
- **Model, effort and mode picks stick to their session.** Leaving a
  session keeps unsent picks, and picks inside one no longer change the
  new-task defaults.
- **A pick made mid-turn applies to the prompt you queue behind it.**
  Codex locks these controls mid-turn instead, since it can't honour them.
- **pi switches model and effort without restarting the agent.**

## 0.23.5 · 2026-09-23

### New

- **Paste images and files into the composer.** A copied file arrives as
  an attachment, the same as dropping it in.
- **Zoom the whole app with ⌘= / ⌘- / ⌘0.** This replaces the per-area
  font sizes in Settings, which reset on this update.
- **Every harness uses your own model shortlist.** Star the models you
  want at the top of the picker; Shift+Tab cycles them.
- **Switch a harness off** in Settings → Accounts to hide it from the
  picker. Sessions already on it keep working.

### Fixed

- **Links in chat are underlined again**, and bare domains like
  `drayhq.com/docs` or `localhost:3000` are links now, in your messages
  and the agent's.
- **An expanded shell row shows the whole command**, not just the
  one-line summary.
- **The browser pane stays put when the app is zoomed.**

## 0.23.4 · 2026-09-23

### Improved

- **Settings is a full-window page** instead of a dialog. Open
  transcripts stay as they were underneath.
- **Backspace unbinds a shortcut** while recording one in Settings →
  Shortcuts.
- **⌘⌥T cycles themes.**
- **Downloads and updates come from a faster mirror.** GitHub's release
  CDN was taking minutes for some people.

### Fixed

- **Picking a dark-only theme no longer forgets your light-mode choice.**
- **The Accounts tab shows the last reading while it re-reads**, rather
  than a spinner every visit.

## 0.23.3 · 2026-09-23

### New

- **The new-task page says when your agent's CLI has an update**, with
  an Update button that runs the CLI's own updater in place. pi and fx
  wait for their running sessions to finish first.
- **The `dray` CLI updates itself alongside the app**, on the first
  launch of each new version, so agents stop hitting "run `dray
  update`". A machine without `dray` gets nothing installed.
- **Shortcuts can be unbound** from Settings → Shortcuts.
- **GPT-6 Sol and Luna are in the Codex picker**, with 6 Astra, 6 Sol
  and 5.6 Sol at the top.

### Improved

- **Views moved to ⌘1–⌘4 and split-view panes to ⌘⌥1–⌘⌥9.** Custom
  bindings are kept.

### Fixed

- **A CLI installed globally with pnpm 11 is found.**
- **The composer no longer draws a horizontal scrollbar** on a line
  that fills its width.
- **The Grok account row drops the raw team id.**

## 0.23.2 · 2026-09-23

### New

- **Opus 5.5 is in the model picker**, as Claude Code's Opus. Opus 5
  stays reachable under More models, fast mode included, for anyone
  who wants to stay on it.

## 0.23.1 · 2026-09-22

### New

- **A Grok Build session forks**, in a new worktree or in place, like
  every other harness. A session whose worktree has been removed is
  refused at the press rather than failing on its first send.

### Fixed

- **Settling or deleting a Grok session is instant.** It spent about
  four seconds waiting for a goodbye the agent never answers. Nothing
  is lost — its history is written as the turn goes, not on exit.
- **An issue linked by an agent shows up straight away.** The Issue tab
  waited for the next message, a reselect or a restart.
- **A session whose very first message fails no longer leaves processes
  behind**, the agent's own children included.

## 0.23.0 · 2026-09-22

### New

- **Grok Build is Dray's fifth agent harness.** Spawn, stream, resume
  and stop, with permission cards, questions, subagents and the
  context ring. Model and effort move on a running session; a stance
  change respawns it. Fast mode is a switch rather than a second row
  in the picker, since grok ships its fast tier as its own model.
- **GitHub issues read beside Linear.** A second tracker on the same
  surfaces: the issues page, the session's Issue tab and the
  composer's `#` menu. Auth is `gh`, so there is no key to paste and
  nothing stored. An issue is named `owner/repo#12`; a bare `#12` is
  refused, a number alone meaning nothing without a repository.
  Writes are status alone — GitHub has no priority field.
- **The agent's task list is drawn in the right panel.** It used to
  vanish the moment a turn collapsed. The pane opens itself on a list
  you have not been shown and stays quiet otherwise.
- **Subagents is now More**, a catch-all tab holding the task list
  beside the runs. A section with no rows draws nothing.
- **The Browser view takes the full width**, hiding the sidebar while
  you are on it and restoring it when you leave. On by default, with
  a switch in Appearance.
- **A grok plan gets a Plan tab**, since the approval card is the only
  copy of it.

### Improved

- **The landing page is the app itself**, drawn from its own component
  classes and animated in CSS rather than captured as video.
- **Light mode's add accent is a deeper green** — it was clipped to
  the sRGB ceiling on displays that can show more.

## 0.22.4 · 2026-09-21

### Fixed

- **A long permission option no longer runs off the card.** A rule
  carrying its own subject — "Always allow mkdir -p /tmp/thing" — wraps
  instead of overflowing the crew column's right edge.

## 0.22.3 · 2026-09-21

### New

- **Chat input is a font size you can set**, in Appearance beside the
  other three. It had been stuck at the browser default; it now matches
  the transcript it feeds.

### Fixed

- **A crew child asking permission draws its card in the column**
  rather than raising a notice over a session already on screen.
- **A request arriving as a session loads is no longer lost.** It could
  leave the row lit yellow over an empty transcript, with nothing to
  answer — a permission request is never written to the log, so that
  was the only copy.

## 0.22.2 · 2026-09-20

### Fixed

- **A sidebar click on a crew row you are reading now opens it in full.**
  It changed nothing before, so it read as broken.
- **Opening a session no longer flashes.** The layout followed a read
  that had not landed yet, so the main column, crew and right pane were
  torn down and rebuilt on every cold open.
- **The follow pin survives that open too**, so a long transcript lands
  at the bottom rather than a little above it.

### Improved

- **The crew column has a left edge**, a ramp at full strength beside the
  composer and gone by the top.

## 0.22.1 · 2026-09-20

### Fixed

- **The right pane follows the crew, not each row's own memory.** It
  opened and shut row by row through a fan-out; it is one arrangement, so
  it answers under the anchor. From the sidebar or a chord the session
  answers for itself again.
- **Arriving at a long transcript lands at the bottom.** Backfill could
  drop the follow pin mid-way. A drag or a wheel up still wins at once.
- **Show more is readable on a filled bubble in light mode.**

## 0.22.0 · 2026-09-20

### New

- **The crew: a conversation's spawned sessions beside it.** A column of
  the sessions the selected one started, a strip each, so a fan-out is
  read and answered without leaving the conversation that made it.
  Clicking a strip focuses it and the one composer follows. ⌘⇧C toggles
  it; ⌘-click a row to anchor a crew of its own.
- **Accounts, in settings.** Which account each agent runs as — Claude
  Code, Codex, pi and fx — asked of the CLIs themselves, with the
  identity, the auth method and whether the login still works. Signing
  in opens a terminal and runs the command for you; Codex and pi also
  take a key straight from the form. Dray stores no agent credential.
- **Settings groups moved to a rail.** Seven tabs across the top wrapped
  onto a second line; down the side they are one list.

### Improved

- **Placed tags are chips in the composer.** A session tag no longer puts
  36 characters of uuid in your sentence, a file mention shows its name
  and a glyph, and an issue tag shows the title rather than the
  identifier. What gets sent is unchanged.
- **Browser sits before Diff in the view tabs**, so it takes ⌘⌥2 and Diff
  ⌘⌥3.
- **A long user message is clamped to twenty lines.** A pasted stack
  trace or file no longer buries the answer it asked for. Click to open
  it; nothing is truncated.

## 0.21.0 · 2026-09-18

### New

- **Mention another session from the composer with `&`.** A fourth
  picker beside `@`, `#` and `/`. A pick writes the session's title and
  its id, so an agent handed the message has the address to `dray send`
  to rather than a title to go looking for. Two sessions sharing a
  title trail their branch, so you can tell them apart.
- **Each project filter remembers what you had open.** A filter is a
  place you work in, so narrowing to a project no longer leaves a
  session from somewhere else selected, and applying a filter points
  the composer at that project. The arrow keys step the filter.
- **Mark a session unread from its row menu.** A session you have
  already looked at can go back to Completed.
- **Stop all in the subagent panel.** Background tasks an agent left
  running end in one press instead of one at a time.

### Improved

- **fx's provider sits on the agent row as marks.** Both controls now
  fit on one track rather than provider taking a well of its own, and
  each provider opens with a shortlist you can pick from.
- **The Files view opens with the search box focused.** The tree is one
  Escape away.

### Fixed

- **Settling or deleting a session stops everything it started.** A dev
  server or background command an agent launched kept running — and
  settling stopped nothing at all, agent included.
- **Subagent rows no longer shimmer forever.** A run whose task is gone
  now closes instead of sitting there with a Stop button for the rest
  of the session.
- **Switching to the settled list is quick again, and opens as you
  scroll.** A long history mounted every row at once and the press
  itself took a moment to register; both are gone.
- **A new Codex session keeps the model it always used.** Ranking the
  model picker had quietly moved the default for sessions created with
  no model named.

## 0.20.6 · 2026-09-17

### New

- **The PR tab says how to turn pull requests on.** Without the GitHub
  CLI the tab simply vanished, so nothing said that one install puts
  pull requests on screen. It now stays, draws the command to run with
  a copy button, and a terminal to paste it into.
- **Dray can ask you a question in the app.** A short survey card may
  appear for installs with usage reporting on; turning reporting off in
  Settings turns it off too.

## 0.20.5 · 2026-09-17

### Fixed

- **An fx session keeps its own provider's models.** Switching provider
  in one session moved the model list under every other fx session, and
  could repair a session's model onto the provider it had just left.

## 0.20.4 · 2026-09-17

### Fixed

- **The effort control on an fx gateway model now matches what the
  model takes.** Dray reads each model's levels from the gateway's own
  catalog, so a model with no reasoning levels — grok-4.6,
  claude-sonnet-4 — draws no effort control instead of offering four
  the model refuses.

## 0.20.3 · 2026-09-16

### Fixed

- **No more stray chime at the end of an fx turn.** Naming an fx session
  played fx's own completion sound, which landed where the first turn
  finished and read as Dray having grown a sound per turn.
- **A session that fails to get a title now says why.** The agent's own
  reason was being thrown away as it was written.

## 0.20.2 · 2026-09-16

### Fixed

- **An fx turn ends when the answer does.** fx held every first reply
  for several seconds while it wrote the session title, leaving the
  working indicator spinning over finished work. Dray titles those
  sessions itself now.

## 0.20.1 · 2026-09-16

### Fixed

- **The sidebar and the right panel can no longer be dragged over the
  conversation.** Each now stops where the chat's own width begins,
  whatever the window size and whatever the other pane is holding.
- **A session header no longer overlaps itself** in a narrow column.
- **The working indicator shows up when a queued prompt is handed
  over**, instead of leaving the transcript looking dead until the
  model spoke.

### Improved

- **The Changes panel says something useful when a turn changed
  nothing**, with a way through to the Diff view.

## 0.20.0 · 2026-09-16

### New

- **The sidebar and the right panel drag wider.** Both were fixed
  widths; each now holds at its default mid-drag so you can find it
  back by feel, and the separator works from the keyboard too.
- **The split view takes more than four panes.** The 2x2 cap is gone —
  the screen decides — and digits 1-9 reach panes row by row. Dropping
  a session onto an empty main column opens it.
- **⌘W closes the thing you are looking at**: the Files view's file,
  the Browser's tab, a split pane, then the panel's browser.
- **The file list hides**, leaving its filter row and the code pane.
- **fx sessions change provider mid-conversation.** It used to be
  creation-time only, and a session whose provider had moved
  underneath it could not be opened at all.

### Improved

- **A large file opens instantly in the Files view.** An 8000-line
  lockfile switched tabs in ~56ms where it took up to 900ms.
- **The PR panel costs a fraction of your GitHub rate limit.** Reading
  a branch used to spend 11 API points per poll, which two Dray windows
  could drain in an hour and leave every agent's own `gh` call failing.
  It is 2 now.

### Fixed

- **fx keeps its working indicator up for the whole turn**, instead of
  going dark while the model wrote its first message or worked behind a
  finished one.
- A newly opened file tab scrolls into view rather than sitting off the
  end of the strip.

## 0.19.0 · 2026-09-16

### New

- **A Files tab beside Chat, Changes and Browser.** A folder tree with a
  filter box, an editor's tab strip, and the same code renderer the diffs
  use. A file link in the transcript opens here rather than leaving for an
  external editor; ⌘-click still goes out there.
- **fx takes your whole held queue as one turn.** A second sentence typed
  while fx is working no longer waits out the answer to the first, and
  **Now** (⌘⏎) under the newest bubble stops the wait and sends
  immediately.

### Improved

- **Code colours ~6x faster.** A 2000-line diff took 5.8s to highlight and
  now takes 0.9s.

### Fixed

- **A prompt sent to a resumed session shows up straight away**, instead of
  sitting off screen for the seconds the agent takes to wake up.
- ⌘⏎ no longer sends the draft by accident.

## 0.18.5 · 2026-09-16

### Fixed

- **A screenshot no longer disturbs the page you are looking at.** An agent
  sizing one used to leave the browser pane letterboxed for the rest of the
  session, and taking one visibly reflowed the page on screen. The size an
  agent asks for is capture-only now, and the view hides behind a still of
  the page for the shot.

## 0.18.4 · 2026-09-15

### New

- **fx is told Dray's rules**, which it had no way to learn before —
  `fx acp` has no system-prompt surface at all, so they ride the first
  prompt of a new session and the transcript still shows what you
  wrote.
- **fx's remaining tool calls are drawn as work** rather than as wire
  names: a fetched page reports what it fetched, a search names its
  pattern instead of the directory it scoped, and a run of subagents
  lists its tasks rather than collapsing into a count.

### Fixed

- **The browser pane stays on screen under menus and dialogs.** Any
  dropdown anywhere left it a hole; now it only hides where something
  actually lands on it, behind a picture of the page.
- **An error stays in the session it came from.** One session's
  failure used to follow you into every other session and the new-task
  composer.
- **A new fx chat keeps a model that matches its provider**, rather
  than sitting at "Select Model" after a provider switch.
- **fx is drawn last in the agent list**, and ⌘⇧A steps the same
  order.

## 0.18.3 · 2026-09-15

### Fixed

- **fx sessions get the MCP servers from `~/.fx/mcp.json`.** `fx acp`
  reads no config of its own, so a Dray fx session ran without the
  tools the same machine's `fx` shell had. Sent on resume too. A
  server Dray cannot authenticate is dropped rather than taking the
  whole session with it, and tokens named by `bearer_token_env` are
  read through the login shell, so a launch from the Dock resolves
  them like a terminal does.
- **⌘⌥↑/↓ steps projects**, which is what it always said it did — it
  only moved by project where a split group existed, and otherwise
  repeated ⌘⇧↑/↓.

## 0.18.2 · 2026-09-15

### New

- **Fast mode**, a row in the model picker, on Claude Code, Codex and
  fx. Each vendor charges for it differently, so the row carries their
  own sentence about what it costs. Claude Code and Codex can be moved
  in place; fx settles at creation. pi has none.
- **`dray new --fast`** starts a spawned session on that tier. A
  session inherits its parent's setting only within the same agent.
- **Claude Code says when it refuses fast mode**, and that sentence is
  drawn under the row rather than the switch sitting lit while the
  turn runs at ordinary speed.

### Fixed

- **An fx session resumed after a provider switch keeps its own
  provider**, rather than coming back on whatever fx points at now and
  failing the turn with nothing on screen saying why.
- **An fx model that refuses the effort it was left on now opens.**
  The level is dropped, the prompt still sends, and the transcript
  names the levels that model does take.
- **fx's fast tiers are read off the gateway's own list**, so the
  toggle is offered where it works and the duplicate `-fast` rows stay
  out of the picker.
- **Switching fx provider leaves `~/.fx/settings.json` at the
  permissions it found**, where it used to hand the file back
  world-readable on every switch.

## 0.18.1 · 2026-09-14

### New

- **fx sessions get a `/` picker**, filled from the skills fx itself
  would run — its own roots on disk, since fx publishes no command
  list. A skill linked in from outside the workspace or home is left
  out, matching what fx will actually load.

### Improved

- **A harness with no slash commands says so in one line** instead of
  opening an empty menu, and only once its own list has answered — a
  CLI that could not be reached is not a CLI with nothing to offer.

## 0.18.0 · 2026-09-14

### New

- **fx is a fourth harness.** Pick it in the composer like Claude Code,
  Codex or pi: sessions stream, resume and stop, permission requests
  are answered in the transcript, and model, effort and stance apply to
  a running session in place. Models come from fx itself, so one it
  ships is pickable without a Dray release. fx has two stances of its
  own, Ask and Auto, so the picker offers those: a session arriving on
  Plan asks about everything, and one arriving on Bypass runs as Auto.

## 0.17.3 · 2026-09-14

### Improved

- **A failed turn draws one muted line, not a paragraph in red.** A
  refusal's own reasoning is truncated to its first line, and it leads
  with "Permission denied." where that verdict would otherwise sit past
  the cut.
- **The `#` issue picker opens from the same cache the Issues page
  fills.** Opening it and typing in it no longer costs a Linear round
  trip each, and cached rows are filtered locally while the network
  answers.

### Fixed

- **A session whose login expired now recovers on the next prompt.**
  The CLI remembers being logged out for the life of its process, so
  logging in next door changed nothing and restarting the app was the
  only cure. Dray restarts the child itself, even where a background
  task is still running.
- **Sessions whose worktree was removed outside Dray are repaired at
  launch**, so the PR panel stops reporting that it could not run `gh`.
  A session is never moved into a checkout another session is working
  in.
- **Browser screenshots are laid out at a real viewport** — 1440×900,
  or whatever `set viewport` / `set device` last asked for — rather
  than at the pane's own width, which returned desktop pages at phone
  breakpoints.
- **A subagent run with nothing to open no longer sits indented** under
  one that has something.

## 0.17.2 · 2026-09-13

### New

- **Codex's model list comes from Codex.** A model OpenAI ships is
  pickable the day it lands rather than the day Dray next releases. The
  first two rows are the top level and the Shift+Tab cycle, so a new
  flagship arrives there on its own; the rest fold into More models. The
  built-in table stays as the offline fallback.

### Improved

- **A prompt running one of Greptile's commands is tinted to say whose
  it is**, queued or sent.
- **Analytics counts a day you used Dray**, not only a launch or a new
  session — a day spent in one resumed session read as nobody there.
  Still nothing about what you write.

### Fixed

- **Links in your own messages no longer draw a dark underline** under
  white text in default light.
- **A subagent run with nothing to show can't be expanded** onto an
  empty box. It opens again as soon as it has events.

## 0.17.1 · 2026-09-12

### Improved

- **Analytics moved to PostHog, and the settings row now says what is
  measured.** Three events — a launch, a session starting, a feature
  being used — and nothing about what you write. Opting out clears the
  install id, so opting back in reads as a new person. Crashes and
  wire-format failures report where they happened — a file and line, a
  harness and stage — and never the message beside it, since those carry
  prompts, code and paths.

### Fixed

- **Opting out can no longer be undone by an unrelated setting.** A
  transcription pick or a Linear account written back from a stale read
  restored analytics to on.
- **Installing an update waits on the turn, not on background tasks.** A
  session running a dev server used to block the button for good.
- **A subagent row stops shimmering once its run goes to background.**
- **Sidebar dates stay on one line.**

## 0.17.0 · 2026-09-11

### New

- **Font size and shortcut rebinding in Settings.** Interface, chat and
  code each take their own size, applied before the first paint like the
  theme. Every shortcut in the app can be recorded onto another chord;
  a chord another action or the system already holds is refused and the
  row names the holder. Keycaps everywhere draw what the key actually
  fires.

### Improved

- **A fresh install opens in light mode.** A pick you have already made
  is untouched.
- **Unfocused panes dim while you type.** One composer under four
  transcripts can send into the wrong session, so the panes step back
  the moment typing takes the placeholder's name away.

### Fixed

- **The right pane remembers itself per session.** One app-wide flag left
  it opened on a session's PR and blank beside the next, which had none.
  The tab pick follows the session; in a split, the pane's open state
  follows the group.
- **The Subagents tab is hidden where a session has none**, the same rule
  the PR, Docs and Issue tabs follow.
- **PR comment previews read as text.** A bot writes HTML as often as
  markdown, so a collapsed row drew raw `<h2><a href="...">` tags.

## 0.16.2 · 2026-09-10

### Fixed

- **⌘1–4 run clockwise round the split.** They followed the order panes
  were added, so in a 2×2 ⌘2 landed under ⌘1 rather than beside it. Now
  top row left to right, then bottom row right to left.

## 0.16.1 · 2026-09-10

### Improved

- **Each theme sets its own glass.** How much desktop shows through the
  window was one number for every palette, so it was tuned for none of
  them. Every shipping theme now names its own, light and dark apart.

## 0.16.0 · 2026-09-10

### New

- **Up to four sessions side by side.** Drag a sidebar row onto the
  transcript to open it beside, above or below the one you are on, or to
  drop it on top to replace it. The panes make a group, which lives under
  the space you made it in and draws as its own run at the top of the
  sidebar; it dissolves when one session is left. One composer serves the
  focused pane and names it in the placeholder. ⌘1–4 focus a pane, ⌘⌥W
  closes one, ⌘⌥↑/↓ step groups as a single row. **The view tabs moved to
  ⌘⌥1–3.**

### Fixed

- **Stop no longer kills your dev server.** It interrupted the turn and
  then stopped every background task with it — Monitors, subagents and any
  server you had asked to keep running. Backgrounding a task is a request
  for it to outlive the turn, so Stop now ends the turn and leaves them be.
  The subagent panel still stops one on its own.
- **Code takes its colours from the app's palette.** Every diff and fence
  drew Pierre's theme whatever you had picked, since the default only ever
  resolved the light or dark half. Catppuccin, Gruvbox and One Dark Pro now
  reach the themes they were ported from.
- **Switching to a session with browser tabs no longer opens the right
  pane.** Only an agent opening the first tab does that, which is what it
  was for.

## 0.15.0 · 2026-09-09

### New

- **An issue's status and priority change from Dray.** Menus on the opened
  issue's header and on the Issues page's rows — the first thing Dray
  writes back to a tracker. The glyph moves as you click and the write
  reconciles behind it; a refused write puts the old value back and shows
  what Linear said. ⌘⇧F focuses the Issues search, ⌘-click opens a row in
  Linear.
- **Markdown in your own messages renders.** `**bold**`, `` `code` `` and
  `[links](https://example.com)` draw as themselves in the prompt bubble
  instead of showing their delimiters. Inline marks only — a prompt is a
  sentence, not a document, so headings and bullets stay the characters you
  typed.
- **Paths in a message are clickable and open at their line.** `src/a.ts:12`
  in your own message or the agent's opens the file there. Relative paths
  resolve against the session's directory.
- **Shift+Enter continues a markdown list.** A new `- ` or the next number,
  with the items below renumbered; on an empty item it takes the marker off
  instead.

### Fixed

- **A message relayed with `dray send` no longer arrives as one paragraph.**
  A literal `\n` written into a shell string now draws as a line break.
- **Opening a menu no longer killed every keyboard shortcut for the rest of
  the session.**

## 0.14.0 · 2026-09-05

### New

- **Dray has a browser.** ⌘3 for the full view, or the Browser tab in the
  right pane. Tabs with favicons, device sizes, zoom, hard reload and
  DevTools on their chords, and a list of local servers that shows only
  this checkout's — another worktree's dev server never appears. Each
  session gets its own tabs and its own cookies.
- **Chromium is not in the download.** The app fetches it a few seconds
  after the first window opens, ~330MB, and Settings → Integrations shows
  where it has got to. Keeping it out of the bundle keeps it out of every
  update too.
- **`dray browser` lets an agent drive that browser** — open pages, click,
  type, read and screenshot, in its own session's tabs and nowhere else.
  **It needs a matching CLI: run `dray update`.** An older `dray` is
  refused by this app outright, and that refusal covers every command, not
  just the browser ones.
- **A link in the chat asks where to open.** Dray's browser or the system
  one, with ⌘-click skipping the question. URLs you type in your own
  messages are clickable now too.
- **⌘F searches the sidebar.** It works with the sidebar collapsed, and Esc
  clears the field while you are typing in it. Settling a session clears
  the query too — you found the row you came for, and the list it lands in
  is filtered by that same query.

### Improved

- **Transcripts you have stopped looking at leave memory.** Every one opened
  since launch used to stay resident, around 650MB after a day. A transcript
  is dropped on archive, on settle, and after ten minutes unviewed — never
  the one on screen, never one mid-turn, never one holding a card. Pictures
  in a transcript load as you reach them rather than all at once.
- **The main column's Changes tab is now called Diff**, which is what it
  shows. The right panel keeps its own Changes tab — that one answers what
  this turn did, where the view answers what the repository looks like.
- **A large amount of unused code is gone** — dead components, duplicated
  helpers, a marketing page's worth of unshipped sections. None of it was
  meant to change what the app does.

### Fixed

- **A notice on its way out no longer swallows the next one's shortcut.** A
  card that says "Deleted" sits for a moment before it goes, and it stayed
  what ⌘G and ⌘⇧D acted on for that whole moment — so one press did nothing
  and the other dismissed a card already leaving. One press is now one card.

## 0.13.2 · 2026-09-04

### Fixed

- **Installing an update relaunches the app again.** Install swapped the
  bundle and then quit for good — the relaunch ran on a path this app's own
  exit handler got to first. It now launches the new bundle before the old
  one exits, and a refusal is reported instead of leaving nothing running.
- **A sidebar row's working orb no longer overlaps its title.** The slot
  took its width from the hover buttons, which a pinned row mid-turn draws
  none of.

## 0.13.1 · 2026-09-03

### Improved

- **The space switcher takes the project filter's shape** — a name over a
  dot track, click to step to the next — so the two controls that scope the
  session list work the same way. Their order is yours to set, with ▲▼ in
  Settings.

### Fixed

- **Memory: the working orb and the shimmer get their own compositing
  layers.** Both repaint every frame, and painted into the page they
  repainted the whole document at animation rate whenever a session was
  mid-turn — which fed a WebKit leak of around a gigabyte an hour of use.

## 0.13.0 · 2026-09-03

### New

- **Spaces scope the sidebar to a set of projects.** A space is a tag on a
  project, so joining one needs nothing set up. Switching narrows the
  sidebar, the project picker, the session chords and both notification
  channels; the dock badge still counts everything, since it names no
  session.
- **The docs panel watches the files it has open.** A doc edited elsewhere
  is picked up rather than sitting stale until Refresh — a clean one adopts
  the new text, a doc you were editing keeps every keystroke and asks at the
  save whether to discard, overwrite, or back out with the text intact.
  ⌘⇧← and ⌘⇧→ step between docs.
- **Codex gets a slash picker, filled from its skills.** Codex expands no
  slash command, so a picked skill travels as its own input item instead of
  as prompt text. A lookup that cannot be made fails the send rather than
  going out as literal text.

### Improved

- **A question card's free-text answer is a box that grows.** A typed answer
  runs to a sentence, where the old single-line input scrolled it sideways
  out of view. Shift+Enter adds a newline.
- **Settle is hidden while a turn is running**, since the write lands but
  the agent keeps working.

### Fixed

- **Memory: transcripts you are no longer looking at are let go.** Every
  transcript opened since launch stayed resident — around 650MB after a day.
  They are now dropped on archive, on settle, and after ten minutes
  unviewed, never the one on screen, one mid-turn, or one holding a card.

## 0.12.8 · 2026-09-02

### Improved

- **Dictation loads its model on the press, and lets it go.** The engine was
  warmed at launch and held for the session — most of a gigabyte resident
  whether or not you ever dictated. It now loads when you start recording
  and unloads after ten idle minutes.
- **Settled sessions no longer split out Pinned.** A pin keeps a session in
  reach while the work is live; a history has no use for the group, so it
  and the Pin action are gone from the settled view.

## 0.12.7 · 2026-09-02

### Improved

- **Light mode is tinted, and it is Default's own palette now.** Light was
  the derived ramp at no hue; it runs cool blue throughout — tinted greys,
  a blue primary, and veils mixed off the foreground so they take the hue
  without naming a colour.

## 0.12.6 · 2026-09-02

### New

- **Check for Updates from About.** The menu bar's check reported into the
  sidebar, so a collapsed sidebar left the answer nowhere to land. The
  About tab carries the same check and every state of it.

### Fixed

- **pi's edits draw a diff again.** pi spells a replaced region
  `oldText`/`newText`, where the diff reader only knew
  `old_string`/`new_string` — so every pi edit printed raw JSON instead of
  the change it made.

## 0.12.5 · 2026-09-02

### New

- **A More models submenu, and Ultra on Codex.** The model menu keeps the
  models worth a chord at its top level and folds the rest under "More
  models"; Shift+Tab cycles exactly what the top level draws. Claude Code
  cycles Fable 5.1 and Opus 5, with Fable 5, Sonnet and Haiku below —
  where a pinned previous generation is the only route to a model no CLI
  lists. Effort gains Ultra above Max, offered per model, since that is
  how Codex reports it.
- **The sidebar leads with what is waiting on you.** Each project splits
  into needs-attention, then completed, then the rest, so a session
  blocked on a question no longer sits wherever recency put it. A nest
  takes the strongest state anything in it holds, and a project under
  three rows is left whole.
- **Start a task from a project heading.** Hovering a heading reveals a
  plus; clicking it opens the empty composer with that project picked.
  ⌘⇧P steps the project picker where it is drawn.

### Fixed

- **Agent CLIs installed through a version manager are found.** A bundled
  app inherits launchd's PATH, so only the known-directories list can find
  a CLI, and it knew nvm alone — a mise- or asdf-managed install went
  undetected. Every child also gets a `node` it can actually run, which is
  what an npm-installed CLI needs to start at all.
- **A new session's first prompt draws straight away.** It used to wait on
  the worktree, the spawn and the harness ack — one to two seconds on
  Codex and pi — while every later prompt appeared at once.
- **The spinner stops wobbling over glass.** Unpromoted, the rotating box
  was snapped to whole device pixels every frame, so a small arc orbited
  by a subpixel wherever it sat over the window's vibrancy.
- **Switching agent no longer flickers the model menu.** One list carried
  the previous harness's answer until the next landed, drawing one agent's
  models under the other's name.

## 0.12.4 · 2026-09-01

### Fixed

- **Quitting no longer crashes.** Once a transcription model had been
  loaded, quitting raised a crash report every time: the Metal backend
  frees its residency sets on the way out, after the Metal runtime is
  already down. 0.12.3 made this everyone's problem by loading a model
  at launch rather than on the first press.

## 0.12.3 · 2026-09-01

### New

- **A failed dictation keeps the audio.** The samples used to go into
  the engine and vanish with it, so the only cure was saying the whole
  thing again. Every recording is now parked on disk until the model
  answers, and Retry sends the same audio back through — including when
  the failure was a model that wasn't installed yet.
- **Other audio is muted while you dictate.** The microphone hears the
  speakers, so anything playing landed in the transcript as words nobody
  said. Your prior state is restored, so a machine already muted stays
  that way.

### Improved

- **The model loads before you press the mic**, at launch and whenever
  the selected model changes. Loading takes seconds and a first
  dictation is usually one word, so it could not hide behind the
  recording. Costs a resident model for a reader who never dictates.
- **Deleting a worktree from a notice is ⌘⇧D**, since plain ⌘D is
  dictation app-wide and a card raising itself mid-sentence must not
  take a chord the composer owns.
- **The composer takes focus when dictated words land**, and only if
  you are still on the session you spoke into.

## 0.12.2 · 2026-09-01

### New

- **Start work on an issue from the issues page.** The button hands you the
  empty composer with the issue already tagged, rather than starting a session
  behind your back — the page spans the whole workspace, so the project, agent
  and model are still yours to pick.

### Fixed

- **Dictation can reach the microphone.** 0.12.1 shipped it unable to: the
  bundle is signed with the hardened runtime, under which macOS refuses the
  mic before ever prompting unless the audio-input entitlement is granted. No
  dialog appeared and no row showed up in Privacy & Security.
- **The context ring fills for pi sessions**, and stays empty rather than
  showing a figure that would mislead — after a compaction, or on a turn that
  failed or was stopped.
- **The issues page waits for its first read.** Only the settled headings can
  draw without an answer, so for a beat they were the whole page and it read
  as a workspace with nothing left to do.

## 0.12.1 · 2026-09-01

### New

- **Dictate a prompt, transcribed on this machine.** ⌘D, or the mic beside
  send. No audio leaves your computer.

  **No model ships with the app** — Settings gains a Transcription tab that
  downloads one, and pressing the mic with none opens it. Each model lists its
  languages, size, and speed and accuracy scores.

  The words land in the draft of the session you spoke into, so switching away
  mid-recording doesn't lose them or file them somewhere else. Stop and cancel
  are separate controls; Escape cancels.

### Fixed

- **A resumed session no longer sorts its whole history above the reply.** A
  subagent numbers its own events from zero in the same log, so reading the
  last line restarted the count — and every event after it drew above
  everything that came before, which read as the answer never arriving.
  Already-affected logs heal on the next read.
- **⌘⇧A reaches pi.** The chord toggled between two agents, written when there
  were two, so the third was unreachable from the keyboard. It now steps the
  picker's own order.
- **A new session keeps the model you picked for that agent.** Starting one
  after visiting another agent's session repaired your pick against the wrong
  agent's list and landed on whatever led it.
- **The send button turns into Stop rather than swapping**, and spinners no
  longer wobble on the pull request buttons.

### Upgrading

- **macOS 11 is now the minimum.** The transcription engine needs it, and the
  version claimed before was a default nothing had tested.

## 0.11.0 · 2026-09-01

### New

- **pi runs, as a third agent.** Pick it in the composer beside Claude Code and
  Codex. Sessions stream, resume and stop; reasoning, answers, tool calls and
  token counts all reach the transcript.

  **A pi session runs ungated, and that is pi's own shape, not a setting.** pi
  has no permission system — not a different one, none — so there is nothing
  for Dray to ask through and the stance picker is hidden there. Everything the
  agent runs, it runs. The gate is an extension Dray will ship; until then, know
  what you are starting.

  pi names no default model on purpose, since which models work depends on the
  providers you have logged into. With none picked, pi's own settings decide.

- **A model library, for agents with more models than a menu can hold.** pi's
  list is whatever every provider you're logged into serves, so the picker draws
  your starred models grouped by provider and a searchable dialog holds the
  rest. A session's own model always draws, starred or not. Claude Code and
  Codex keep their whole list — each ships a handful, where a shortlist would be
  one more thing to set up.

### Fixed

- **Stopping a pi session asks it to leave rather than killing it.** pi holds a
  lock while it runs and a clean exit releases it, where a kill leaves the next
  pi waiting the stale one out for ~30 seconds — which looked exactly like Dray
  hanging, in a different session.
- **A pi that dies mid-turn closes its own turn**, rather than leaving the
  session working with a finished transcript and a Stop that did nothing.

## 0.10.1 · 2026-09-01

### New

- **Two more themes: One Dark Pro and Cobalt2.** Both dark-only. The default
  palette is called Dray now — the same colours under a name of its own, and
  the theme you had set stays set.
- **Copy a table from the chat.** Wide markdown tables scroll in place instead
  of being squeezed to a letter a line, and hovering one reveals a copy
  control.

### Fixed

- **A queued prompt draws its attachments.** An image attached to a prompt sent
  mid-turn looked dropped until the turn ended. Cancelling a queued prompt now
  hands the files back to the tray with the text.
- **A new worktree can't take a name a landed branch still holds.** The
  `worktree-<name>` branch stays on the remote after a session settles, and the
  PR tab looks sessions up by branch — so a redrawn name opened onto an
  unrelated merged pull request. The pool of names is much larger now, since
  every landed PR retires one for good.
- **Deleting a worktree no longer holds the dialog open** behind a spinner. The
  press starts the work and the surface answers at once; a refusal that lands
  afterwards takes it back and carries git's own reason.
- **A project heading no longer drifts a tooltip over the sidebar** while
  you're scanning it.
- **Fullscreen drops the glass for every theme**, not just the default. There
  is nothing behind a fullscreen window, so the layering cost contrast and
  bought no depth.

## 0.10.0 · 2026-08-31

### New

- **Markdown opens in the side panel, and you can edit it there.** Clicking a
  `.md` file in the chat used to hand it to an external editor to read
  something Dray already renders. It now opens in a Docs tab beside Changes
  and PR, with a view/edit toggle. Anything that isn't markdown still goes to
  your editor.

  Saving is explicit, and a save is refused rather than landing if the file
  changed underneath — the agent shares the checkout — with Reload or
  Overwrite offered at that point.

- **A Branch tab in the Changes view, for this session's own commits.**
  History logs the whole branch, so a session's commits sat buried under
  however long the branch it forked from is. The base comes from the branch's
  own reflog, so a session started from another session's branch doesn't claim
  that branch's work.

- **Beta updates, in Settings under About.** The channel existed and nothing
  could reach it. Turning it on offers prereleases; turning it off leaves you
  on the next stable build, since a stable release always sorts above the
  betas that preceded it.

### Fixed

- **A light palette on a Mac set to Dark no longer goes grey.** The window's
  blur followed the system rather than the mode you picked, and light hid it
  by nearly giving up on glass. It's properly translucent again.
- **The composer has an edge again in dark mode.** It was left with neither
  border nor shadow, so the card floated over the transcript with nothing
  drawing the box.
- **A stable release no longer moves the beta channel backwards.** A hotfix
  shipped while a beta was open replaced the beta manifest with an older
  version, so beta readers saw nothing and a fresh opt-in could never reach
  the open beta.

## 0.9.3 · 2026-08-31

### Fixed

- **Merging a pull request no longer announces every other one as ready.**
  GitHub recomputes mergeability across the project on a merge, and each PR
  settling back out of that window raised its own "Ready to merge" card.
- **An unrecognised agent name no longer empties the sidebar.** One session
  written by a build that knows an agent this one doesn't failed the whole
  index, so every other session vanished with it. The name is now carried
  through untouched.
- **Unsettling a session follows it out of the settled view.** The row left
  the list it was drawn from and the view stayed put, so the reader was left
  looking at where it had been.
- **The agent names files by absolute path**, so a filename in its prose is a
  link you can click. Codex also learns what "parent session" means — it read
  it as a git parent and went looking through commits.

## 0.9.2 · 2026-08-30

### New

- **Light mode works for the Default theme.** It was the last theme with no
  light side, so the mode picker sat disabled for anyone who never changed
  palette. System, Light and Dark all apply now.
- **A logged-out agent offers a way back in.** An expired login ended every
  turn with the harness's own sentence and nothing to do about it — `/login`
  cannot be reached from inside a session. The composer now names the cure and
  a button opens the login in a terminal. A wording neither harness recognises
  still reports the failure as before.

### Improved

- **Model takes Shift+Tab**, the cheapest chord, since it is the pick reached
  for most often; effort moves to ⌘⇧E and double-tap Shift is gone. ⌘I opens
  the issues page.

### Fixed

- **A failed turn draws its sentence once.** The harness sends it twice, so
  every failure appeared in white and again in red.
- **Opening a long session is fast again.** A 61-turn session took ~700ms
  before anything appeared; the newest turns now draw first and the rest fill
  in above them.
- **`dray` tells a sandboxed refusal from a closed app.** Every connect error
  read as "Dray isn't running", which named no cure when the real cause was
  the agent's own sandbox. Update the CLI with `dray update`.

## 0.9.1 · 2026-08-29

### New

- **Codex knows Dray's rules.** Claude Code was given them at spawn and Codex
  was given nothing, so it knew neither the reply style nor that `dray`
  exists. It has its own instructions now, sent on resume too, and
  `dray skill install` writes the skill where Codex reads it. Update the CLI
  with `dray update`.

### Fixed

- **A Codex session gets a generated title.** Titling always shelled out to
  `claude`, so a reader without it installed silently kept every session's
  prompt-derived title. Codex titles itself now.
- **The model picker remembers a model per agent.** One stored pick served
  both, so switching agent and back replaced a deliberate choice with whatever
  led the list. A new Claude Code session also seeds Opus rather than Haiku —
  seeding cheap made every untouched session weak.
- **A spawned session no longer inherits an effort its agent didn't ask for.**
  The two ladders share every name and Codex accepts whichever is passed, so a
  Claude parent on High started its Codex child above Codex's own default,
  silently.
- **The composer's picker is readable over the transcript.** It was the last
  floating list with no blur behind it, so the transcript showed through the
  list of files or commands.

## 0.9.0 · 2026-08-29

### New

- **Codex runs, as a second agent.** Pick it in the composer beside Claude
  Code and the session spawns `codex app-server` instead. Sessions stream,
  resume and stop; the transcript draws messages, reasoning, shell calls and
  file diffs; the context ring fills. Approvals are wired, and the buttons on
  the card are Codex's own — where it offers no way to refuse, Dray adds one.

  Two differences are Codex's, not choices: it splits Dray's permission mode
  into two settings (when it asks, and what a command may touch), and it has
  no plan mode, so Plan is hidden there. Changing model, effort or mode
  restarts the session, image prompts are not supported yet, and a Codex
  session cannot be forked.

- **The agent's CLI is checked before you type.** Picking an agent that isn't
  installed marks it in the picker and draws a notice with the vendor's own
  install command and a link, rather than failing after a session already
  exists.

- **Click a filename in the chat to open it in your editor.** It revealed the
  file in Finder before. Tool rows, `@mentions` in your own messages and a
  path an agent writes into a sentence all reach it, and the editor is its own
  preference — Finder stays the default, and any failure falls back to it.

- **Open a session's working directory in an editor, terminal or Finder.** A
  split button in the right panel's tab row: the left half opens in whichever
  app you chose last, the chevron picks without launching anything. Installed
  apps are detected with their own icons.

### Improved

- **Settings has tabs.** Five groups in one scroll meant reading past four
  to change one.
- **Accept edits is gone as a permission mode.** It applied file edits without
  asking while still asking about commands — too narrow a promise to sit
  beside Auto. Sessions set to it now read as Auto.

### Fixed

- **A session running a dev server can be forked again.** Fork refused while
  any background task was outstanding — and a dev server never ends — so it
  was refused for the rest of that session's life, with the menu item left
  enabled. It now refuses only while a turn is actually in flight.
- **`dray issue link` works inside a worktree session.** The documented form
  named `$DRAY_SESSION_ID`, and the agent's own guard refuses any command
  naming an environment variable there — silently, so the issue was never
  linked. The session id is now optional and read by the CLI itself. Update
  the CLI with `dray update`.
- **"Spin up a session" starts a Dray session.** That phrasing and its
  neighbours reached for the agent's own subagent tool instead.

## 0.8.2 · 2026-08-28

### New

- **A Skill call reads as one.** The harness types it like any other tool and
  leaves the title empty, so the row said "Skill" over raw JSON and a result
  that only repeated the name. It now carries the skill's name in the header
  and its brief as prose, and the name shows as soon as it lands.
- **A retrying turn says so.** The API retries up to ten times behind a turn
  that otherwise just looked slow. The attempt count leads, and the cause is
  named where the wire carries one.

### Improved

- **Run server moved into the handoff row**, behind the composer, where the
  other canned prompts live — the toolbar sets things, and this one acts.
  The row is three buttons now: Commit, Create PR and Run server. Five ran
  wider than the composer and drew over the right panel. Commit & push,
  Draft PR and Push are a sentence in the composer like every other button
  there already is.

### Fixed

- **A `#DRA-53` you typed no longer links the session to that issue.** Every
  tag in a prompt was written onto the session, so "this is unrelated to
  #DRA-53" filed the session under it forever. The tag still draws as a
  button; linking is the agent's to do.
- **A question the CLI withdraws no longer leaves its card standing.** The
  card sat there answering nothing and the waiting mark stayed lit until the
  session ended.
- **A failed turn shows what went wrong.** It printed "Turn failed —
  stop_sequence" over the harness's own sentence, which is the half worth
  reading — "resets 9:05pm", "run /login".
- **The branch button in the session header says what it copies.**

## 0.8.1 · 2026-08-28

### New

- **Run server, in the composer toolbar.** Starting a session's dev server
  meant finding its worktree path and pasting it into a terminal, once per
  session. The button sends the prompt instead, so the server lands as a
  background task the orb already shows and the subagent panel already stops.
- **Click the branch in the session header to copy its directory.** That path
  is what gets pasted into a terminal, and a worktree session's directory is
  not the repository root the title names.

### Fixed

- **A background task no longer holds the turn open.** A dev server, a
  `Bash(run_in_background)` or a `Monitor` never ends on its own, so the
  session sat working — Stop armed, the indicator spinning, no completion
  notice — until you clicked Stop yourself. The turn now ends with the
  agent's own reply, and a background subagent reporting back later opens
  its own turn, which is what the hold was there for.
- **A tool call caught by a child exiting no longer shimmers forever.** The
  CLI cannot announce its own death, so the last task set stood until
  something else replaced it.
- **Badge images in a pull request comment sit on their line.** A severity
  badge inside a heading dropped the title to the badge's bottom edge and
  padded the line out. A paragraph holding nothing but an image keeps its
  own spacing.

## 0.8.0 · 2026-08-27

### New

- **Linear issues, read-only.** An Issues page in the main column with scope
  chips, search and groups by state; an Issue tab in the right panel carrying
  the description, uploads, people and comments; and `#DRA-53` tags in the
  composer that resolve on send and open the issue from the sent message.
  Connect with a personal API key on the page itself — Dray never writes to
  the tracker, so nothing moves status or leaves a comment. Your agent still
  wants Linear's own MCP server to read an issue in full.
- **Themes, and light mode.** Default (the old greys), plus Catppuccin and
  Gruvbox as real ports. Light mode ships for both; Default stays dark-only
  and the mode control says so. Set them in Settings, under Appearance.
- **Search the sidebar.** The Search button becomes a field in place and
  typing narrows the list by title. Pins, project headings and nesting all
  hold while a query is on.
- **A Pinned group leads the sidebar.** Pinning worked end to end and drew
  nothing; a pinned session now leads the list whatever project it is in, and
  its children follow it there.
- **Delete branch on a merged or closed pull request.** Merging left the head
  branch on the remote forever. The row is remote-only and refuses a fork's
  branch outright.
- **`dray update` stops when it is already current.** It used to download and
  swap the binary every time and say nothing about being up to date. `--force`
  still reinstalls.

### Fixed

- **A new task no longer opens with the wrong pane.** The right pane is
  app-wide, so a new task inherited whichever one the last session left open
  and drew an error the moment the first prompt created the session.
- **`[blocked]` no longer lands in prose.** Link hardening dropped an
  unresolvable href and then wrote the word beside it, so review badges and
  bare relative paths in agent output both put it into the text you read.
- **The dev build names its checkout.** Several worktrees mean several dev
  builds that look alike, so the badge reads `Dev · <branch>` and sits at the
  bottom of the sidebar.
- **A busy dev port no longer fails the build.** One worktree's `pnpm tauri
  dev` refusing to start because another's is already running was the ordinary
  case with several sessions open; the port is now probed upward from 1420.

## 0.7.3 · 2026-08-26

### Fixed

- **The sidebar mark and the PR panel no longer disagree.** They read GitHub
  separately — one per repo, one per branch — with nothing joining them, so a
  "Ready to merge" notice could land on a panel still saying checks were not
  passing, or the panel went green beside a row still spinning. Each read now
  tells the other when something changed, and a panel-triggered read stays
  quiet so the two cannot keep asking `gh` on each other's behalf.
- **A stale answer can no longer overwrite a newer one.** Reads are sequenced
  per branch, so a slow reply landing last stops winning, and two pull requests
  on one branch are now picked the same way in both places.

## 0.7.2 · 2026-08-26

### New

- **A settings dialog, and analytics behind a switch in it.** Dray now reports
  one event — `app_started`, carrying no properties — so there is a count of
  how many people run it. Nothing about your sessions, prompts, repositories or
  files is collected, and there is no second event.

  **It is on by default.** Turn it off in Settings, or set `DRAY_NO_ANALYTICS`
  in the environment, which wins over the stored setting in one direction: it
  can switch reporting off, never on.

### Fixed

- **A dev build no longer steals the installed app's socket.** They share one
  file, so running `pnpm tauri dev` took the channel over — every `dray` call
  reached the dev app while the installed app's own agents wrote into a socket
  nobody was listening on. Each build now has its own.
- **Project groups follow the project list's order**, not the recency of the
  sessions inside them. Replying to any session used to lift its whole project
  above the others, moving a heading under your eye mid-turn.
- **A relayed message no longer shows its plumbing.** The
  `[message from the Dray session …]` prefix is what tells the receiving agent
  who sent it, but it was drawn in the bubble too — the avatar above already
  says that.

## 0.7.1 · 2026-08-26

### Improved

- **The sidebar groups sessions by project.** All Projects used to interleave
  rows from every repo with nothing saying which one a row belonged to. Rows
  now gather under a muted project name, taken from the sessions actually
  present — so an idle project draws no heading at all. A spawned session stays
  under its parent whatever its own project says, and ⌘⇧↑/↓ still walks the
  order you see.

## 0.7.0 · 2026-08-26

### Upgrading

**Update the app first, then the CLI.** This release moves the app/CLI socket
to protocol v2, and the two refuse each other across that line rather than
guessing — an old CLI silently ignoring a field it does not know is how a
session spawned to review unpushed work reviews none of it and reports back
that everything looks fine. The app is the half that cannot be fixed from an
agent, so it goes first; the CLI then self-heals with `dray update`.

**If you are on CLI 0.1.0, re-run the install command by hand:**

```sh
curl -fsSL https://www.drayhq.com/install.sh | sh
```

`dray update` shipped in 0.2.0, so the refusal names a command that version
does not have. This is the last release that can happen to.

### New

- **Fork a session from the sidebar.** Right-click a row to carry a
  conversation on twice — in place, or into a worktree of its own. The copy
  opens reading exactly like its source, and the fork is lazy: the row appears
  at once and the CLI only does its half on the first send, so forking costs no
  child process and no waiting. Refused while the source is mid-turn, since a
  fork is taken by reading a transcript a live session is still writing to.

- **`dray new --from` bases a spawned session on existing work.** Sessions
  always forked from `origin/<default>`, so a spawned session could not see
  what the session that spawned it had just done — putting "have a second model
  review this" out of reach. Takes a session id, a branch or any ref. Still a
  new worktree; only the base moves, and only committed work travels.

- **The sidebar draws lineage as connector rails.** Each level gets its own
  rail and a row elbows onto its parent's, so a grandchild reads as hanging off
  its own parent rather than off the root.

- **A relayed message is drawn as its sender.** A `dray send` used to land
  looking like something you typed, with the attribution as prose in the text.
  The sender now rides the event itself, above the bubble and clicking through
  to the session that sent it. It gets a generated mark seeded on session id —
  a session is not an account, and the initial-in-a-circle was a people
  fallback standing in for a picture that never existed.

- **`dray ls` says which session spawned which.** The parent is named on the
  row rather than given a second id column, since most rows have no parent and
  two bare uuids under no header read as noise.

- **`dray update` upgrades the CLI in place.** Re-running the installer used to
  be the only route, and it reinstalled the same version forever.

### Improved

- **The commit buttons name what they act on.** "commit" on its own reads as a
  topic rather than an instruction; "commit your changes" settles it.

- **`dray new` no longer takes a worktree name.** An agent has no basis for
  picking one, the app already generates a readable name, and a supplied name
  is one more thing that can collide. Every spawned session still gets a
  worktree.

### Fixed

- **`dray new` from inside a worktree session named the wrong project.** It
  read the worktree it was standing in rather than the repository, so the new
  session got a directory that never gets created — leaving Changes, commit and
  PR all reading somewhere that does not exist. Silent, because nothing could
  tell that guess apart from a deliberate `--project`.

- **A long path or URL moved every other message sideways.** With no
  whitespace to break on it ran past the bubble and set the scroll width of the
  whole column.

- **Re-running the CLI installer reinstalled 0.1.0 forever.** It asked for a
  pinned tag, and nothing else could push a CLI update — the app's updater
  swaps the `.app` bundle, which the CLI is not in. The installer now resolves
  the newest CLI release itself, and refuses rather than quietly installing
  something ancient when it cannot reach the API.

- **A protocol mismatch names the cure, and the right half of it.** A CLI
  behind the app is told to run `dray update`; an app behind the CLI is told to
  update the app. Naming the wrong one is worse than naming neither.

- **A running check no longer sits off the row's centre line**, and it outranks
  the working orb rather than the other way around. The orb reports something
  you set going and can read in the transcript; CI reports on its own schedule
  and the row is the only place it lands.

## 0.6.0 · 2026-08-26

### New

- **An agent can fan work out into its own Dray sessions.** "Work through these
  three issues" now becomes three sessions, each in its own worktree, each a row
  in the sidebar you can open, interrupt and delete like any other. Spawned
  sessions nest under the one that created them, and messages travel both ways —
  a child reporting a summary up and a parent handing extra context down are the
  same command. They inherit the model, effort and permission mode of the
  session that spawned them, and a spawned session may spawn once more but no
  deeper.

  It wants the `dray` CLI, which the agent installs itself:
  `curl -fsSL https://www.drayhq.com/install.sh | sh`. The app installs nothing —
  it only names the capability, and the agent gets on with it.

- **⌘⇧← and ⌘⇧→ step the Changes sub-tabs**, the same shape ⌘⇧↑/↓ already steps
  the session list. Clamped rather than wrapped: with two entries, wrapping
  makes both chords do the same thing.

### Fixed

- **The `dray` install command 404'd.** It resolved GitHub's latest release,
  which the app's own releases take over — so the one command that installs the
  CLI reached a build that never carried it. It now asks for the CLI release by
  name.

## 0.5.3 · 2026-08-25

### New

- **A pull request turning ready to merge says so.** CI reports with nobody
  watching, and the panel's own line going from "Checks not passing" to "Ready
  to merge" is a silent two-word swap you'd only catch by looking. The notice
  is raised whatever you're doing, and only on the transition — a PR already
  ready when the app opens is recorded in silence rather than opening a card
  per landed branch at every launch.

### Fixed

- **Worktree sessions kept their first-prompt title.** Title generation ran in
  the session's own directory, which for a worktree the CLI only creates after
  launch — so the spawn failed into stderr and the fallback stood. Every
  worktree session on disk had one.
- **Deleting a worktree still cost the PR tab.** The session moves to the
  project root when its tree goes, and git's HEAD there is whatever that shared
  checkout is on — usually `main` — so the tab looked the PR up by the wrong
  branch, got nothing back, and hid itself. Sessions settled before this
  release get their tab back on startup.
- **A merge state GitHub hadn't worked out yet read as ready.** It put a merge
  button under a pull request that couldn't take one, and would now have
  sounded a notification for it too.

## 0.5.2 · 2026-08-25

### New

- **The sidebar says which work has landed.** A merged PR now marks its row
  alongside open and draft, so the question the list gets scanned for at the
  end of a day — what can I settle — no longer means opening every session in
  turn. A branch whose first PR merged and whose follow-up is open still reads
  as live work.
- **CI on the row, in the two places it matters.** A running check takes the
  timestamp's slot behind the working orb; a failing one turns the PR's own
  glyph red, because a broken build is a fact about that pull request rather
  than another thing on the row. Passing draws nothing at all — marking every
  green branch green a second time makes the mark that does need reading
  harder to find.
- **⌘R refreshes whichever panel tab you're reading**, the same action as the
  button in the tab row.

### Improved

- **The PR tab keeps its place whatever state the PR is in.** Merging one sent
  it to the end of the row, reshuffling the tabs under the cursor at the moment
  you were looking at what you'd just done. The pane opening itself on a new PR
  now selects that tab too, instead of landing on Changes.
- **The PR buttons stay hidden on a branch holding nothing new.** Level with
  its base and a clean tree means the button opens a pull request with no diff
  in it.
- **Red is for failures worth acting on.** A group header no longer reds
  because one call inside it failed — the failing row says so itself once
  expanded. Across ten sessions of logs, 38 of 45 failed `Bash` calls were the
  agent probing and missing: a guessed path, a glob, a binary check. Red on
  every one made red the transcript's resting state.
- **The worktree card shows itself deleting.** Unlocking, removing and deleting
  the branch run for seconds, and a dead button through all of it read as a
  click that missed.

### Fixed

- **The PR tab looked up the wrong branch and hid itself.** It rebuilt the name
  from a guess made when the session was created, so a `git checkout` inside a
  worktree left it asking GitHub about a branch holding no PR — an empty
  answer, a hidden tab, and nothing said. It reads the branch git reports now.
- **Deleting a worktree took the PR tab with it.** The session's branch was
  cleared alongside the tree, dropping the only record of where its pull
  request lives — exactly when the reader was settling the work.
- **A second edit to the same file could crash the diff.** Highlighted lines
  were cached under the file's name alone, so a longer diff reused the first
  one's and walked off the end mid-render.

## 0.5.1 · 2026-08-24

### New

- **A row of end-of-turn actions, parked behind the composer.** Hover the strip
  above it and Commit, Commit & push, Push and Create PR slide clear. All but
  push send a short prompt rather than running git themselves, so the agent
  writes the message with the context it just worked in and anything that goes
  wrong lands in the transcript like any other tool failure. Push runs
  directly — it has one correct implementation and nothing to decide. Which
  buttons exist follows the tree: dirty gets Commit, clean-and-ahead gets Push
  with a count, and PR buttons stay hidden on the default branch or where the
  branch already has one.
- **Sidebar rows mark a branch that has somewhere to land.** Open PRs are
  emerald, drafts carry the draft glyph, and the whole list costs one `gh` call
  per repository rather than one per row.
- **A screenshot the agent takes is one you can see.** A `Read` of an image
  answers in an image block and no text, so the row used to name a picture and
  show nothing. It now draws it uncropped at reading size, opens into the
  lightbox, and leaves its tool group — "Read 3 files" says nothing useful
  about three screenshots.
- **⌘↓ scrolls the transcript to the bottom.**

### Improved

- **A PR now appears the moment the turn that opened it ends.** The panel used
  to poll only while the PR tab was visible, and that tab hides when there is
  no PR — so the one state that needed a recheck could never recover on its
  own, and a PR stayed invisible until you switched sessions and came back.
- **The delete-worktree dialog stays open while git works.** Unlocking,
  removing and deleting the branch take seconds on a large tree, and a dialog
  that closed on the click left the app looking idle.

### Fixed

- **Links in the transcript opened nothing.** The link-safety modal confirmed
  through `window.open`, which a Tauri webview ignores without a word — Copy
  link worked, Open did not.
- **A session that read images carried them twice.** The CLI repeats the bytes
  on a sidecar field that was being persisted verbatim: 12MB of base64 in one
  14MB log, read whole on every open, drawing nothing.
- **A default branch with a slash in it broke the handoff row.** `release/current`
  was cut to `current`, which matches no branch, so the row read the default
  branch as a feature branch and offered a PR against the branch already
  checked out.

## 0.5.0 · 2026-08-23

### New

- **A session's worktree can be deleted, and the chat survives it.** Nothing
  else cleans these up — the CLI never sweeps a tree it made with
  `--worktree` — so every one Dray spawned sat there after the work landed.
  Settling a task now offers removal on a card that expires into keeping it,
  the settled bar carries a button for later, and deleting a session takes its
  worktree with it. The transcript, the log and the session itself stay; only
  the directory goes.
- **The dialog counts what would be lost first** — commits no other branch or
  remote holds, and uncommitted files — so a tree with work still in it says
  so before you answer. A tree another session is working in right now is
  refused outright.
- **A commit's own message, above its diff.** The history row holds the subject
  alone, so a commit whose reasoning is in its body read as a bare headline.
  Clamped to two lines, with "Show more" only where two genuinely don't hold
  it.

### Improved

- **⇧⇥ cycles effort now, not permission mode.** Permission gets set once and
  left; effort is the dial you reach for mid-work, so it takes the cheapest
  chord. `low` stays out of the cycle and pickable from the menu — a blind
  chord shouldn't make the model worse at the job. The toolbar is reordered to
  match: model first, permission last.
- **The sidebar's pin action and search are parked.** Neither was wired to
  anything you could use, so neither is drawn.

## 0.4.0 · 2026-08-22

### New

- **The main column has tabs now, and Chat is one of them.** Beside it sits
  **Changes** — a read-only view of the session's whole repository: the files
  you have uncommitted against HEAD, the branch's history, and the selected
  file's diff in its own pane. ⌘1 and ⌘2 switch between them, and the
  transcript is hidden rather than torn down, so scroll position and every
  diff you had open survive the flip.
- **Split or unified diffs**, toggled in the pane and remembered. Split is the
  default — it's what you get in every other git client.
- **A face on every commit**, resolved from the author's email.

### Improved

- **The right pane's Changes tab still answers the older question** — what did
  *this turn* do. The new view follows the branch instead. Two surfaces, not a
  duplicate.

### Fixed

- **A review that left only file comments showed nothing.** Inline comments
  live in their own list and the review holding them comes back with an empty
  body, so the panel dropped the envelope and the whole conversation with it.
  A review row now opens onto its file comments, and each of those onto its
  replies.
- **One long file path in a bot's table pushed every other column off the
  pane.** Table cells wrap anywhere now.
- **A fresh `git init` with nothing committed** said it wasn't a repository and
  hid its files. It now reads as what it is: every file an addition.

### Note

The repo view reads and never writes. Committing and pushing stay with the
conversation next door, which is where the work is being made.

## 0.3.0 · 2026-08-22

### New

- **A PR tab in the right pane**, beside Changes and Subagents. It shows merge
  readiness, the checks on the tip commit, and the review and bot comments as
  one timeline. When a session's branch has an open PR the tab leads the row
  and the panel toggle turns green — at that point the work is about landing,
  not about the last turn.
- **Merging, from the app.** The button names the method — merge, squash or
  rebase — in its own menu, and arms a confirm before it does anything. A draft
  can be marked ready and a closed PR reopened.
- **A dock badge for what's waiting**, counting the same rows the sidebar rail
  marks: turns you haven't read, and sessions blocked on an answer.

### Fixed

- **Desktop notifications were silent.** They fire only when you're in another
  app, which is exactly where the in-app sound can't reach you. A question now
  sounds different from a finished turn.

### Note

The PR tab runs on the `gh` CLI, so it uses the login and enterprise host you
already have. Without `gh`, or on a checkout with no GitHub remote, the tab
stays hidden; logged out, it says so rather than erroring.

## 0.2.0 · 2026-08-21

### New

- **A session tells you when it wants you.** A turn finishing, a permission
  request and a question each announce themselves once, on the channel that
  suits where you are: a desktop notification when Dray isn't focused, a card
  in the corner when it is focused but that session is off screen, and nothing
  at all when you're already looking at the transcript. Clicking the desktop
  notification opens the session it came from.
- **⌘G opens the oldest card** without reaching for it. The card names what is
  wanted — "Needs permission", "Task finished" — and leaves on its own.
- **The sidebar marks both states, in two colours.** Green means a turn
  finished and you haven't read it, and clears when you look. Yellow means the
  session is waiting on an answer, and only answering clears it.
- **A sound when a session settles**, alongside the card.

### Note

macOS asks for notification permission the first time Dray posts one. Deny it
and the in-app card and the sidebar marks still work — the desktop banner is
the only thing lost.

## 0.1.2 · 2026-08-15

### New

- **The window is glass.** The desktop shows through the transcript, while
  cards, menus and the composer keep their own fill — so the wallpaper reads as
  the room the app sits in rather than a wash over the text. Fullscreen drops
  it, since there's nothing behind a fullscreen window to show through.
- **A scroll-to-bottom button.** Scrolling up unpins the transcript for good,
  so a session that kept growing left no way back to the live end but a drag.

### Fixed

- **The titlebar drags the window again.** Every drag was being rejected before
  it started, and the parts of the bar carrying a label — session title, project
  name, branch — were dead to the pointer even once it wasn't.
- **Long paths in the file and command pickers no longer spill past the row.**
  They ellipsize.
- **The send hint hides while a picker is open.** It sat behind the list, and it
  was untrue there anyway: Enter completes the highlighted row.

### Improved

- **Stepping between sessions is ⌘⇧↑/↓**, was ⌘⌥↑/↓.
- **Shift+Tab is stated on the permission button's tooltip**, rather than only
  inside the menu it opens — where the modes already are.

## 0.1.1 · 2026-08-14

### New

- **Check for Updates… in the app menu.** Answers either way: "Up to date" or
  "Couldn't check", rather than going quiet the way the background check does.
  A check nobody asked for stays silent; one you asked for doesn't.
- **Stop now stops background tasks.** Stopping a turn left backgrounded tasks
  running, so the session sat busy until they drained on their own. Stop now
  interrupts the turn and stops each outstanding task.
- **You can send while a background task runs.** A prompt typed with a task
  outstanding was queued behind a turn boundary that a background shell never
  produces, so it sat there. It sends now.
- **Confetti when a session settles**, on the same beat as the sound.

### Fixed

- **Esc no longer leaves fullscreen.** With the composer unfocused, Esc fell
  through to the webview, which macOS reads as "leave fullscreen" — so the
  window resized instead of the key cancelling anything.
- **The blocked-install reason moved into a tooltip.** It sat under the button
  as a standing line of prose, which read as a permanent second row.

## 0.1.0 · 2026-08-14

First stable release.

### New

- In-app updates on a stable and a beta channel, with the app checking on launch
  and every six hours and installing on request.
- Quitting asks first, so a turn in flight isn't killed by a stray ⌘Q.
