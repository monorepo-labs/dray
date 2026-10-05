# `dray serve` — the core as a headless server

monorepo-labs/dray#413, steps 1 and 2: the Rust core runs with no Tauri and
speaks a WebSocket, and the frontend reaches either it or the in-process core
through one wrapper. SSH, pairing, Tailscale, relay and mobile are later issues.

## What tied the core to Tauri

Four things, and only four:

1. **`AppHandle` as an event sink.** 36 `.emit(` sites, every one of them
   `app.emit(name, payload)`. Nothing else was read off the handle except
   `orchestration.rs` (`app.state::<SessionManager>()`) and `files::read_file`
   (the asset scope, for videos).
2. **`State<'_, SessionManager>`** on a dozen commands in `lib.rs` and one in
   `local_servers.rs`.
3. **`#[tauri::command]`** on 113 functions — an attribute, not a dependency of
   the function body.
4. **`tauri::is_dev()` and `tauri::async_runtime::spawn`**, in orchestration
   and analytics.

The Mac-only modules — `cef`, `chromium`, `recording`, `transcription`,
`notifications`, `quit`, `updater` — are reached from the core in three places,
all already behind `#[cfg(feature = "cef")]`.

## The seam

**`Sink`** ([sink.rs](src-tauri/src/sink.rs)) replaces `AppHandle` in the core.
A cloneable `Arc<dyn Fn(&str, serde_json::Value)>` with one method, `emit`,
spelled like Tauri's so the call sites did not change. The desktop builds one
from its `AppHandle`; the server builds one that broadcasts to every socket.
`impl CommandArg for Sink` lets a Tauri command take `sink: Sink` exactly as it
took `app: AppHandle`, so a command body is the same Rust in both builds.

**`session::manager()`** — one `SessionManager` per process, a static. It was
already one per process through `.manage()`; a static is what lets the server
and orchestration reach it without a Tauri state map.

**`crate::is_dev()` and `crate::spawn()`** stand in for Tauri's two. A server
is never a dev build; it gets the same separation through `DRAY_HOME`.

Every core command is then an ordinary function whose attribute is
`#[cfg_attr(feature = "desktop", tauri::command)]`, and the server calls the
same function.

## Crate layout

**One crate, two features.** No new crate, no root workspace (CLAUDE.md: a
workspace moves the target dir out from under `.cargo/config.toml`'s ts-rs
path).

- `desktop` — **default**. Tauri, its plugins, `tauri-build`, and the
  Mac-only dependencies (`transcribe-cpp`, `cpal`, `rubato`, `notify-rust`).
  Gates `lib.rs`'s `run()` and the Mac-only modules. `cef` implies it.
- `serve` — off by default. `tokio-tungstenite`, the `serve` module and the
  `dray-serve` binary (`required-features = ["serve"]`).

**The release pipeline does not move.** `tauri build` builds default features,
which are today's features under a name, and skips `dray-serve` because of its
`required-features`. The `dray` binary has `required-features = ["desktop"]`.

```bash
cd apps/desktop/src-tauri
cargo build --no-default-features --features serve --bin dray-serve
```

**Required check, every change to the core:**

```bash
cargo check --no-default-features --features serve --bin dray-serve --tests
```

Nothing else compiles this build — there is no per-PR CI — so a desktop-only
call slipped into the core rots it silently. The same line belongs in
`warm-cache.yml` on main beside the desktop build.

Extracting a `crates/dray-core` was the alternative. It moves ~50k lines, and
`cargo test` in `src-tauri` stops exporting the core's ts-rs types (a crate's
tests only run in that crate), so `events.ts` would need a second regeneration
path.

## The wire

JSON text frames over one WebSocket, mirroring Tauri's own two calls so the
frontend wrapper is a few lines:

```text
→ {"v":1,"token":"…"}                         first frame, always
← {"v":1}                                     or {"err":"…"} and close
→ {"id":1,"cmd":"send_msg","args":{…}}        args exactly as invoke sends them
← {"id":1,"ok":…}  or  {"id":1,"err":…}       err as a rejected invoke carries it
← {"event":"agent_event","payload":{…}}       every event, to every client
```

**The version is checked before anything else in the first frame**, and the
refusal names which side is behind — `update the Dray app` or
`update dray-serve` — the rule `dray_proto::PROTOCOL_VERSION` already follows.
It is stated in `serve.rs` (`PROTOCOL`) and again in `transport.ts`.

