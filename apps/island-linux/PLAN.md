# Dray Island on Linux

The Mac island's behaviour, rewritten in Rust with GPUI for the panel (#833).
[apps/island/PLAN.md](../island/PLAN.md) is the spec for what it does; this
one matches its behaviour, not its code. Nothing from the React app or the
Swift island carries over.

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
- **The app hands asks to the island and keeps finished-session banners**:
  `islandOn("asks")` is true on Linux while the island child lives
  (`island::running`), `islandOn("done")` stays Mac-only until there is a done
  pill.
- **Prefs are `island.json` under the XDG config dir**, the stand-in for the
  Mac's `defaults` domain: the app writes `key`, the island writes
  `placement`, each keeping the other's field. Read at every tap.
- **A client of This computer's `dray --serve`**, address and token from
  `serve-port` / `serve-token` in the `DRAY_HOME` the app hands over, read
  at every connect. Hello carries `client: "island"`. Lenient decoding: a
  renamed field costs that field.

## Stages

Each its own PR.

1. **Spike** (#851): panel window, placement, modifier tap, connected to the
   server, pinned to the newest session.
2. **Waiting-card pill and answering cards**, and the Mac look (#860).
3. **Reply, new task, the session switcher, typed rows.**
4. Dictation rows, over `host_call` to the app as on the Mac.
5. Screenshots and drawing on the live screen.

## Known limits

- **X11 only.** Native Wayland is #839: a global key watch and screenshots go
  through portals there, and GNOME has no layer-shell. The app forces X11 too.
- **Square, opaque edges without a compositor**, by design: see above.
- **No done pill.** A finished session is still Dray's banner on Linux.
- **This computer's sessions alone.** Other machines' (`island_links`) are not
  read yet, so a new task's bar has no machine control.
- **Not yet from the Mac's draft**: Ctrl+S saving it as a Dray draft,
  dragging rows to reorder, the last turns of the transcript above it, and
  the bar's step-through chords (⌘⇧A and the rest).
- **Settings → Island stays hidden off a Mac** until the island has more to
  set than the key: the app hands over the default, Control.
- **One display.** The panel opens on GPUI's primary display; the Mac's
  "the screen with the notch" has no counterpart.

## Build

```bash
cd apps/island-linux && cargo build          # what a dev app finds
DRAY_HOME=~/.dray-dev ./target/debug/dray-island   # by hand, against a dev server
```

Needs `libxkbcommon-x11-dev` besides what the app needs.
