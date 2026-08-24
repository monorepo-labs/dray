# Changelog

What each release changed, newest first, in terms of what you'd notice using it.
The release job reads the matching section into the GitHub release notes and the
updater carries it, so this file is what a release says about itself — not a
second description of it. GitHub's generated commit list is appended below it.

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
