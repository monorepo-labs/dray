# Stage 4: connecting the app to a VPS over SSH

monorepo-labs/dray#415, stage 4. Stage 3 ([SERVERS-PLAN.md](SERVERS-PLAN.md))
holds a remote server as an address plus a token. Today a reader gets there by
running `ssh -N -L …` in a terminal and copying `~/.dray/serve-token` by hand.
This removes both steps: Add server takes the line they would type, `ssh
user@address`, and the app does the rest.

## What is stored

`servers.json` gains two fields on an entry:

- `ssh: {dest, port?}` — the destination as typed (`user@host` or a
  `~/.ssh/config` alias) and `-p` if given. Nothing else. No key, no password,
  no token: the token is read over the login at every connect, so a rotated
  token needs nothing from the reader.
- `off: bool` — the reader turned the connection off. The row stays, the app
  stops connecting. Applies to both kinds of server.

An SSH server has no `url` saved; its address is the forwarded port, which is
picked fresh at each connect and lives in memory.

## The line

Accepted: `ssh user@host`, `ssh -p 2222 user@host`, `ssh -p2222 alias`, the same
without `ssh`. Anything else (`-i`, `-J`, `-o`) is refused with "put it under a
`Host` in ~/.ssh/config and use that name" — the reader's own config is the one
place ssh options belong, and every `ssh` the app runs reads it. A destination
starting with `-` is refused, since it would parse as a flag.

## One ssh process per connect

```text
ssh -o BatchMode=yes -o ConnectTimeout=10 -o ExitOnForwardFailure=yes
    -o ServerAliveInterval=15 -o ServerAliveCountMax=3
    -L 127.0.0.1:<free>:127.0.0.1:7317 [-p N] -- <dest>  "sh -c '<script>'"
```

The same login carries the tunnel and a short script, which prints marker
lines on stdout and then `exec cat`s, so the session stays open while the app
holds its stdin and closes if the app dies:

```text
DRAY-SSH hello      logged in                    → "Finding the server"
DRAY-SSH missing    no dray on PATH or ~/.local/bin
DRAY-SSH starting   systemd says stopped         → "Starting the server"
DRAY-SSH failed     dray service start refused; its output follows
DRAY-SSH notoken    no ~/.dray/serve-token
DRAY-SSH token <t>  done; open the WebSocket
```

`dray service start` runs only when `systemctl --user is-active dray` says no
and a user systemd exists. It is idempotent, but it sleeps 1.5s to check the
server stayed up, which is not worth paying on every connect. A server started
by hand under tmux (no systemd) is just tried.

`BatchMode=yes` means ssh never stops on a prompt. Host keys are checked the
way the reader's config says; the app never passes `StrictHostKeyChecking`.

## Tied into `servers.rs`

`run` is the one loop for both kinds. An SSH server's iteration opens the
tunnel, reads the token, then hands `ws://127.0.0.1:<free>` and the token to
the existing `admit` and `serve`. When `serve` returns — the socket closed,
which is also what an ssh exit does to a forwarded connection — the ssh child
is dropped (`kill_on_drop`) and the loop goes round with the backoff it already
has. So a cut pipe is the Stage 3 reconnect plus a fresh `ssh`.

**Some failures stop the loop instead of retrying**: a key ssh would not
accept, an unknown or changed host key, Dray not installed, no token. Retrying
those every 10s fixes nothing and, for a refused key, is exactly what
fail2ban bans. The row parks on the problem and waits for Try again (or the
toggle, which is the same command). Network failures — no route, timeout, refused — keep retrying, since
a Mac waking from sleep is the common case.

`fetch_file` reads the address and token the live connection was admitted
with, for both kinds, rather than `servers.json` and the credential store.

## Stages and failures on screen

`ServerInfo` gains `stage` (connecting, finding, starting) while connecting and
`problem` once it failed:

| problem | from | shown as |
|---|---|---|
| `needs_key` | `Permission denied` | "Set up a key first" + `ssh-copy-id [-p N] dest` to copy |
| `unknown_host` | `Host key verification failed` | host-key dialog |
| `changed_host` | `REMOTE HOST IDENTIFICATION HAS CHANGED` | ssh's warning in its words + `ssh-keygen -R host` to copy |
| `not_installed` | `DRAY-SSH missing` | "Dray isn't installed there" + the install line to copy |
| `other` | everything else | ssh's last stderr line, or the script's output |

## First meeting: the host-key dialog

ssh in BatchMode only says the key is unknown, not what it is. So the app
resolves the destination through `ssh -G` (hostname, port, `HostKeyAlias`,
first `UserKnownHostsFile`), runs `ssh-keyscan` against it,
and shows the fingerprint ssh would show (`ssh-keygen -lf`), ED25519 first.

Accept sends back the fingerprint the reader saw. The app scans again, checks
the fingerprint still matches, and appends the scanned lines to the known-hosts
file under the name ssh would write (`[host]:port` off 22; unhashed, which
ssh reads whatever `HashKnownHosts` says). Then it connects. Only the key shown
is written, so ssh insists on that one. A key that
changed between showing and accepting is refused. `ProxyJump` hosts cannot be
scanned this way and say so: connect once with `ssh` in a terminal.

## Add server

The dialog opens on the SSH line. "Use an address and token instead" switches
to Stage 3's form. Adding runs one connect without saving, drawing its stages
(Connecting, Finding the server, Starting the server), and saves only once the
server admitted it — the token form's rule. A problem is drawn in the dialog
with its action; the host-key question opens over it and Accept retries.
Re-adding a destination already listed updates its name.

## Servers page

Each remote row: status dot, name, `ssh user@host` or the address, the stage or
the problem with its action, a switch for on/off, and Remove.

## Accounts per server

With remote servers, the Accounts tab has a server picker (default: the
selected session's server). Reads and writes route to that server explicitly
— today `add_agent_account` and `sign_out_agent` carry no path and went to the
local core even for a remote session. Sign in on an SSH server runs, in
Terminal through the same `.command` route,

```text
ssh -t [-p N] -- dest "sh -c 'PATH=\"\$HOME/.local/bin:…:\$PATH\"; exec <command>'"
```

with the command looked up in `auth_options` exactly as `run_agent_login`
does, and the PATH naming the dirs `dray setup` installs agents into. A server
added by address has no login to borrow, so its Sign in shows the command to
run there.

## Testing

Live, from ignored tests in `ssh.rs` and `servers.rs` (each names its env var):

- Against the VPS as root: add, `list_projects` through the tunnel, the `ssh`
  process killed and the loop back up in about 4s, off and on, no token in
  `credentials.json`. A server stopped with `systemctl --user stop dray` was
  started by the app and connected in 2.3s.
- As a non-root user (`dray-test`, linger on, installed by the install line
  over its own login): the install's server could not start beside root's on
  7317; with root's stopped, the app started the user's failed unit, connected,
  and survived a killed pipe and off/on. Root's server was put back after.
- Unknown host: the VPS by a `nip.io` name `known_hosts` does not list. A wrong
  fingerprint is refused, the shown one is written and the connect succeeds;
  its ED25519 fingerprint matched the IP's existing entry.
- A user with no key (`Permission denied (publickey,password)`), a name that
  does not resolve, an address that times out, and an OrbStack machine with no
  Dray each say their own sentence; only the last two retry.
- The Sign in line run with `--version`: Claude Code found in `~/.local/bin`
  over a non-login shell; the agents not installed there answer 127.

## Not here

Stage 4b (installing Dray through the app). A second port when 7317 is taken
by another user's server on one machine.
