# Stage 2: installing Dray on a VPS

monorepo-labs/dray#415, flow A. The user SSHes into a fresh Linux box and pastes
the line that already installs the CLI:

```bash
curl -fsSL https://www.drayhq.com/install.sh | sh
```

On Linux that line now leaves a whole Dray behind: `dray`, `dray-serve`, the
tools the reader ticked, a server running in the background, and the line to
paste into the app.

## Release

**One archive per target, one tag.** `release-cli.yml` already builds `dray`
for both Linux arches. The Linux legs also build `dray-serve` from
`apps/desktop/src-tauri` (`--no-default-features --features serve`) and pack it
into the same `dray-<target>.tar.gz`. One download, one checksum, so the two
binaries can only ever arrive at one version. The macOS archives are unchanged,
so `dray update` from the Mac app downloads what it does today.

**Linux legs move to `ubuntu-22.04` / `ubuntu-22.04-arm`.** A binary needs the
glibc it was linked against or newer; `ubuntu-latest` is 24.04 (glibc 2.39), so
today's Linux `dray` refuses to run on Ubuntu 22.04 and Debian 12. Building on
22.04 sets the floor at glibc 2.35. musl was the other route and is not worth
it for the core's C dependencies.

Nothing else moves: `cli-v*` tags, `prerelease: false`, the resolver, the
tag-matches-crate check.

## install.sh

After the binaries land, on Linux and not under `dray update`, it runs
`dray setup`. Whatever is in the archive is installed, so the script stays one
code path for both platforms.

`dray update` sets `DRAY_UPDATING=1` so the installer neither runs setup nor
restarts the server. Restarting kills every running agent, and the usual caller
of `dray update` is an agent inside that server. It prints the restart command
instead when a service is installed.

`dray setup` gets `/dev/null` as stdin. Under `curl | sh` stdin is the rest of
the script, and a child reading it eats the installer.

## The `dray` binary

Three new subcommands. None talks to the app socket and none changes the wire,
so no protocol bump.

- **`dray serve [args]`** execs `dray-serve` beside itself.
- **`dray setup [--install <names>]`**:
  1. Lists what is present: `git`, `gh`, `claude`, `codex`, `pi`, `fx`, `grok`.
     Found = on `PATH` or in `~/.local/bin` and the few dirs vendor installers
     use.
  2. Offers what is missing as a multi-select in the `npx skills` style, read
     from `/dev/tty`. Arrow keys, space, enter; `git` preselected because Dray
     needs it. No terminal: installs only what `--install` names.
  3. Agents: the vendor's own script, off `dray_proto::AGENTS`, which a test
     in `harness.rs` holds equal to `Harness::install_command` and
     `login_command` (the CLI cannot link the app). `gh`: its release tarball
     into `~/.local/bin`, checksum verified.
     `git`: the package manager when root or `sudo -n` works, else print the
     command and move on.
  4. Prints the logins still to do: `gh auth login` when `gh auth status`
     fails, and each installed agent's login command.
  5. Runs `dray service start`.
  6. Prints `ssh user@address`, read off `SSH_CONNECTION` (the address the
     reader actually connected to; `-p` when not 22), falling back to the
     hostname.
- **`dray service start | status | uninstall`**: a systemd user unit
  `dray.service` plus `loginctl enable-linger`, so it survives logout and
  reboot. `PATH` is captured at start into the unit, with `dray`'s own dir
  first, so agents find what the reader's shell finds. No systemd: say so and
  name `dray serve` under tmux as the fallback.

## Not here

Stage 4's side: the app reading `serve-token` over SSH, port forwarding, starting
a stopped server. A Mac as a server is a stage 7 item with its design open. On
macOS `dray setup` still offers missing agents, `git` and `gh`, and neither
offers nor claims a background server.

## What testing found

- **Grok's installer is bash.** `curl … | sh` fails under dash, Ubuntu's
  `/bin/sh`, so both tables now say `| bash`. The app's missing-CLI notice was
  handing Linux readers the broken line too.
- **pi and Grok land outside `~/.local/bin`** (`~/.pi/agent/bin`,
  `~/.grok/bin`), reaching `PATH` only through `.bashrc`, which a
  non-interactive login shell never reads. So the unit's `PATH` names every
  agent dir whether it exists yet or not, and the server found all five.
- **Vendor installers ask their own questions.** Codex offers to start itself
  (default No). pi offers to install Node, then to start pi (default Yes), so a
  reader pressing Enter lands in pi's TUI and setup carries on when they leave
  it. Left as the vendors wrote them.
- **One server per machine.** `dray-serve` binds `127.0.0.1:7317`, so a second
  user's server cannot start. Setup now checks the service stayed up and says
  so rather than claiming it runs. Stage 4 can read a port if this matters.
- **Linger without sudo is refused** on Ubuntu 24.04; setup then prints the
  `sudo loginctl enable-linger` line.
- **A NAT'd VM** sees its private address in `SSH_CONNECTION`, so the Add server
  line carries a note to use the address the reader actually typed.

## Testing

OrbStack machines (systemd inside): Ubuntu 24.04 on arm64 and amd64. The
installer run end to end from a copy pointed at local archives, a reboot of the
machine, the server answering afterwards. Then the real VPS.
