# Dray Notch

A native macOS panel, always on top, that hangs from the notch or docks to a
screen edge. Start a session, reply to one, answer its cards — by dictation
(default) or typing — without bringing Dray's window forward. Possible because
the sessions live in `dray --serve` now, not in the window.

## Decided

- **Placement is the reader's pick**, from the panel's right-click menu: hanging
  from the notch, or centred above the Dock. A notch pick on a display with
  none falls to top centre.
- **Ships inside Dray.app** at `Contents/Helpers`, built and signed by
  `build.sh` in the release job and copied in by `tauri.notch.conf.json`. On by
  default: every app launch runs `configure_notch`, which `open`s it. It
  outlives Dray, since it talks to the background server, and restarts itself
  onto a new binary once an update has swapped the bundle under it.
- **Summoned by tapping one modifier alone**, Control unless Settings →
  Shortcuts says Option, Command or Off. The pick is the notch's own
  `notch.key` default, read at every tap. A tap opens it; a tap on an open
  panel starts or stops dictating, so a double tap opens it listening. Send
  is ⏎, ⌘⏎ adds the text as a row. A bare modifier is no Carbon hot key, so it
  watches modifier changes globally, which needs no grant, and reads the
  system's key and click counters to rule out ⌃C and ⌃-click.
- **Pinned to one session, with a switcher.** Defaults to the session last used
  or the one wanting the reader. "New session" is an entry in the switcher.
- **What it draws: the input** (and, from v2, the open card). No transcript — the main
  window is one click away.
- **Everything said and done builds one message.** Each dictated line, typed
  line, screenshot, annotation or picked element is a row in a draft, in order,
  reorderable and deletable. Send turns the list into one prompt with its
  attachments.
- **Comments attach to an item** — a mark, a screenshot, an element — and ride
  the prompt beside it.
- **A screenshot is taken off the live screen**: the camera button or ⌘⇧2 lays
  a clear overlay, and letting go of a region drag is the shot (Full screen sits
  in a bar at the bottom). The region then holds that still and takes pen marks,
  which can be moved and deleted; Done adds it as a row. Mid-recording the
  words so far are cut into a row ahead of it with the microphone left open
  (`cut_transcription`), and the prompt names each image in place as `[Image 1]`.

## v1

Compose and reply. Typed and dictated rows, session switcher, new session.
Everything else below waits.

v2: status — a session's state, its last message, notch alerts (glow
yellow/green and the title when a session wants the reader), and the
permission and question cards answered from there.

Screenshots, pen marks and file drops shipped (#566).

**Drawing on the live screen is part of dictating** (#571), with no mode of
its own: while the microphone records, a clear overlay lets the mouse through,
so the page still scrolls and clicks, and holding Shift draws. Strokes made close
together are one moment: 1.5s after the pen rests, the area around them is
captured with the ink, the ink fades, and the image takes the row held for it
at the moment's first stroke, where the speech was cut. "Hold Shift to draw" shows
in the recording pill until the first stroke, for a reader's first five
dictations. Screen Recording is asked for at the first moment taken, never for
dictating alone. It may yet replace the screenshot mode.

Later, in order: comments on a mark, browser element pick.

## How it talks

- **Sessions: the background server, as the iOS app does.** It connects to
  This Mac's `dray --serve`, address and token read from `serve-port` /
  `serve-token` in the home Dray.app hands it on launch (`DRAY_HOME`), so a dev
  build's notch talks to the dev server. Shares `Wire.swift` and
  `Connection.swift` with `apps/ios` by path, not by package.
- **Dictation: Dray's own Parakeet, through the server to the app.** The
  transcription commands are the app's (`APP_COMMANDS`), so the notch sends
  them to the server and the server forwards them over `host_call` — the
  channel `dray browser` already rides — to `answer_host`. One place sets up
  dictation: model, mic, mute. A server with no app connected answers "Open
  Dray to dictate".
- **New session** reuses the iOS app's picker once it lands there.

## Stack

SwiftUI in an `NSPanel` (`.nonactivatingPanel`, `.statusBar` level, joins all
spaces), macOS 26. No dependencies. XcodeGen `project.yml`, like `apps/ios`.
Bundle id `com.yogesh.dray.notch`, `LSUIElement`.
