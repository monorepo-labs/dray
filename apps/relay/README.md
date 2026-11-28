# Dray relay

Remote access for Dray servers without opentunnel (#1669). A phone or another
Mac reaches a `dray-serve` at a stable address, through one small service of
ours, which sees nothing but ciphertext.

## How it works

```
phone ──TLS──▶ relay :visitor port ──┐   routes by SNI, reads nothing else
                                     │
dray-serve ◀──── bridge WebSocket ───┘   one per server, dialled out by it
   │
   └─ ends the phone's TLS with its own key, then the serve wire as ever
```

- **Each server keeps one WebSocket open to the relay**, the bridge, at
  `wss://relay.drayhq.com/v1/bridge?key=…`. Both ends ping every 10s and give
  up after 30s of silence (opentunnel: 15s and 45s). A dropped bridge comes
  back after a jittered backoff from 250ms to 8s (opentunnel: 30s), at once on
  a network change or when the relay says it is restarting (`drain`).
- **A visitor's TLS is routed, never ended.** The relay reads the ClientHello's
  SNI, `<route>.<id>.relay.drayhq.com`, finds the bridge for `<id>` and carries
  the bytes over it, the hello included. `dray-serve` ends TLS with a key that
  never leaves it, so the token in the client's hello, and everything after
  it, is unreadable to the relay and to Railway. This is opentunnel's model;
  the serve wire's own token auth passes through untouched.
- **A visitor arriving while its server reconnects is held** up to 10s rather
  than refused, so a client's retry lands the moment the bridge is back.
- **Streams have their own flow control**: 256 KiB of credit each way, handed
  back in 64 KiB steps, so one slow visitor fills its own window and never
  stalls the bridge or another visitor.
- **No database.** A server's id is a hash of its Ed25519 public key, proved by
  signing the relay's challenge on every attach; its keys live in
  `<DRAY_HOME>/relay/`. The relay keeps bridges in memory, and a restart costs
  every server one reconnect. The newest attach for an id wins.
- **Certificates**: the server sends a CSR for `*.<id>.relay.drayhq.com` over its
  authenticated bridge; the relay checks the name is the server's own and gets
  it signed by Let's Encrypt over DNS-01, writing the TXT record through
  Cloudflare's API (drayhq.com's DNS is there). The server renews once a third
  of the certificate's life is left. The route label is secret and stays out of
  certificate-transparency logs, since the certificate names only the
  wildcard.

The wire is in [crates/dray-relay](../../crates/dray-relay/src/lib.rs), shared
with `dray-serve`'s side, [relay.rs](../desktop/src-tauri/src/relay.rs).

### Why two doors

Railway's HTTP domains end TLS at Railway's edge, which a blind relay cannot
allow on the visitor side. Its TCP proxy passes raw bytes, but on a port
Railway picks. So bridges use the HTTP domain on 443 (ordinary `wss://`,
proxies and all) and visitors the TCP proxy:
`wss://<route>.<id>.relay.drayhq.com:<railway port>`. Every Dray client already
takes a port in an address, so **no client changes**. The cost: a network
that blocks ports other than 443 blocks the address. Moving to a host with raw
443 later changes only `RELAY_PUBLIC_PORT`, and every address with it, so
phones would pair again once.

DNS-01 for the same reason: HTTP-01 and TLS-ALPN-01 only ever knock on ports
80 and 443 of the name itself.

### Trust

The relay never holds a server token or a server's TLS key, and cannot read
the traffic it carries. What it does hold: a Cloudflare token that can edit
drayhq.com's DNS, and an ACME account. Together those could issue a
certificate for any server's name, which is the same power opentunnel's
operator has over its names. Issuance is public in CT logs. Before this goes
past contributors, give it a zone of its own (a separate domain), so its token
cannot touch drayhq.com, and keep issuance off drayhq.com's Let's Encrypt
limit of 50 certificates a week. A CAA record on `relay.drayhq.com` with
`accounturi=` can pin issuance to the relay's account.

Only contributors may attach: the relay URL carries a key from `RELAY_KEYS`,
one per person so one can be revoked alone. Logs name the person, never the
key. A server whose key is refused (`not_allowed`) stops its bridge and says
so on the This Mac row; Remote access tries again once a minute.

## Logs

One logfmt line per event on stdout, which Railway keeps:

```
bridge.attach  id key version peer session replaced
bridge.drop    id session reason after_s streams     reason: silent 30s, read: …, closed by server, replaced…
bridge.refused peer reason                           bad_signature, not_allowed, attach_timeout
visitor.close  id conn peer up down after_s held_ms [reason]
visitor.miss   id peer waited_ms                     no bridge within the 10s hold
visitor.refused peer reason [sni]
cert.issued / cert.failed  id after_ms [reason]
relay.start / relay.drain / relay.fatal
```

