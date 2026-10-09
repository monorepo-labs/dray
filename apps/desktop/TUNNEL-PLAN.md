# Stage 7: reaching a server through a Cloudflare quick tunnel

monorepo-labs/dray#452. Until now a client reached a remote server over SSH
alone ([SSH-PLAN.md](SSH-PLAN.md)), which needs a public IP and a key on the
client. A phone cannot run `ssh` at all. This puts the quick tunnel `dray
share` already runs for dev servers (#434) in front of `dray-serve` itself.

Two PRs: the Linux half, then the Mac half — the app serving, turned on from
the This Mac row.

## What was decided

**The pipe is a Cloudflare quick tunnel.** `cloudflared tunnel --url
http://127.0.0.1:7317`: no account, a random `*.trycloudflare.com` address,
Cloudflare promising no uptime. Nothing of ours runs anywhere. Cloudflare
terminates TLS and sees the traffic; the token still gates every connection.

**The address moves and the token does not.** Every tunnel start is a new
address. The client keeps the token and asks for the new address when the old
one stops answering. Where the app also has an SSH login to that server it
reads the address off the server and never asks.

**`dray tunnel`** runs the tunnel in the foreground, in front of the port
`dray-serve` uses (`dray_proto::SERVE_PORT`, `--port` to change it). It writes
the address to `~/.dray/tunnel-url` once cloudflared says the tunnel is
registered **and** the name resolves at 1.1.1.1, and removes the file when it
exits. Registered alone was `dray share`'s rule and is not enough: see below. It
refuses to start where no server answers on the port, and where no
`cloudflared` is found it names `dray setup --install cloudflared` and stops.
It looks where `dray setup` installs it and where `dray share` downloads it.

**The connect line is one line**, `wss://<host> <token>`, printed only when
stdout is a terminal: under systemd stdout is the journal, and the token must
not be logged. Pasted into Add server's Address field it fills the token too.

**A public address is opt-in.** `dray service tunnel on` installs
`dray-tunnel.service` beside `dray.service`: `PartOf` stops and restarts it
with the server, `WantedBy=dray.service` starts it whenever the server starts,
boot included, and `Restart=on-failure` brings it back when Cloudflare drops
it. Plain `dray service start` — which setup and every SSH connect run — never
adds one and leaves one already there alone. `dray service tunnel off` takes it
down; `dray service uninstall` takes both. `dray service status` prints the
current address and, on a terminal, the connect line.

**Stopping removes the file.** `dray tunnel` passes SIGHUP, SIGINT and SIGTERM
on to cloudflared through a handler rather than ignoring them, since an
ignored signal stays ignored across `exec`, and lives on to remove the address.
It removes it only while it still holds its own address. A `kill -9` leaves it
behind; the next start overwrites it.

**The server accepts the tunnel's own origin.** The Origin check refused
everything but localhost. A page at the tunnel's address can only be one this
server answered, and a phone's WebSocket names the address it connected to as
its origin, so `https://<the address in tunnel-url>` is let through too, read
per handshake since it moves. Every other origin is still refused. `/file`
needed nothing: it was never origin-checked, and the app sends its token in a
header.

**The app speaks `wss://`.** `tokio-tungstenite`'s `connect_async` with rustls
on the system's roots, both already in the tree under `reqwest`, so no OpenSSL
and no new crate. `https://` is read as `wss://`.

**An SSH server records its tunnel address.** The connect script prints
`DRAY-SSH tunnel <address>` where `tunnel-url` exists, and the app keeps it as
the server's `url` beside the SSH target, with the token in `credentials.json`
(`0600`). When the login fails, the loop tries that address with that token
before reporting the SSH failure. A login that finds no tunnel forgets both.

**A dead address asks for a new one.** For a server added by address, a
failed connect to a `*.trycloudflare.com` host is checked: a 530 from
Cloudflare, or a name that no longer resolves while `trycloudflare.com` does,
means the tunnel is gone. The row then stops retrying and shows a field for
the new address; `set_server_address` admits it with the kept token before
saving. A name nobody picked was the old host and follows the new one.
Anything else — this Mac offline, a 502 because the server behind a live
tunnel is down — keeps retrying as before.

## What was measured

- A WebSocket through a quick tunnel to `dray-serve`: admitted in ~1.1s from
  the Mac, a call answered 85ms later. `/file` answered 404 outside its
  directories and 401 on a wrong token, through the tunnel.
- Origin through the tunnel: the tunnel's own origin 101, `https://evil.test`
  403. Over HTTP/2 Cloudflare answers 502 to any upgrade, so a client must
  speak HTTP/1.1 for the handshake — every WebSocket client does.
- SIGTERM to `dray tunnel`: cloudflared gone and `tunnel-url` removed within
  0.5s.
- A stopped tunnel's host: HTTP 530 while its DNS still resolves, NXDOMAIN
  later. An address that never existed: NXDOMAIN at once.
- **A new address is not in DNS when cloudflared says registered.** It
  resolved at 1.1.1.1 1.6s and 2.6s later in two runs, and a resolver that
  asked in that gap cached the miss for the zone's 60s (the VPS's own resolver
  answered at 59.3s both times; this Mac's ISP resolver the same). The first
  live test failed on exactly this. So `dray tunnel` polls 1.1.1.1's
  DNS-over-HTTPS through `curl` before handing the address out, up to 15s, and
  `dray share` now does the same through `reqwest` — its links had the same
  gap.

- **Live, against the test VPS** (`servers::tests::follows_the_tunnel`, run
  with `DRAY_TEST_SSH`): added by address alone and admitted through the
  tunnel in ~1.7s; the tunnel restarted, the row asked for a new address,
  and the new one connected with the kept token. Added over SSH, the address
  was recorded with the token in `credentials.json`, never `servers.json`;
  with the login pointed at an address that answers nothing, the row
  connected by tunnel in 11.1s, 10s of it `ssh`'s own timeout; with the login
  back, a tunnel restart was followed with no question. The stage 3 and 4
  live tests pass too, the stage 3 one entirely over `wss://`.
- `dray service tunnel on` on the VPS: address in ~6s, no token in the
  journal. `systemctl --user restart dray` took the tunnel with it; its first
  start lost the race to the server binding and `Restart=` brought it back
  5s later.

## The Mac serving (PR 2)

**A button on the This Mac row in Settings, Servers**, not a switch: a
switch on that row reads as turning the Mac off. On, the app runs the
listener `dray-serve` runs, in this process on `127.0.0.1`, with the same
`serve-token`, and a quick tunnel in front of it. Another Mac connects to the
very sessions on this screen: one process, one data dir, no second writer, and
agents keep the Mac's own browser. Quitting Dray or a sleeping Mac stops it,
and the row says so in one line. The choice is kept in `settings.json`
(`remoteAccess`), since Rust starts serving at launch before any webview
exists. Until the address is up, about 20s, the row says it is starting.

**`serve.rs` is split in two: a `Hub` and `listen`.** The hub is the event
broadcast plus `Live`, what a connecting client snapshots. `dray-serve` builds
its `Sink` on one; the desktop's `Sink` publishes into `serve::HUB` as well as
the webview, so no call site moved. The hub notes `Live` whether or not the
app is serving, so a client connecting later still gets the open cards, and
builds no frame while nobody listens. Events about this Mac's own remote
servers and about Remote access itself stay in the window. `listen` holds its
connections in a `JoinSet`, so dropping it — the switch going off — drops
every client with it.

**The tunnel start moved out of `share.rs`** into `quick_tunnel`, which dev
server links and Remote access both use: download, banner, registered, DNS.
If cloudflared exits the app starts another, under a new address, backing off
to a minute between failures. Quitting kills cloudflared and removes the
address file by hand: the app leaves through `_exit`, which runs no
destructor, so `kill_on_drop` alone left the tunnel up. Presses on the row are
serialized, setting included, so an "on" cannot finish after an "off".

**The token never sits in the webview.** The row draws the address and a
masked token side by side, each with its own copy button, the two fields of
Add server. The token's copy asks Rust for it (`remote_access_token`), writes
it to the clipboard and keeps a marker, not the text. `get_settings` carries
none of it.

**A dev build serves beside the release app**: port 7318 and
`tunnel-url-dev`, since the two share `~/.dray` and its token.

Measured: the in-process server through a real tunnel, in a throwaway
`DRAY_HOME` (`remote_access::tests::serves_through_a_tunnel`): an address in
~20s from this Mac, a client admitted, an event the core emitted reaching it,
and off dropping it and removing the address file. Then the dev app itself,
launched with the switch already on: it served at launch, and the stage 3 live
test passed against it through the tunnel — wrong token refused, a call
answered, the Mac-only `open_in_app` refused as unknown, reconnect.

## What was left out

- A stable address and a login: a named tunnel on the reader's own domain, or
  our own relay. Next.
- Encryption inside the WebSocket. Cloudflare sees the traffic.
- `/file?token=` stays for a plain browser's `<img>`, which cannot set a
  header. The browser UI is dropped, so nothing of ours sends it; a phone app
  must use the header.
- A QR code, the phone app.
- An SSH server's address is read at login. A tunnel restarting while the
  login stays up leaves the recorded one stale until the next login, and a
  login landing mid-restart, when no address file exists, forgets it until
  the next. Both heal on their own; only the no-SSH fallback is affected.
- `forward_port` and Sign in still need SSH: a server reached by tunnel alone
  has neither, and says so as before.
