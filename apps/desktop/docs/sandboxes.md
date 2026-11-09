# Sandboxes

A sandbox is a server that stops on a timer. Dray asks its provider about it rather than guessing from a dead connection (#790, #800). [sandbox.rs](../src-tauri/src/sandbox.rs) is the one place that names each provider: `Link` answers `info`, `resume` and `extend` for whichever one a saved machine is. `servers.rs` decides what to do with the answers, and the card, the island pill, auto-extend and the composer's resume-on-send are one UI for all of them. Boat's own rules live in [boat.md](boat.md); they still hold.

**Two providers, and two left out on purpose.** Boat and Vercel stop, keep their disk, come back and take more time, which is what this UI is built around. Modal has no resume (terminate is final), no extend and no REST API, only a gRPC SDK. Cloudflare's Sandbox SDK has no hosted way to make a sandbox at all: each user deploys a Worker of their own first. Daytona fits and is next: SSH through its gateway with a token Dray mints per connect, and `DAYTONA_SANDBOX_ID` on the login.

**Adopt, never create.** Dray handles sandboxes the reader made. It never creates, stops or deletes one.

**A provider's login is the reader's own CLI's, read per call and never stored.** No CLI or no login means no sandbox UI and nothing said, as for boat.

**Each provider keeps its own key in `servers.json`**: `boat`, `vercel`. A kind field on one shared key was the rejected shape: an older build would read a Vercel name as a boat id and ask boat about it. A key it cannot spell rides `Saved.unknown` back untouched.

**Wire names stay boat's.** `resume_boat`, `extend_boat` and `boat_alerts` are what the island and the iOS app call and read, and the alert carries nothing provider-specific, so a Vercel sandbox's warning reaches the island with no Swift change. `ServerInfo.sandbox` carries `provider` for the words the app says.

**Extend sets the time left, for every provider.** That is what boat's `--ttl` does, and what the card, the island's stepper and auto-extend say. Vercel only adds, so `vercel::extend` adds the difference to the running session and sets the sandbox's `timeout`, which is every later session's length. One already running longer is left alone. The stepper stops at the provider's cap: 24 hours for Vercel, where Hobby's 45 minutes is a refusal the card shows.

## Vercel

**Vercel has no SSH, so Dray reaches a sandbox by its server's own Remote access address.** That address is kept in `~/.dray/opentunnel` on the sandbox's disk, which a persistent sandbox (the default) keeps across a stop, so it is the same address after every resume. Measured: same address back within 20s of a restart. Vercel's own port URLs were the rejected route: its docs warn their WebSockets drop.

**Nothing in a sandbox keeps Dray's server running.** No systemd, and a resume kills every process. So Dray starts it through `sandbox exec`, and the rule is "running but not answering": `sandbox_step` starts the server whenever Vercel says the sandbox runs and the address won't admit. That covers a resume from Dray, from a terminal, from the dashboard, and a server that crashed. A plain `&` is enough: `exec` returning leaves it running under the sandbox's init. The image has no `pgrep`, `nohup` or `setsid`, so the script checks with `ps`. `start_server` answering `false` (already up) keeps a failing admit from re-running it every retry.

**A sandbox is added from the reader's list, never typed.** Nothing inside one names it, so it cannot be recognised off a login the way boat is. Vercel lists sandboxes per project only, so `vercel::list` walks every team and project the login sees, at once. `bring_up` then resumes it if stopped, installs Dray if absent, starts the server and turns Remote access on with the hidden `dray tunnel`, since `dray service tunnel on` asks systemd first. Every step is a no-op where already done, so adding the same sandbox again is safe.

**The token is the `sandbox` CLI's, in `com.vercel.cli/auth.json`, and only the CLI refreshes it.** It lasts 8 hours. A refresh rotates the refresh token and rewrites that file, so refreshing here would log the CLI out. One about to lapse is refreshed by running `sandbox ls`, which refreshes as any command starts, under a lock so one runs at a time. A refresh that fails makes the CLI ask for a login, which with no terminal times out, and leaves no UI. `vercel login`'s token is never read: it can live in the keychain.

**The CLI is a Node script**, `#!/usr/bin/env node`. Finder hands an app launchd's `PATH`, so every run puts the script's own directory and node's first (`binpath::node_path`).

**The API spells its scope two ways.** The list takes `project`, every call on one sandbox takes `projectId`, both with `teamId`. State is `sandbox.status`, the stop is `sandbox.expiresAt` in **milliseconds**, absent while stopped, and an extend names `currentSessionId`, which changes on every resume.

**Sign-ins run in `sandbox exec -i`, Vercel's own interactive shell**, where any other server opens `ssh -t`. `-i` refuses anything but a real terminal, which is what Terminal is.

**`exec`'s output starts by echoing the command**, script and all, on stderr. Only a line *starting* `DRAY-VERCEL ` is read as an answer, and a failure's reason is stderr's last line that is not that echo: stdout's last line was "Downloading dray…" over a 504.

**A sandbox just started or resumed answers its first GitHub download with a 504 for a while**, measured four times in six, after which the same download took 0.06s. So `bring_up` runs the install up to five times, ten seconds apart; it is a no-op once Dray is there.

**`sandbox exec` on a stopped sandbox resumes it.** Nothing runs `exec` on its own against a sandbox Vercel reports stopped, or a stopped row would wake itself and run up the reader's bill. A sign-in the reader opens does wake it, which is what they asked for.

**`brings_up_a_live_sandbox`** is the ignored test that runs `bring_up` against a real one: `DRAY_TEST_VERCEL="name team_… prj_…"`. Stop it first to cover the resume and that first download.
