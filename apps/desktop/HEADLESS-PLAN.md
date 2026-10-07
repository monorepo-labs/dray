# Stage 6: the browser on a remote server

monorepo-labs/dray#430. An agent on a VPS gets `dray browser`, driving a
headless Chromium on that VPS. The reader's own browsing stays on the Mac, and
the two are not connected: screenshots and recordings reach the reader through
the transcript alone.

## What changes for the reader

- **Agent side.** Same `dray browser` grammar, same `HELPERS_JS`, same skill
  text. A remote screenshot or recording is a path in the reply, which already
  opens (Files view, `read_file`) or plays inline (`VideoPlayer` through
  `drayserver://` and `/file`).
- **Reader side.** A remote session's Browser tab is the Mac's own browser,
  exactly as for a local session. The one change is its server list: for a
  remote session it lists the dev servers running *on that server*, and a click
  forwards the port over the session's SSH login and opens
  `http://localhost:<local port>` in the Mac's browser. No screenshot of the
  agent's page, no Refresh, no live view.

## Which Chromium: Chrome for Testing's `chrome-headless-shell`

Measured, not assumed:

| | linux64 | linux-arm64 |
|---|---|---|
| published for 155.0.8059.39 | yes | yes (CfT added arm64 Linux) |
| zip | 124,203,329 B | 124,553,121 B |
| launch over the pipe (OrbStack) | 0.59s (Rosetta) | 0.05s |
| real VPS, Ubuntu 26.04 x86_64 | 0.09s | — |
| `Page.startScreencast`, page changing every 50ms | 61 frames / 3s | 61 frames / 3s |
| `Page.captureScreenshot` loop | 61 / 3s | 63 / 3s |
| JPEG sampling | 4:2:0 | 4:2:0 |

- **Why this one.** It is a standalone binary that speaks CDP, so the server
  spawns it and talks to it — no host executable, no bindings, no CMake in the
  serve build. Pinned by version, and the sha256 below is of the zip as
  downloaded, checked by hand (Google publishes md5/crc32c only).
- **CEF's Linux minimal tarball was the alternative** (same CDN as the Mac, one
  version for both). It ships `libcef.so` and no executable, so it needs a host
  binary running CEF off-screen with its own message loop, plus the `cef` crate
  and its CMake build in `dray-serve`. Same system libraries on top. Far more
  code for no gain the agent can see.
- **Playwright's builds** were the fallback for arm64. Not needed now that CfT
  publishes it.
- **Screencast works here**, unlike this CEF build, which sends a frame only on
  scroll or resize. The recorder keeps polling `captureScreenshot` anyway: it
  measures the same rate and it is the code the Mac already runs.

**System libraries.** A fresh Ubuntu lacks 12 shared libraries the binary links
(`ldd` names them: nss, nspr, atk, atk-bridge, atspi, Xcomposite, Xdamage,
Xfixes, Xrandr, gbm, xkbcommon, asound), and with no fontconfig config it
aborts on the first page (`SkFontMgr_FontConfigInterface: Not implemented`).
So the list is those libraries plus `fontconfig fonts-liberation
fonts-dejavu-core`. CJK and emoji draw as boxes without more fonts; not
installed by default (`fonts-noto-cjk` is ~90MB). Ubuntu 24.04+ renames four of
them with a `t64` suffix, so the installer takes the first name in each pair
that apt has a candidate for. Checked on noble (arm64, x86_64) and resolute
(the VPS).

**The sandbox does not start on a typical VPS.** Measured on the real one: as
root Chromium refuses to run without `--no-sandbox`; as a non-root user Ubuntu
23.10+'s AppArmor `apparmor_restrict_unprivileged_userns=1` leaves it "No usable
sandbox". On OrbStack as non-root it runs sandboxed. So: root gets
`--no-sandbox` up front; anyone else is tried sandboxed first and relaunched
without it on that exact failure, remembered for the process. The cost, stated:
a renderer exploit runs as the server's user — the same rights the agent's own
shell already holds. The cure that keeps the sandbox is an AppArmor profile
granting `userns` to the binary, which needs root and a fixed path; not here.

## The seam

`automation.rs` (the verbs, `HELPERS_JS`, the recorder clock, the capture lock)
moves from `cef/` to `browser/automation.rs` and stops naming CEF. Each backend
includes it as `automation` with `#[path]`, and the backend module *is* the
seam: `automation.rs` reads a short list of functions from `super`.

