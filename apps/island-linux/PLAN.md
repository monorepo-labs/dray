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
  or dock reserving an edge is never covered.
- **Prefs are `island.json` under the XDG config dir**, the stand-in for the
  Mac's `defaults` domain: the app writes `key`, the island writes
  `placement`, each keeping the other's field. Read at every tap.
- **A client of This computer's `dray --serve`**, address and token from
  `serve-port` / `serve-token` in the `DRAY_HOME` the app hands over, read
  at every connect. Hello carries `client: "island"`. Lenient decoding: a
  renamed field costs that field.

## Stages

Each its own PR.

1. **Spike** (this): panel window, placement, modifier tap, connected to the
   server, pinned to the newest session.
2. Waiting-card pill and answering cards.
3. Reply, new task, the session switcher, typed rows.
4. Dictation rows, over `host_call` to the app as on the Mac.
5. Screenshots and drawing on the live screen.

## Known limits

- **X11 only.** Native Wayland is #839: a global key watch and screenshots go
  through portals there, and GNOME has no layer-shell. The app forces X11 too.
- **Square, opaque edges.** Rounded, see-through corners need a compositor.
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
