# Dray anywhere: checklist

Goal: Dray runs on any machine (a VPS, a Mac), and any GUI connects to it. No TUI. One stage at a time; everything below the current stage can wait.

Issues: #413 (stage 1), #415 (stages 2 and 4, draft), #414 (stage 3). Stage 2's plan is [SETUP-PLAN.md](SETUP-PLAN.md).

## How clients connect (settled)

- **Now: SSH**, desktop app to VPS. Direct, free, nothing for us to run. The app runs the Mac's own `ssh`; Dray never sees the key.
- **Later: our own relay** on Cloudflare, with sign-in and a QR code, for the phone and the browser. Those cannot use SSH. Encrypt end to end.
- **Never required:** Tailscale, or free tunnel links that change on restart.
- The server speaks the same WebSocket whatever carries it, so the relay is a pipe added later, not a rebuild.

## Stage 1: Dray runs without the Mac app

Merged. Plan in `SERVE-PLAN.md`.

- [x] Server runs headless, on Mac and Linux
- [x] The UI can talk to it over a WebSocket
- [x] Images load from the server
- [x] Reconnect and resync, no lost events or cards
- [x] A real agent turn on Linux
- [x] Merged

## Stage 2: Installing on a VPS (flow A)

The user logs in to the VPS and pastes one install line.

Built and tested on Ubuntu 24.04 (arm64, x86_64) in OrbStack over real SSH, and on a real VPS (Ubuntu 26.04, x86_64, root): install, reboot, server reached from the Mac through an SSH forward. Still to do: one `workflow_dispatch` run of `release-cli.yml`.

- [ ] A Linux release of `dray` and `dray-serve`, one version (workflow written, not yet run)
- [x] One install line
- [x] Pick-list of what is missing: agents, `git`, `gh`
- [x] `git` needing admin rights: print the command, move on
- [x] Prints the logins still to do (agents, `gh`)
- [x] Server runs in the background by default, survives logout and reboot
- [x] Ends by printing the line to paste into the app's Add server

Settled: logging in is the user's job. The pick-list is styled after `npx skills`.

## Stage 3: The app can show more than one server

- [ ] Servers page in Settings, "Local Server" first
- [ ] Add server dialog
- [ ] Project picker grouped by server
- [ ] Dimmed `-server` suffix on remote projects in the sidebar
- [ ] `server/project/title` in the header
- [ ] A disconnected server shows dimmed, not gone

Settled: a server is a property of the project. The same repo on two machines is two projects.

## Stage 4: Connecting the app to a VPS

- [ ] Paste the SSH line (`ssh user@address`) into Add server, optional name
- [ ] App connects through that login; no port opened, no password stored
- [ ] App starts the server if it is installed but stopped
- [ ] SSH asks for a password: say "set up a key first", show `ssh-copy-id`
- [ ] First meeting with a server: show SSH's "is this the right server" question in a dialog
- [ ] Accounts tab shows logins per server; Sign in opens Terminal on the VPS running that login

## Stage 4b: Setting up through the app (flow B)

Same installer as stage 2, with dialogs on top.

- [ ] Dray not on the server: "Install it?" and an Install button
- [ ] The pick-list drawn as a dialog in the app
- [ ] Logins listed with Sign in buttons (the Accounts tab's)

## Stage 5: Projects on a VPS

- [ ] Attach a project. Idea: list the user's repos through `gh`, clone on pick. Design later.

## Stage 6: The browser on a VPS

- [ ] Agent's browser runs headless on the VPS
- [ ] Dev servers viewed from the Mac through a forwarded port
- No live streaming planned.

## Stage 7: More ways to use it

- [ ] Browser version of the UI, served by the server
- [ ] Our own relay: sign-in, QR code, stable address, end-to-end encryption
- [ ] Phone
- [ ] Linux and Windows apps
- [ ] A Mac as a server. Design open: the app itself serving, or `dray-serve` plus a launchd agent beside it (two processes on one data dir is the two-writers problem).

## Dropped

- A TUI.
- Reading transcripts from the CLI. Using Dray needs a GUI.
- Connecting from the CLI on another machine.