```text
tabs     tabs_of  active_id  session_of  tab_state  touch  awake
actions  open_url  nav  close_tab  activate_tab  set_zoom
cdp      send_cdp(tab, id, message)   →  automation::answer(tab, id, reply)
screen   reveal_for_input  relayout  cover  uncover  emit  browser_dir
```

- **Mac (`cef/cef.rs`)** answers each from what it does today; the DevTools
  observer, the shutter (`SHUTTER_*`, `await_shutter`, `browser_snapshot`),
  `reveal`, `apply_layout` and `on_main` move into it or stay there. Nothing it
  does changes.
- **Headless (`headless.rs`)** answers the same names; the screen row is
  no-ops (`cover` mints a number and returns, nothing is emitted).
- `cfg`: headless is `all(feature = "serve", not(feature = "cef"))`, any unix.
  That is what the required `cargo check --no-default-features --features
  serve` compiles on the Mac, so the headless half is type-checked where
  everyone builds; and a Mac `dray-serve` gets a browser too, which is how it
  is tried locally. Downloads are pinned for linux64, linux-arm64, mac-arm64
  and mac-x64.

**What stays Mac-only, behind `cef`:** the `NSView`, occlusion, the shutter and
its still, `reveal`, the pump, popups as native views, the element picker,
DevTools windows, focus refusal. None of it is reachable from headless.

**No events leave a headless server's browser.** `browser_tabs` from a server
would reach the Mac's frontend keyed by the remote session's id, which is the
key the Mac's own tabs for that session use — the server's list would replace
the reader's strip. So headless `emit` does nothing.

## The headless backend

- **One process per session that uses the browser**, `--user-data-dir
  <home>/browser/<session>`: the Mac's per-session profile, persisted, and
  killed with the session. Launched on the first verb that needs a tab.
- **`--remote-debugging-pipe`, not a port.** A debugging port on localhost is
  open to every account on the machine, and a VPS is often shared; DevTools
  reads files, cookies and drives the page. The pipe is fd 3 in, fd 4 out,
  NUL-delimited JSON, set up with `dup2` in `pre_exec`. Flattened sessions
  (`Target.attachToTarget {flatten: true}`), so one pipe carries every tab.
- **Tab state from CDP events**: `Target.targetInfoChanged` (url, title —
  except that it lands as the navigation commits, before the page has a
  `<title>`, and nothing announces one later, so `Page.loadEventFired` asks
  `Target.getTargetInfo` once more; measured, every title read as the URL
  without it), `Page.frameStartedLoading`/`frameStoppedLoading` on the main frame (loading,
  which `wait_loaded` reads), `Runtime.consoleAPICalled` and
  `Runtime.exceptionThrown` (the console buffer), `Target.targetCreated` with an
  opener (a popup becomes a tab), `Target.targetDestroyed`. A JavaScript dialog
  is accepted and logged, since an open one blocks every `Runtime.evaluate`.
- **Default window 1440×900**, the Mac's `DEFAULT_VIEWPORT`, so `snapshot` and
  `click` see the laptop layout a screenshot shows.
- **Discard**: a session's browser unused for 30 minutes is killed and its tabs
  kept with url and title; the next verb on one relaunches and reopens it under
  the same id. Not while recording or driven. The Mac's reason, worse on a
  small VPS.
- **Zoom** is CSS `zoom` on the document. ponytail: resets on navigation, unlike
  the Mac's per-host level; CDP exposes no browser zoom.
- **Before launching**, `ldd` on the binary and a look for
  `/etc/fonts/fonts.conf`. Missing either answers one sentence naming the
  libraries and `dray setup`, rather than a crash in Chromium's words.

## The download

`chromium.rs`'s reading, under `<home>/chromium/` (`DRAY_HOME`-aware): zip to
`.part` through `download::download_verified` (size and sha256), unpacked by
the `zip` crate — already in the lockfile under the updater, and needed since a
fresh Ubuntu has no `unzip` — into `<version>.part/`, renamed into place, older
versions swept. Started by the first `dray browser` call that needs Chromium;
that call answers "Chromium is still downloading (n%)", as later ones do until
it lands. Backoff and retry as on the Mac. No UI: the status lives in the
server's memory and reaches only the agent.

