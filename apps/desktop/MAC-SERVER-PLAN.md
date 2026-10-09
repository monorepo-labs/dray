# The Mac's sessions live in a background server

monorepo-labs/dray#456. Until now the Mac app *was* the core: its own process
ran every agent, and quitting it stopped them. #452 let the app serve those
sessions to another Mac through a quick tunnel, but only while it was open.
This moves the core out of the app into a server that launchd keeps running
from login, through app quits and crashes. The app becomes a client of it,
reached exactly the way it reaches a VPS.

## What was decided

**A login agent runs the server.** launchd starts it at login, keeps it alive
(`KeepAlive`), and restarts it after a crash. The server owns `~/.dray`, the
orchestration socket, every agent process, and remote access (the tunnel).

**The server is Dray's own program, run without a window** (`dray --serve`),
not a second `dray-serve` in the bundle. Three reasons, in order: a second
binary is a second compile of the core in every release, on two
architectures; macOS judges file access (Documents, Desktop, Downloads) by
the program asking, so a second program would ask again for what the reader
already granted Dray, from a background process with no window to explain it;
and the server's code is the same function either way, so switching later
changes how it is started and nothing else. Yogesh was unsure and asked for
the recommendation.

**The app keeps only what needs the Mac's screen**: the Chromium browser,
dictation, notification banners, the dock badge, the updater, opening other
apps and terminals, native pickers, the pasteboard, and the list of servers
it connects to.

**`dray browser` follows the app.** While the app is open the server hands
each step to it, so the Browser tab shows what the agent does. With the app
closed the server uses the headless Chromium Linux servers use.

**The dev app gets its own server**, built from the code being changed, on
`~/.dray-dev`. It does not show the real sessions.

**An update restarts the server with the app.** Install already waits while
any turn runs; pressing it now restarts the server too. Whatever agents left
running in the background — dev servers, watchers — stops with it. If the app
ever meets a server older than itself (a restart that failed, a bundle
replaced by hand), it asks the server to restart once no turn is running.

**⌘Q asks, and offers a full stop.** "Quit Dray? Sessions keep running in
the background." Quit closes the app. **Quit and stop sessions** also stops
the server, which comes back when Dray next opens or at the next login.

**Nothing to migrate.** The server reads `~/.dray` as it stands.

## The seams

### One binary, two modes

`main.rs` reads `--serve` before Tauri is touched. With it, the process never
builds a window or an `NSApplication`: it runs `serve::run_mac`, which is
`serve::run` with two differences — it listens on a random port rather than
7317, and it serves remote access from the setting. With nothing it is the app.

`headless`, `serve` and their dependencies (`zip`, `flate2`, the WebSocket
server half) compile into the desktop build too. `dray-serve` stays as it is
for Linux, `serve` feature alone. The cfg that today reads
`all(feature = "serve", not(feature = "cef"))` for the headless browser
becomes "the server process", since one binary now carries both browsers.

**To verify on a real bundle, before building on it:** that a process running
the bundle's executable without AppKit draws no Dock icon; that opening
Dray.app while it runs launches the app rather than treating the server as
the running app; and that an agent under the server reads `~/Documents`
without a new prompt. Each is a claim about macOS, not about our code.

### Where the server listens

**The app reaches it on `127.0.0.1` at a port the server picks**, written to
`<home>/serve-port`. Not 7317: that is the Linux server's port, and a
`dray-serve` run on this Mac for testing would take it. Not a unix socket:
`servers.rs` speaks to every server through one TCP WebSocket client, and a
second stream type is a second code path for one connection.

**Remote access is a second listener**, on 7317 (7318 for dev) behind the
tunnel, exactly what `remote_access.rs` runs in the app today, moved into the
server whole. One hub feeds both.

**The token is `serve-token`, as everywhere.** The app reads it off disk.

### The app as a client

**"This Mac" is a connection in `servers.rs` with the id `local`**, never
written to `servers.json` and never listed on the Servers page. Address from
`serve-port`, token from `serve-token`, both read again on every connect,
since a restarted server may pick a new port. Its events arrive as
`server_event` from `local`, its calls go through `server_invoke`. The
reconnect loop, `live_state` and the frontend's resync are the ones remote
servers already use, so a server restart reads to the reader like a VPS
dropping for a second.

**`transport.ts` splits `local` in two.** A command the app itself answers —
the browser, dictation, banners, the updater, the server list, opening apps —
goes to Tauri; every other command goes to the local server. The list of app
commands is stated in `transport.ts` and checked by a test against
`lib.rs`'s `generate_handler!`, since a command missing from it would be sent
to a server that answers `unknown command`. Core commands come out of the
app's handler; the functions stay, since the server runs them.

**`serverConnected(LOCAL)` stays true, and a call waits instead.**
`server_invoke` on `local` waits up to 20s for the connection, since a
restart is seconds and the reader is waiting on that server and no other —
dimming every row for that would read as the sessions being gone.

### Calls from the server to the app

**The wire gains one frame each way, sent to one client only.** The app's
hello carries `host: {browser: bool}`, honoured on the local listener alone,
so a Mac connecting through the tunnel can never be handed this Mac's
browser. The server may then send `{"call":n,"cmd":…,"args":…}` and the app
answers `{"reply":n,"ok":…}` or `{"reply":n,"err":…}`. No protocol bump: a
client that never says `host` never receives one. Two commands: `request`,
carrying a `dray_proto::Request` whole and answered with a `Response`, so the
CLI's own types cross unchanged; and `close_session`. The app answers only the
browser and the server list, and only from its own server's connection. A
host that drops answers every call still waiting on it with an error, a reset
included.