Commands run concurrently, as Tauri's async commands do, so a send that spawns
a child holds no permission reply behind it. A client that falls 4096 events
behind is dropped rather than silently skipped; reconnecting re-reads.

## Reconnecting

**A client reconnects on its own and resyncs; no event a reader needs is lost,
and no agent is left blocked on a card nobody can see.** Three kinds of state,
three routes back:

- **Logged events** come back from the log. On every connect the client re-reads
  each open session's tail (`get_session_by_id`, then `get_session_page` until
  the pages meet an event it holds) and appends what follows its newest held
  event, in log order ([resync.ts](src/lib/resync.ts)). Matched on event **id**,
  never `seq`: a Claude Code subagent numbers its own events from 0 inside the
  same log, so no seq is a cursor. A replayed queued prompt retires its queue
  row, and a provisional prompt gives way as it does live.
- **Unlogged state** comes from the server's memory. Every connect opens with
  one `live_state` frame — open permission and question requests, and each
  session's background tasks — kept by the server's sink under the same lock it
  broadcasts with, so the snapshot and the stream meet exactly. Retire rules are
  the frontend's own: a decision answers its request; a turn over with no task
  left strands the rest. The client **replaces** what it holds with it, so a
  card answered meanwhile goes and one raised meanwhile is drawn. Applied
  quietly: nothing in it is announced again.
- **Status** needs no copy: every change is written to the index, which the
  client re-reads on `live_state`, after dropping the live readings that would
  outrank it.

Deltas are dropped, being previews; a reconnect retires any half-drawn one. The
socket retries every second while anything listens.

## Files

`GET /file?token=…&path=…` on the same port serves what `convertFileSrc` serves
in the app — attachments and browser recordings — confined to those two
directories by canonical path, so `..` and symlinks reach nothing else. The
token rides the query because an `<img>` cannot set a header. Absent and
forbidden both answer 404. `fileSrc` in `transport.ts` builds the URL. No Range
support yet, so a long video plays but cannot seek. A video the Files view
opened is let through too: `read_file` records its canonical path, the remote
copy of the app's `allow_file` grant.

Before the token is checked a connection is a stranger, so it gets 10s to send
the `/file` head or finish the handshake and hello, and a `/file` head is capped
at 16KB.

Dispatch is a table in [serve.rs](src-tauri/src/serve.rs): name, argument
names and types, the call — Rust cannot read a function's parameter names back,
so they are stated a second time. A command not in the table answers
`err: "unknown command <name>"`, which is how a Mac-only command looks to a
remote client.

## Auth

**A kept token plus an Origin check, binding `127.0.0.1`.**

- **Token.** A TCP port on localhost is open to every account on the machine,
  unlike `dray.sock` behind a `0700` directory, and a VPS is often shared. So
  the server holds a 256-bit token in `<data dir>/serve-token`, `0600` from its
  create (`store::write_private_atomic`), and the first frame must carry it.
  Compared in equal time. It is also what remote reach will use.
- **Kept across starts, and that reverses the first shape.** A token minted
  per start broke every saved server on each restart, and the server runs as a
  service that restarts on reboot, update and crash. It already sat in that
  file for the server's whole run, so keeping it exposes it to nobody new; the
  cost is that a leaked token stays good until rotated. A missing, empty or
  malformed file is minted afresh, and **deleting the file rotates it** — no
  flag.
- **Origin.** A browser lets any page open a WebSocket to localhost, so a
  handshake carrying a non-local `Origin` is refused with 403 before a frame is
  read. No `Origin` is a non-browser client, which the token answers for.

## Data directory

`DRAY_HOME` overrides `~/.dray`, read in `get_home_app_dir` and the socket
path. The index is rewritten whole under a *per-process* lock, so two processes
on one data dir lose each other's writes — which is exactly a `dray-serve`
started on a Mac whose app is running. Unset on a VPS. So `run` refuses to
start where `dray.sock` or `dray-dev.sock` in its home answers a connect, and
names `DRAY_HOME` as the cure.

The server also serves the orchestration socket, so `dray new`/`send`/`ls`
from inside its agents reach it (`DRAY_ENDPOINT` is already injected).

## What stays desktop-only

