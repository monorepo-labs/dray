# Dray Island on Linux and Windows

The Mac island's behaviour, rewritten in Rust with GPUI for the panel (#833).
[apps/island/PLAN.md](../island/PLAN.md) is the spec for what it does; this
one matches its behaviour, not its code. Nothing from the React app or the
Swift island carries over. The crate keeps its name; Windows is the same
binary with `win.rs` where Linux has `x11.rs` (see [Windows](#windows)).

## Decided

- **GPUI draws the panel, from one pinned Zed commit.** The crates.io release
  (0.2.2) is a 2025 snapshot that no longer builds (a pinned `xattr` against
  today's `libc`) and still draws through blade. Zed's own tree builds on our
  stable Rust and draws through wgpu. Bump the `rev` in `Cargo.toml` on
  purpose; GPUI is pre-1.0 and moves. Apache-2.0.
- **Its own crate and binary, `dray-island`.** GPUI runs its own event loop and
  windows, so it cannot be a window of the Tauri app, and its tree (wgpu,
  zbus, cosmic-text) stays out of the app's build. First build clones Zed's
  repo (~400 MB); a release build from cold is about 2 min on 8 cores, and the
  stripped binary 28 MB.
- **The app's child, and it dies with the app.** `configure_island` (every
  launch, `island.rs` in the app) starts it with `--child` and a pipe on its
  stdin; the island quits at EOF, which the kernel delivers however the app
  goes. Not in the AppImage yet: the app looks beside its own binary, and a dev
  build in this crate's `target/`.
- **Starts on a machine with no GPU.** Measured on a VM with Mesa's llvmpipe
  alone (software Vulkan 1.4): the panel opens and draws. libEGL warns about
  DRI3 on the way up, which is wgpu probing GL, and is harmless.
- **Summoned by tapping one modifier alone**: Control unless the app says Alt
  or Super (the Mac's Option and Command, same stored names). Raw XI2 key
  events on the root window, as #710's click watch reads them: they reach the
  island whoever has focus and grab nothing. A key or click between down and
  up, or a hold past 0.4s, is no tap. A tap opens, and a tap on an open panel
  closes it until dictation (stage 4) takes that tap over, as on the Mac.
  Esc closes it too.
- **An override-redirect window** (GPUI's `PopUp` kind): the window manager
  neither frames, moves nor focuses it, and it sits over managed windows. The
  island takes the keyboard itself on open (`XSetInputFocus`) and hands it
  back on close, since `_NET_ACTIVE_WINDOW` is ignored for such a window.
- **Placement is the reader's pick**, from the panel's right-click menu: top or
  bottom centre of the primary display, inside `_NET_WORKAREA` so a panel bar
  or dock reserving an edge is never covered. At the top it hangs flush from
  the bar, as the Mac's hangs from the notch. The window is sized to what it
  draws (`fit`, an X configure GPUI reads back), growing upward at the bottom.
- **It looks like the Mac island where a compositor runs**: the black card
  with its hairline edge and shadow, the notch shape's flared ears at the top
  and 20pt corners at the bottom, the stack's peeks under it, the Mac's 13/12/11
  type and row fills, a capsule or notch-shaped pill. A window's clear pixels
  are only clear under a compositor (EWMH's `_NET_WM_CM_S<n>` owner, read at
  each open), so without one it draws square and opaque instead. GPUI's blur
  reaches about twice its radius, so the shadow's is 5 where the Mac's is 12,
  or the window edge cuts it off square.
- **Waiting cards come from every session**: `live_state`'s asks on each
  connect, then `permission_requested`, `questions_asked`,
  `permission_decided` and `background_tasks_changed`. The Mac's rules hold:
  oldest ask first, a turn that ends with no task running strands its asks,
  Dismiss and Dismiss all put cards away until a new ask brings them all back,
  and the last answer flashes its word (the card red on a denial) and closes
  the panel. An answer that does not land leaves the card with the server's
  sentence under it.
- **The pill opens the cards on a 150ms hover**, as on the Mac, and takes the
  keyboard then, so digits and Enter answer at once. It is never focused
  itself. News lights its edge for 2s and chimes, unless Dray's window is in
  front (`_NET_ACTIVE_WINDOW`'s `WM_CLASS` is `dray`), which sounds its own.
- **The chime is the app's `notification.wav`**, the one the Mac island plays,
  handed to `pw-play`, `paplay` or `aplay`, whichever is installed, so the
  island links no audio library.
- **Free text is a GPUI text box of our own** (`input.rs`): GPUI ships none, so
  it is GPUI's `examples/input.rs` cut down. Typing goes through GPUI's input
  handler and XIM, as any GPUI app's does.
- **The draft is the Mac's**: typed rows and the box make one message,
  joined in order; Ctrl+⏎ queues the box as a row, ⏎ sends, a row is edited
  in place or removed. Sent is said at once and the request runs behind it; a
  send that fails comes back as the draft, ahead of anything typed since, with
  the reason. A call unanswered for 30s fails rather than holding the send.
  A reply reads the session fresh (`get_session_by_id`) and sends with its own
  settings, as the phone does; a new task sends the bar's picks.
- **Where the draft goes**: the session Dray's window has open, asked of the
  app (`selected_session`) before the panel shows, at most half a second; else
  the session last used (`lastSession` in prefs); else the newest; else a new
  task. Ctrl+N is a new task.
- **The switcher**: the title, ↑/↓ from an empty box, or Ctrl+F opens it as a
  second card on the far side from the edge. Newest first, the sidebar's
  rule for what is left out (hidden, settled, set aside, three days still),
  searched by title and project; ⏎ or a click picks.
- **A new task's bar**: agent and model with the hovered model's efforts
  flying out, project, worktree, stance — the desktop composer's rules
  restated in `newtask.rs` (default model per agent, usable model and effort,
  stances each agent honours). The picks persist in prefs as the Mac's do; a
  project pick is stamped on the server as Dray's own.
- **The text box wraps**, growing to 6 lines and scrolling to the caret past
  that, as the Mac's field does. GPUI's wrapped layout does the shaping.
- **Dictation is Dray's own**, through the server to the app (`host_call`),
  as on the Mac: one place sets up model, microphone and mute. A tap on the
  open panel starts or stops it, a double tap opens the panel listening, ⏎
  while recording stops and sends once the words land, Esc mid-sentence does
  nothing and Ctrl+Esc throws the recording away and closes, the Mac's ⌘Esc.
  Words become a said row; a failed run keeps its recording for Retry. The
  start and stop tones are Dray's.
- **The orb is the Mac's `prism` shader, ported line for line** (`orb.rs`) and
  run on the CPU a frame at a time into an image GPUI draws: the orb is at most
  80pt and this machine class may have no GPU. `OrbDriver`'s easing and
  `OrbClock` come with it. Checked against the Mac's own renders
  (`orb-reference` branch): every still and all 748 frames of its speech run
  within a tenth of an 8-bit step on average, and the motion follows its
  per-frame inputs (`fixtures/orb-uniforms.csv`, a test). `--orb-png` and
  `--orb-csv` write frames for that comparison.
- **Both Mac layouts**, the reader's pick in the right-click menu: expanded
  (the default) puts the orb in a 48pt slot above the box and grows it to
  80pt alone over the screen while recording, the card gone bare; compact puts
  a 24pt orb in the box's row and shrinks the card to orb and clock. Expanded's
  80pt orb is the Mac's `LensOrb` without its screen capture, which is the
  prism orb exactly; see Known limits.
- **Screenshots freeze the screen first.** The camera or Super+Shift+2 (the
  Mac's ⌘⇧2) hides our windows, reads the root window, and draws that still
  under a dimmed overlay: drag a region, draw on it, Enter or Done. Enter with
  no region takes the whole screen. The Mac's drag rules, Ctrl+Z, Delete on a
  picked mark. A still works with or without a compositor; a clear overlay
  would only work with one. With the panel shut the shot flies to the pill and
  waits in the draft, as on the Mac.
- **While dictating, the words so far are cut ahead of the shot**
  (`cut_transcription`) with the microphone left open, and its place in the
  draft is held from the press, so speech lands around it.
- **Drawing while dictating is Shift alone held.** With a compositor a clear
  overlay takes the mouse only while Shift is down, so the page underneath
  still works; 1.5s after the last stroke the marks' area, padded 160px, is
  read with our windows unmapped and inked on the CPU. Without one, Shift
  freezes the screen to draw on. "Hold Shift to draw" shows beside the clock
  for the first five recordings.
- **Our windows are unmapped for every screen read**, since a composited root
  includes them. The window that held the keyboard takes it back after, or ⏎
  lands in the app underneath.
- **Files are PNG, else JPEG at falling quality under 5MB**, in
  `$TMPDIR/dray-island-<uid>`, swept after seven days. They ride `send_msg`'s
  `attachmentPaths`, named `[Image N]` or `[file name]` in the prompt where
  they sat in the draft. Files dropped on the panel are rows too.
- **The app hands asks and finished sessions to the island** while its child
  lives (`island::running`), for this computer's sessions alone: another
  machine's keeps its banner (`islandOn` checks `serverOfSession`).
- **The done pill is the Mac's**: a finished session in place of Dray's
  banner, the pill's other face when no card waits. One names itself with
  Open in app; several are a count that lists them on hover, five rows then
  scrolling. Six seconds, held while hovered and while the panel or a card
  covers it; what the panel covered is spent. Esc and Super+⏎ (the Mac's
  ⌘⏎) are grabbed only while it is up.
- **Dray talks down the pipe the island holds as stdin**: `done <session id>`,
  `waiting <json>` and `prefs`, a line each, besides the EOF that ends it.
- **Bots look as they do on the Mac** (#1283, catching up #917, #1067, #1069
  and #1279). A bot's chat — a session whose `cwd` is a bot's folder, from
  `list_bots`, read again on `bots_changed` — shows its face and name in the
  title row and the switcher, searched by name, typing dots while it works.
  The face is the Mac island's own `botface.js` (Blobatar and `botAvatar.ts`),
  read by path and run in QuickJS (`rquickjs`), its SVG drawn by GPUI. A
  bot's "N tasks waiting on you" is a `waiting` line carrying the note and the
  card's rows: the done pill says it in yellow in place of "Done", keeps it
  when the bot's own turn ends beside it, and grows into the task cards under
  the pointer — face, title, PR, need, age, a click opening the task in Dray,
  a ready PR's Merge with the method as the confirm (`merge_pr` settling the
  task). Several bots share one pill grouped under each face. One bot's
  alert puts its face in a black disc joined to the pill: out of its left end
  on a spring above the dock, dropped from its flat bottom at the top
  (`fluid.rs`); its Done pill drops the name.
- **Symbols are our own SVGs** (`icons.rs`), drawn after the Mac's SF Symbols
  and SF Pro's key glyphs: ⏎, ↑↓, send, the camera and search. As text they
  took whatever the desktop's font had, and DejaVu's sit thin and off the
  line. A hint line swaps ⏎ and ↑↓ in its text for them, so the box's prompt
  is drawn over the box while it is empty rather than as its placeholder.
- **The disc is drawn in parts.** GPUI has no path union, so pill, disc and
  waist are filled in one black over each other, and a lit edge is each
  part's outline drawn first; its halo is a blurred box per part. Without a
  compositor there is no room for a disc, so the face leads inside the pill.
  GNOME's `enable-animations` off stands in for Reduce Motion.
- **Prefs are `island.json` under the XDG config dir**, the stand-in for the
  Mac's `defaults` domain: the app writes `key`, and Settings → Island the
  placement and layout, which the island's menu writes too; each write keeps
  the other fields. Settings speaks the Mac's names (`island.placement` =
  `notch`), mapped in `island.rs`, and a write tells a running island to read
  them again and show them.
- **The AppImage carries it** at `usr/bin/dray-island`, beside the app's
  binary, where `island.rs` looks: `island-sidecar.sh` builds it and the
  `tauri.linux-release.conf.json` overlay hands it to the bundler with the CLI.
- **A client of This computer's `dray --serve`**, address and token from
  `serve-port` / `serve-token` in the `DRAY_HOME` the app hands over, read
  at every connect. Hello carries `client: "island"`. Lenient decoding: a
  renamed field costs that field.

## Stages

Each its own PR.

1. **Spike** (#851): panel window, placement, modifier tap, connected to the
   server, pinned to the newest session.
2. **Waiting-card pill and answering cards**, and the Mac look (#860).
3. **Reply, new task, the session switcher, typed rows** (#862).
4. **Dictation rows, over `host_call` to the app as on the Mac**, and the orb
   (#866).
5. **Screenshots and drawing on the live screen** (#867).
6. **Shipped**: the AppImage, Settings → Island, the done pill. What is left
   is #868.
7. **Bots, caught up with the Mac** (#1283): faces, waiting notes and cards,
   the face disc.

## Known limits

The ones the Mac doesn't share are tracked in #868.

- **X11 only on Linux.** Native Wayland is #839: a global key watch and screenshots go
  through portals there, and GNOME has no layer-shell. The app forces X11 too.
- **Square, opaque edges without a compositor**, by design: see above.
- **This computer's sessions alone.** Other machines' (`island_links`) are not
  read yet, so a new task's bar has no machine control.
- **Expanded's orb refracts nothing.** The Mac's `LensOrb` bends a live
  capture of the screen behind it, leaving out its own windows; X11 has no
  such capture without walking the window stack through Composite, so it
  draws as the Mac does without the Screen Recording grant.
- **The microphone opens 1–2s after the press**, in the app's recorder, so
  words said at once are lost; the clock stays at 0:00 until it is open.
- **Not yet from the Mac's draft**: Ctrl+S saving it as a Dray draft,
  dragging rows to reorder, the last turns of the transcript above it, and
  the bar's step-through chords (⌘⇧A and the rest).
- **A shot sees one screen.** The overlay covers GPUI's primary display, and
  the still is the whole root window.
- **Settings → Island shows the switch, key, position and layout.** The tap
  pick, the screenshot key and the transcript switch are the Mac's alone.
- **Another machine's waiting task has no Merge.** Its repo is
  `dray://<machine>/<path>`, which this computer's server cannot merge in, and
  the island reaches no other server; the card opens the task in Dray.
- **One display.** The panel opens on GPUI's primary display; the Mac's
  "the screen with the notch" has no counterpart.

## Windows

The same island, the same panel at the top centre of the primary display,
as on a Mac with no notch. Everything above holds unless said here.

- **One crate, two platform files.** `main.rs` names `sys`, which is
  `x11.rs` on Linux and `win.rs` on Windows, with the same functions; the
  tap and the pen's Shift are decided once, in `tap.rs`, off the key codes
  each hands over. GPUI draws through DirectX 11 there, and on a machine
  with no GPU through WARP, the Basic Render Driver DXGI lists last.
- **The keys come from low-level hooks** (`WH_KEYBOARD_LL`, `WH_MOUSE_LL`)
  on a thread of their own, which see every key and click whoever has
  focus, as XI2's raw events do. Unlike X11's they can swallow a key, which
  is how the screenshot key (Win+Shift+2) and the done pill's Esc and Win+⏎
  are taken from the app in front: no grab exists to do it.
- **A tapped Alt or Win is masked.** Alone, Alt wakes a window's menu bar
  and Win opens Start. The hook holds the tap's release back and sends it
  again behind an unassigned key (`0xE8`, AutoHotkey's mask key), so
  Windows reads a chord. The island's own keys carry a mark the hook
  passes by.
- **A topmost tool window** (GPUI's `PopUp` there): off the taskbar and
  Alt+Tab, over every other window. Windows hands the foreground only to
  the app that has it, so the island attaches to that app's input queue
  for the moment it takes the keyboard, and gives it back on close the
  same way.
- **DWM always composes**, so the card always has its Mac shape and shadow.
- **The screen is read with GDI** (`BitBlt` off the screen's DC), our windows
  hidden first, as on X11. The ink overlay lets the mouse through by being
  layered and transparent to clicks until Shift is held.
- **Sounds play from memory** with `PlaySound`, one at a time.
- **Reduce Motion is Windows' "Animation effects"** switch.
- **Prefs are `~/.config/dray/island.json`** on Windows too, the path both
  sides already agree on; screenshots go in `%TEMP%\dray-island`, which is
  the account's own.
- **The key picker says Win** where Linux says Super; the Mac's stored
  names are unchanged.
- **A release is a GUI binary** (`windows_subsystem`), and the app starts a
  dev one with `CREATE_NO_WINDOW`, so neither opens a console.

Not on Windows yet: a bundle carrying it (`release.yml` has no Windows job,
#1425), and dictation, which the island asks of the app and the app hides on
Windows (#1425): a tap on the open panel answers what the app does, which
on a machine with no model is a notice.

## Build

```bash
cd apps/island-linux && cargo build          # what a dev app finds
DRAY_HOME=~/.dray-dev ./target/debug/dray-island   # by hand, against a dev server
```

Needs `libxkbcommon-x11-dev` besides what the app needs. On Windows, the
MSVC toolchain the app already needs; `cargo build` there is what
`tauri dev` finds, `target\debug\dray-island.exe`.
