# Several servers at once

monorepo-labs/dray#414, stage 3 of "Dray anywhere". Stage 1 (#413,
[SERVE-PLAN.md](SERVE-PLAN.md)) made the core a `dray-serve` and put one
transport in front of it. This makes the desktop app hold the in-process core
**and** any number of remote `dray-serve`s, with one merged sidebar.

## Identity

**A server is a `ServerId` string: `"local"` for the in-process core, an
8-hex id for a remote one.** The id is minted when the server is added and
never changes, so a rename or a new address keeps every key built on it.

**A remote path, in the frontend, is a URL: `dray://<id>/root/app`.** That is
the whole of how a project, a session and every path-keyed cache learn their
server. The rejected alternative was a `server` field beside every path: about
a hundred sites key on `projectPath` or `cwd` (sidebar grouping, the composer's
pick, PR marks, slash commands, work status, changes, the file tree, accounts,
issue repos), and every one missed would merge two servers' projects that
share a path — which they do, since OrbStack mounts the Mac's home at the same
path inside a Linux machine. Qualified, every one of those keys is already
unique and already right, and a local path stays exactly what it is today.

- **The transport is the only thing that unwraps one.** `invoke` strips the
  prefix from every argument (top level, and strings inside arrays) and routes
  the call to that server; arguments naming two servers are refused.
- **Ingest qualifies.** A remote answer that carries project or session paths
  — projects, index items, snapshots, `session_created`, `doc_changed`, a video
  `read_file` answers — has them qualified where it is read, in one table in
  `transport.ts`. Paths inside agent events (tool inputs, prose) stay as the
  agent wrote them; a surface that opens one qualifies it against the chat
  session's server (`useSessionPath`).
- **Display unwraps.** `displayPath` is what a reader sees.

**A session's server is a map in the transport**, filled from every place a
session id arrives: an index item, a `session_created`, any remote event naming
`sessionId`, and a call routed by path that names one (a new session's
`send_msg`). A session never moves servers, so the map is never wrong once
written. A call carrying `sessionId` routes by it unless told otherwise.

## Transport

```text
invoke(cmd, args, server?)
  server given        → that server
  else a dray:// arg  → its server, prefix stripped
  else args.sessionId → the session's server
  else                → local
local  → Tauri's invoke
remote → invoke("server_invoke", {server, cmd, args})
```

**The connections live in Rust** ([servers.rs](src-tauri/src/servers.rs)), not
in the webview. A token is a credential, and the Credentials rule is that one
never reaches the frontend: so the socket, the hello and the token are Rust's,
and the webview only ever names a server id. Events arrive as one Tauri event,
`server_event {server, event, payload}`, which `listen` fans out to the same
handlers local events reach, with `server` on the event. Status rides
`servers_changed`, the whole list every time.

**Files.** A remote attachment loads through `drayserver://localhost/?server=…&path=…`,
a Tauri URI scheme that fetches the server's `/file` route with the token in an
`Authorization` header. So no token sits in a URL the page holds. `/file`
still takes `?token=` for a plain browser's `<img>`, which cannot set a header.
**Before a server is reachable off-machine**, that query form needs replacing
for the browser client too — a short-lived per-file ticket minted over the
socket is the shape — since a URL is logged, cached and copied where a header
is not. Not here: nothing reaches a server off-machine yet except through an
SSH tunnel or Tailscale.

**`ws://` only.** Off-machine reach in stage 4 is an SSH tunnel to
`127.0.0.1`, which is encrypted already. `wss://` is refused by name.

## Storage

- `~/.dray/servers.json` — `[{id, name, url}]`, device-local.
- `~/.dray/credentials.json` — each token under `server:<id>`, `0600`, beside
  Linear's key. `add_server` admits the token before saving it.
- Re-adding an address already listed updates its token, which is how a
  reader reconnects after rotating one. `dray-serve` keeps its token across
  restarts, so an ordinary restart needs nothing.

## What gains the server in its key

Free, through the qualified path: everything keyed on cwd or project path —
PR marks and panel, slash commands, work status, changes, head tree, commit
log, file tree and search, docs and open files, accounts, `github_repo`,
project filter, drafts' project.

Keyed by hand:

- **Index items and projects** — fetched per server, held per server, merged
  for the sidebar. A server that drops keeps its last answer, drawn dimmed.
- **Agent availability** — per server.
- **Model lists** — `modelsByHarness` becomes per server and harness.
  `models_changed` reloads the server that said it.
- **`live_state`** — replaced only for the sessions of the server that sent
  it. Stage 1's handler wiped every session's asks and status, which with two
  servers is one reconnect erasing the other's cards.
- **`watch_docs`** — the watch set is per server, so a path list is split by
  server and each server is told its own.

Deliberately **not** keyed, because the answer is the reader's own and lives
on this Mac:

- **Issues.** Linear's key and `gh`'s login are the reader's, on this Mac, so
  every issue read stays local. A remote session's links ride its own index
  entry; a `#` tag typed into a remote session resolves on the remote and,
  with no key there, stays text — best effort, as every tag already is.
- **Drafts.** A draft is set aside on this device; its project is qualified,
  so starting one sends to the right server. `dray draft` run by a remote
  agent writes that server's drafts file, which this app does not read.
- **Settings, analytics, the updater, transcription, the browser.**

## Mac-only features

The embedded browser, dictation and open-in-app are offered for local sessions
and projects only. Notifications and the dock badge count every server — they
read the same per-session state every server's events feed.

## Stages

Each leaves the single-server app exactly as before: with only Local Server,
no path is qualified and every call routes local.

1. **Connections** — `servers.rs`: list, add, remove, `server_invoke`,
   `server_event`, `servers_changed`, `drayserver://`. `/file` takes a bearer
   header.
2. **Transport** — routing, the session map, qualification, `listen` across
   servers.
3. **Merged lists** — projects and index items per server, sidebar suffix,
   header, picker groups, disconnected rows, scoped `live_state`.
4. **Keys** — availability, models, `watch_docs`, everything else the
   inventory found.
5. **Settings** — the Servers page and Add server dialog.
6. **Gating** — Mac-only features off for remote.

All six are built.

## Verified, and not

Tested against two real `dray-serve`s through
[demo/servers.html](demo/servers.html), which mocks Tauri's IPC and does in
the page what `servers.rs` does in Rust, so everything above the transport is
the shipping code. Checked there: the merged sidebar and its `-vps` suffix,
two projects sharing a path kept apart, the picker grouped by server, a remote
header reading `vps / ade / …`, no Browser tab or mic on a remote session, the
remote proxy killed mid-turn (headings dim and say disconnected, the turn that
finished meanwhile is caught up on reconnect, a local card survives it), and a
remote permission card answered across a cut. `servers.rs` has an ignored live
test against a running `dray-serve` (add, refused token, `live_state`,
`server_invoke`, token kept out of `servers.json`, reconnect, remove), which
passes.

In the real app, Yogesh added a scratch `dray-serve` through Settings and saw
a remote session stream and a remote image load, which covers the native glue
the page mocks: `server_event` reaching `listen`, and `drayserver://` in
WKWebView. Notifications and the badge were checked only through the logic
they share with the sidebar.

**Known gaps.** Attachments to a remote session are refused with a sentence:
the file is on this Mac. `dray-serve` binds `127.0.0.1`, so a
container or VPS is reached through a tunnel until stage 4.