Three things ride it:

- **`dray browser` steps**, run by the app's `cef::automation::run`. No host,
  or a host without CEF (a dev build without `--features cef`), and the step
  goes to headless Chromium.
- **`dray server …`**, since the server list is the app's. No host: "The
  server list lives in the Dray app. Open it and run this again."
- **A session settled or deleted** closes its tabs in the app. The recordings
  are files the server deletes itself, app open or not.

### Two processes, one directory

**The app writes no session data.** Index, projects, logs, drafts: the
server's alone, which is the rule that keeps one index from being rewritten
by two processes.

**Two files keep two writers**: `settings.json` (the app's transcription
picks beside the server's analytics and remote access) and
`credentials.json` (the app's server tokens beside the server's Linear key).
Both already change through one function each (`settings::update`,
`set_credential`), so each takes an `flock` on a lock file beside it, held
across read, edit and rename. A process-local mutex stays in front of it.

### launchd

**The app installs the agent on every launch**:
`~/Library/LaunchAgents/com.yogesh.dray.server.plist`, `ProgramArguments`
naming the app's own executable with `--serve`, `RunAtLoad`, `KeepAlive`,
stdout and stderr to `<home>/server.log`. Rewritten and re-bootstrapped where
it differs from what is on disk, so moving Dray.app heals at the next open.
macOS shows its own "Background item added" notice once; nothing of ours.

**A plain plist, not `SMAppService`.** That API wants the plist inside the
bundle and a signed app, and a dev build is neither. Both show the same
notice and the same Login Items row.

**The dev app installs no agent; it starts its server as a child.**
Measured: under launchd an unsigned `target/debug/dray` in `~/Documents`
blocks in dyld on "would like to access files in your Documents folder", and
every rebuild is a new code identity, so the prompt came back on each one. A
child is attributed to the app that started it, which already has access — it
started with no prompt, and an agent under it read a repo in `~/Documents`.
Its own process group, so Ctrl-C on `pnpm tauri dev` leaves it running.
Nothing restarts a dead one until the app's reconnect loop asks; a second one
exits on its own, since the socket already answers. Home is `~/.dray-dev`:
`store::home_override` answers that for a dev build where `DRAY_HOME` is
unset, so app and server agree with nothing passed between them. Dev's asset
scope gains the `~/.dray-dev` directories.

**The release agent inherits nothing and is judged on its own signature**,
which is Dray's Developer ID, the identity the reader already granted.
Unverified until a signed beta runs it.

**Stale server = the binary moved under it.** The server writes its
executable's modified time into `serve-port` beside the port; the app
compares it with the same file now. A difference means an update landed or
cargo rebuilt, and the app sends `restart_when_idle`: the server exits once
no turn is running, and launchd (in dev, the app) starts the new binary. No
version strings, and dev and release follow one rule.

**Quit and stop sessions** is `launchctl bootout` on the label, then quit.
Agents lose their stdin with the server and end, as they did with the app. A
dev server has no agent, so it is sent `SIGTERM` at the pid it wrote as the
third line of `serve-port`, and a flag keeps the reconnect loop from starting
another in the moment before the app exits.

**Install needs no code of its own.** The relaunched app meets the old
server, the stamps differ, and the server restarts onto the new binary once
no turn is running — the stale-server rule above, which is why the update
and a cargo rebuild are one path.

**`SIGTERM` is handled.** launchd stops the server with it, and the server
kills cloudflared and removes the tunnel address on the way out, as the app's
quit path does today.

## Staging

Each stage leaves the app working.

1. **Server mode, unused.** `dray --serve` runs the core: hub, orchestration
   socket, local listener and port file, remote access, startup resets,
   `SIGTERM`. Headless browser and serve deps in the desktop build. Proven by
   running it on a scratch `DRAY_HOME` and pointing the existing live tests
   and the smoke script at it, and by the three macOS checks above on a debug
   bundle. Carries the `dray tunnel` Ctrl-C fix in `apps/cli/src/setup.rs`.
2. **The switch.** launchd agent, `local` connection, transport split, core
   commands out of the app, the app no longer serving, resetting or binding
   the orchestration socket, `flock` on the two shared files, dev home and
   label, the stale-server restart. Remote access's row talks to the server.
   The one stage that cannot be split: half of it is two cores on one
   directory.
3. **Host calls.** Browser steps to the app with headless fallback, tabs
   closed on settle and delete, `dray server` forwarded.
4. **Update and quit.** Install restarts the server; the quit dialog's
   second button.
5. **Docs.** CLAUDE.md (orchestration, the browser, Updates, Notifications,
   the headless server), TUNNEL-PLAN.md's Mac half, the checklist.

## Left out

- **Banners while the app is closed.** The app posts them, so a session that
  finishes with Dray closed says nothing until it opens. The server could post
  its own; nobody asked.
- **A stable address, a login, the phone.** #456 named them out.
- **Keeping agents alive across a server restart.** An update ends them, as
  quitting did before.
- **The dev app seeing real sessions.** Accepted when this was settled.
- **A session another client creates appears on re-read.** `send_msg`
  creating one publishes no `session_created`, so a script or a second Mac
  creating a session leaves the app's sidebar unaware until it reads the index
  again. True of remote servers before this; `dray new` does announce.