`dray setup` gains two pick-list rows on Linux, apt only, installed the way
`git` is (root runs it, passwordless sudo runs it, anyone else is handed the
command): **Browser for agents** (the libraries above) and **ffmpeg**. The
libraries row reads as installed where `ldconfig -p` names every one and
`/etc/fonts/fonts.conf` exists, and resolves each package with `apt-cache show`,
`t64` name first: on noble and later the old name is virtual, which `apt-get
install` refuses.
Chromium itself is not fetched by setup — the CLI links nothing, and the server
fetches it on first use.

## Screenshots and recordings

- Screenshots: unchanged. The default directory is `<home>/browser/shots`, and
  `/file` serves it beside attachments and recordings.
- Recording: the same frame clock and the same Photo-JPEG `.mov` muxer, then
  `ffmpeg -c:v libx264 -pix_fmt yuv420p -movflags +faststart` where the Mac
  runs `avconvert`. A server with no `ffmpeg` refuses `record start` in one
  sentence naming `dray setup`. A Mac `dray-serve` keeps `avconvert`.

## Forwarding ports

- **The list.** `list_local_servers` already routes to the session's server
  and is in `serve.rs`'s table. Its `lsof` is not on a fresh Ubuntu, nor `ss`,
  so on Linux listeners are read from `/proc/net/tcp{,6}` (state `0A`), mapped
  to a pid through `/proc/<pid>/fd` socket inodes, named from `/proc/<pid>/comm`
  and placed by `/proc/<pid>/cwd`. Same two signals, same answer shape.
- **The forward.** `forward_port(server, port)` in `servers.rs` runs a second
  login, `ssh -N -o BatchMode=yes -o ExitOnForwardFailure=yes -L
  127.0.0.1:<free>:localhost:<port>`, and answers once the local port accepts.
  `localhost` on the far end, so a dev server bound to `::1` only is reached.
  SSH-PLAN.md set up no control socket, and adding one to the main login is a
  bigger change than a second login.
- **Lifecycle.** Held on the server's connection, keyed by remote port: reused
  by every session on that server, dropped when the connection drops, the
  server is turned off or removed. A dead forward is replaced on the next click.
- **A server added by address** has no login to forward over; a click there
  answers that in a sentence, in the pane's error slot.
- A port that stopped listening between the list and the click still
  forwards — ssh connects per connection — so the page shows Chromium's own
  refusal. The list polls every 5s, so that window is short.
- **Frontend.** The Browser tab is drawn for remote sessions. The list heading
  names the server ("Running on vps"), and a row's click asks `forward_port`
  (local) and opens the answer with `openInBrowser`, whose error slot reports a
  failed forward.

Known gaps: the Mac's tabs for a remote session are not closed when that
session is deleted on its server. A transcript link in a remote session still
leaves the app, as today.

## Stages

Each leaves the Mac browser exactly as it is.

1. **Seam.** Move `automation.rs`, the backend functions into `cef.rs`.
   `cargo check --features cef` (with `CEF_PATH`), bare `cargo test`.
2. **Headless + download + recording + `/file` + setup rows.** Proven by a
   script against `dray-serve` in OrbStack Ubuntu, x86_64 and arm64: open,
   snapshot, click, type, screenshot, record, discard and wake, the
   downloading sentence, the missing-libraries sentence.
3. **Forwards + `/proc` listing + the remote Browser tab.** Proven against the
   VPS with a dev server running there.

What ran (2026-10-07): the e2e script passes on OrbStack Ubuntu arm64 and
x86_64 and on the VPS (Ubuntu 26.04 x86_64, as root, so without the sandbox) —
the downloading sentence, every verb, popup and dialog, `set device`, full-page
screenshot, recording to a 750×1334 H.264 MP4 where ffmpeg is installed and
the refusal where it is not. A killed Chromium comes back on the next verb with
its tabs. A bare Ubuntu answers the missing-libraries sentence, and `dray setup
--install browser,ffmpeg` cures it. `ssh::forward` against the VPS fetched a
page through the forwarded port (`forwards_a_real_dev_server`, ignored by
default); `finds_its_own_listener` runs the real `/proc` read on Linux. The
Browser tab's click on a remote row was type-checked, not clicked by hand.
