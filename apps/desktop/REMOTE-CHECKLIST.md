# Dray anywhere: checklist

Goal: Dray runs on any machine (a VPS, a Mac), and any GUI connects to it. No TUI. One stage at a time; everything below the current stage can wait.

Issues: #413 (stage 1), #415 (stages 2 and 4, draft), #414 (stage 3). Stage 2's plan is [SETUP-PLAN.md](SETUP-PLAN.md).

## How clients connect (settled)

- **Now: SSH**, desktop app to VPS. Direct, free, nothing for us to run. The app runs the Mac's own `ssh`; Dray never sees the key.
- **Also: a Cloudflare quick tunnel** (#452), no SSH and no account. The address changes when the tunnel restarts; the token does not. Plan in [TUNNEL-PLAN.md](TUNNEL-PLAN.md).
- **Later: our own relay** on Cloudflare, with sign-in and a QR code, for the phone, which cannot use SSH. Encrypt end to end.
- **Never required:** Tailscale.
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

Plan and what testing found: [SSH-PLAN.md](SSH-PLAN.md). Also: a server can be turned off without removing it, and renamed.

- [x] Paste the SSH line (`ssh user@address`) into Add server, optional name
- [x] App connects through that login; no port opened, no password stored
- [x] App starts the server if it is installed but stopped
- [x] SSH asks for a password: say "set up a key first", show `ssh-copy-id`
- [x] First meeting with a server: show SSH's "is this the right server" question in a dialog
- [x] Accounts tab shows logins per server; Sign in opens Terminal on the VPS running that login

## Stage 4b: Setting up through the app (flow B)

Same installer as stage 2, with dialogs on top.

- [ ] Dray not on the server: "Install it?" and an Install button
- [ ] The pick-list drawn as a dialog in the app
- [ ] Logins listed with Sign in buttons (the Accounts tab's)

## Stage 5: Projects on a VPS

#422. Plan in `ATTACH-PLAN.md`.

- [x] Attach project opens a dialog: GitHub repos read through `gh` on the chosen server, with search
- [x] Repos already cloned or attached marked and listed first; picking one attaches without cloning
- [x] Pick → `gh repo clone` into `~/dray/<repo>` on that machine → attach, progress on screen, failure in gh's words
- [x] `~/dray/<repo>` holding something else is refused in plain words
- [x] A path field for anything else, checked to exist on that server; Choose folder on the Mac
- [x] No `gh`, or not logged in, on that server: the PR panel's reading, with the command to run there
- [ ] A clone and a session on a Linux server with `gh` logged in

## Stage 6: The browser on a VPS

- [x] Agent's browser runs headless on the VPS
- [x] Dev servers viewed from the Mac through a forwarded port
- No live streaming planned.

## Stage 7: More ways to use it

- [x] Reach a Linux server through a Cloudflare quick tunnel, no SSH: `dray tunnel`, `dray service tunnel on` (#452)
- [x] Reach a Mac through a quick tunnel: the app itself serves, turned on from the This Mac row (#452)
- [x] The Mac's sessions run in a background server and keep running when Dray quits (#456, [MAC-SERVER-PLAN.md](MAC-SERVER-PLAN.md))
- [ ] Check on a signed beta: the release agent reads `~/Documents` with no second prompt, and an update restarts the server
- [ ] Our own relay: sign-in, QR code, stable address, end-to-end encryption
- [ ] Phone
- [ ] Linux and Windows apps

## Dropped

- A TUI.
- A browser version of the UI. Dray is an app; the clients are the Mac app, later a phone app and Linux/Windows apps.
- Reading transcripts from the CLI. Using Dray needs a GUI.
- Connecting from the CLI on another machine.