CEF browser, Chromium download, recording, dictation, notification banners,
quit dialog, updater, the dock badge, NSPasteboard paste, and the asset-scope
grant in `read_file`. Commands that act on the server's own desktop —
`open_in_app`, `list_open_apps`, `open_login_terminal`, `run_agent_login`,
`update_agent_in_terminal`, `paste_attachments` — are left out of the table.

**The native pickers too.** Attach project and attach files open the Tauri
dialog plugin, which a plain browser has not got, and a browser's own picker
would name files on the *client's* disk where the server needs a path on its
own. The cure is a picker drawn over `list_dir` on the server, which is a
product surface and belongs with the SSH-connect work. Until then
`add_project` is reachable over the wire (the smoke script uses it) with no
control on screen to call it.

## Frontend

[transport.ts](src/lib/transport.ts) exports `invoke` and `listen` with
Tauri's signatures. With no server named they are Tauri's. A server is named by
the page URL — `?token=…` and optionally `&server=ws://…` (default
`ws://127.0.0.1:7317`). Every `invoke`/`listen` import goes through it.

`fileSrc` stands in for `convertFileSrc`, so local files load through the same
door.

Desktop-only commands reject with `unknown command`; the UI logs some
(`list_open_apps`, `check_update`) rather than hiding the control.

## Trying it

```bash
cd apps/desktop/src-tauri
cargo build --no-default-features --features serve --bin dray-serve
DRAY_HOME=/tmp/dray-serve-home ./target/debug/dray-serve --port 7317

# a scripted turn
cd .. && DRAY_HOME=/tmp/dray-serve-home node scripts/serve-smoke.mjs

# the real UI in a browser
DRAY_DEV_PORT=1477 pnpm dev
open "http://localhost:1477/?token=$(cat /tmp/dray-serve-home/serve-token)"
```

## Stages

Each left the desktop app exactly as it was (`cargo test`: 870 pass, `events.ts`
unchanged).

1. **Seam** — `Sink`, `session::manager()`, `crate::is_dev()`, `crate::spawn`. Done.
2. **Features** — `desktop` default, Tauri and Mac-only deps behind it,
   `cfg_attr` on every command. `cargo tree --no-default-features` holds no
   `tauri`. Done.
3. **Server** — `serve.rs` + `dray-serve`: WebSocket, hello, token, Origin,
   event fan-out, orchestration socket, startup resets, the whole core table.
   Proven by `serve-smoke.mjs`: a Claude Code session created and a turn
   streamed. Done.
4. **Frontend transport** — `transport.ts`, imports moved. Proven in a plain
   browser against `dray-serve`: a session resumed and a new one created, both
   streamed. Done.
5. **Files and reconnect** — the `/file` route, `fileSrc`, `live_state`,
   log resync. Proven with a TCP proxy between the browser and the server, cut
   while a script drove the session: a turn missed while away was drawn in
   order, a permission card raised while away was drawn and answered from the
   page, and a card denied while away was gone on return. An attached image
   loaded through `/file`; a wrong token answered 401, `/etc/passwd` and a `..`
   climb 404. Done.

## Verified

- **Linux.** `dray-serve` builds on Debian bookworm (`rust:1-bookworm`,
  aarch64, via OrbStack) with no default features, first try. Run there, the
  smoke script got through the handshake, `agent_availability` and
  `add_project`, and `send_msg` answered "Claude Code isn't installed", which is
  as far as a container with no agent CLI goes.
- **The desktop with `cef`** still compiles (`cargo check --features cef`
  against the SDK in `~/.local/share/cef`).
- **The dev app** was run by hand: turns, permission and question cards,
  rename, Stop, a Codex turn, `dray new` appearing live, live file updates, and
  settle, delete and fork.

## Naming and distribution

**The command people type is `dray serve`, as with opencode and T3 Code;
`dray-serve` is only the file behind it.** No CLI change lands here: a
`dray serve` shim with no install story would have nothing to find. At the
SSH-connect issue, `install.sh` installs `dray` and `dray-serve` from one
release tag at one version, and `dray serve` execs the binary beside itself.
That is one install and no drift in practice, without the CLI crate linking the
core. Folding the server into the CLI binary (opencode's own shape) was
rejected: the CLI would carry tokio and the whole core, and lose the rule that
it links nothing.
