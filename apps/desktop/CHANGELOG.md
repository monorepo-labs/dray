# Changelog

What each release changed, newest first, in terms of what you'd notice using it.
The release job reads the matching section into the GitHub release notes and the
updater carries it, so this file is what a release says about itself — not a
second description of it. GitHub's generated commit list is appended below it.

## 0.12.0

### Added

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

## 0.11.0

### Added

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

## 0.10.1

### Added

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

## 0.10.0

### Added

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

## 0.9.3

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

## 0.9.2

### Added

- **Light mode works for the Default theme.** It was the last theme with no
  light side, so the mode picker sat disabled for anyone who never changed
  palette. System, Light and Dark all apply now.
- **A logged-out agent offers a way back in.** An expired login ended every
  turn with the harness's own sentence and nothing to do about it — `/login`
  cannot be reached from inside a session. The composer now names the cure and
  a button opens the login in a terminal. A wording neither harness recognises
  still reports the failure as before.

### Changed

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

## 0.9.1

### Added

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

## 0.9.0

### Added

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

### Changed

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

## 0.8.2

### Added

- **A Skill call reads as one.** The harness types it like any other tool and
  leaves the title empty, so the row said "Skill" over raw JSON and a result
  that only repeated the name. It now carries the skill's name in the header
  and its brief as prose, and the name shows as soon as it lands.
- **A retrying turn says so.** The API retries up to ten times behind a turn
  that otherwise just looked slow. The attempt count leads, and the cause is
  named where the wire carries one.

### Changed

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

## 0.8.1

### Added

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

## 0.8.0

### Added

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

## 0.7.3

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

## 0.7.2

### Added

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

## 0.7.1

### Changed

- **The sidebar groups sessions by project.** All Projects used to interleave
  rows from every repo with nothing saying which one a row belonged to. Rows
  now gather under a muted project name, taken from the sessions actually
  present — so an idle project draws no heading at all. A spawned session stays
  under its parent whatever its own project says, and ⌘⇧↑/↓ still walks the
  order you see.

## 0.7.0

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

### Added

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

### Changed

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

## 0.6.0

### Added

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

## 0.5.3

### Added

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

## 0.5.2

### Added

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

### Changed

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

## 0.5.1

### Added

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

### Changed

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

## 0.5.0

### Added

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

### Changed

- **⇧⇥ cycles effort now, not permission mode.** Permission gets set once and
  left; effort is the dial you reach for mid-work, so it takes the cheapest
  chord. `low` stays out of the cycle and pickable from the menu — a blind
  chord shouldn't make the model worse at the job. The toolbar is reordered to
  match: model first, permission last.
- **The sidebar's pin action and search are parked.** Neither was wired to
  anything you could use, so neither is drawn.

## 0.4.0

### Added

- **The main column has tabs now, and Chat is one of them.** Beside it sits
  **Changes** — a read-only view of the session's whole repository: the files
  you have uncommitted against HEAD, the branch's history, and the selected
  file's diff in its own pane. ⌘1 and ⌘2 switch between them, and the
  transcript is hidden rather than torn down, so scroll position and every
  diff you had open survive the flip.
- **Split or unified diffs**, toggled in the pane and remembered. Split is the
  default — it's what you get in every other git client.
- **A face on every commit**, resolved from the author's email.

### Changed

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

## 0.3.0

### Added

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

## 0.2.0

### Added

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

## 0.1.2

### Added

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

### Changed

- **Stepping between sessions is ⌘⇧↑/↓**, was ⌘⌥↑/↓.
- **Shift+Tab is stated on the permission button's tooltip**, rather than only
  inside the menu it opens — where the modes already are.

## 0.1.1

### Added

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

## 0.1.0

First stable release.

- In-app updates on a stable and a beta channel, with the app checking on launch
  and every six hours and installing on request.
- Quitting asks first, so a turn in flight isn't killed by a stray ⌘Q.