`dray-serve` logs its side as `[tunnel relay <time>] …` in its server log:
connecting, connected (id, relay instance, address), dropped (after how long,
why, next try), network changes and probes, certificates.

`GET /healthz` answers `ok`; `GET /status` counts bridges and streams.

## Turning it on for a server

While opentunnel stays the default, a server uses the relay when either names
one:

- `DRAY_RELAY=wss://relay.drayhq.com/?key=<your key>` in its environment, or
- the same URL as the first line of `<DRAY_HOME>/relay-url` — `~/.dray/relay-url`
  for a release, which is the way for a Mac, whose launchd server gets no
  environment of yours.

Then Remote access off and on (`dray server tunnel off && dray server tunnel
on`), or restart the server. The address changes, so pair the phone again.
Deleting the file and toggling again goes back to opentunnel. Deleting
`<DRAY_HOME>/relay/` gives the server a new id, and new addresses.

## Switching everyone over

The release that makes the relay the default changes every server's address,
so it tells readers to pair again with a full-window highlight. Its entry for
CHANGELOG.md, under that release's `### New`, ready to paste (it stays out of
the file until then, since the site publishes whatever is there):

```markdown
- **Remote access is faster. Pair your phone and other Macs again.** Your
  servers now reach your phone through Dray's own relay, which reconnects
  faster after a drop. Each server has a new address, so scan its pairing
  code again on your phone, and add it again on your other Macs.
  ![](changelog/relay-pair.png)
  <!-- highlight: desktop · action: Open Servers settings → settings/servers -->
```

Copy `apps/desktop/demo/whats-new/relay-pair-white.png` to
`apps/web/public/changelog/relay-pair.png`: What's New draws white cards. The
page shows the title and the action alone, so the title carries the whole
message. The picture is drawn in
[whatsNewIllustrations.tsx](../desktop/src/demo/whatsNewIllustrations.tsx)
(`?art=relay-pair`) in the brand look, its QR a block that pairs with nothing.

## Deploy on Railway

Nothing here is created yet; this is the list.

1. **Service** from this repo, root directory the repo root, config file
   `apps/relay/railway.json` (Dockerfile build, `/healthz` check, one replica).
2. **Networking**: an HTTP domain `relay.drayhq.com` on port `8080` (`PORT`),
   and a **TCP proxy** on internal port `7443`. Note the proxy's host and port,
   e.g. `xxxx.proxy.rlwy.net:41234`.
3. **Cloudflare DNS** (drayhq.com): `relay` as Railway's HTTP domain asks.
   The relay writes the rest itself: `*.<id>.relay` CNAME to the proxy host,
   DNS only, per server on its first certificate, and the `_acme-challenge`
   TXT records.
4. **Variables**:

   | Variable | Value |
   |---|---|
   | `RELAY_ZONE` | `relay.drayhq.com` |
   | `RELAY_PUBLIC_PORT` | the TCP proxy's public port |
   | `RELAY_VISITOR_TARGET` | the TCP proxy's host |
   | `VISITOR_PORT` | `7443` (the image's default) |
   | `RELAY_KEYS` | `yogesh:<random ≥16 chars>,<name>:<key>,…` |
   | `CLOUDFLARE_API_TOKEN` | a token with Zone → DNS → Edit on drayhq.com |
   | `CLOUDFLARE_ZONE_ID` | drayhq.com's zone id |
   | `ACME_DIRECTORY` | optional; Let's Encrypt staging for a first try: `https://acme-staging-v02.api.letsencrypt.org/directory` |
   | `ACME_ACCOUNT_JSON` | optional; else a fresh account each start |

   `PORT` is Railway's own. `RELAY_DEV_CA`, `ACME_ROOT_CERT`,
   `CLOUDFLARE_API_BASE`, `RELAY_DOH=off` and `RELAY_OPEN=1` are for tests
   only.
5. **Check**: `curl https://relay.drayhq.com/healthz`, then turn it on for one
   server and watch `bridge.attach` and `cert.issued` in Railway's log.

**Regions later**: bridges live in one process's memory, so a second replica
must not share the hostname. A region is its own service with its own TCP
proxy and zone (`<route>.<id>.eu.relay.drayhq.com`), the server choosing one
by URL; nothing in the wire changes.

## Testing

`cargo test` here and in `crates/dray-relay`. End to end on Linux, with sudo:
[test/](test/) holds a network namespace for the server
([netns.sh](test/netns.sh)), a probe that opens a fresh connection through
the relay every second the way a phone reconnects ([probe.py](test/probe.py)),
drops stamped into a log ([scenario.sh](test/scenario.sh)), and the timings
read back ([recovery.py](test/recovery.py)).
[fake_cloudflare.py](test/fake_cloudflare.py) runs the ACME path against
Pebble.
