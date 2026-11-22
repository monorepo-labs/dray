# Windows

**The app, `dray` and `dray-serve` build with MSVC and run on Windows 10/11 and Server 2025** (#1425). The server is the app's child, as on Linux (`launchd::as_child`), home `~/.dray` (`%USERPROFILE%\.dray`). What differs from Unix lives in [platform.rs](../src-tauri/src/platform.rs) where it is more than a line.

## What is different

- **The orchestration socket is a named pipe.** tokio has no unix sockets on Windows. `dray_proto::pipe_name` turns the socket path into `\\.\pipe\dray-<hash>`, so `DRAY_ENDPOINT` stays a path on every platform and each home keeps its own channel. The server makes the first instance with `first_pipe_instance`, which is what refuses a second Dray on one home; there is no file to heal. The pipe takes the default ACL (the user, administrators, SYSTEM), not the `0700` directory Unix leans on.
- **One hidden console for the whole app** (`platform::hidden_console`). A release build is a GUI binary, so without it every `git`, `gh` and agent the app or its server started opened a console window — Windows Terminal, where it is the default terminal. `AllocConsoleWithOptions(NO_WINDOW)` where Windows has it (11 24H2, Server 2025), else `AllocConsole` hidden at once, which can flash. A dev build is a console binary and needs none.
- **No signals.** A server stop is `TerminateProcess`: agents get no 3s to exit. Ctrl-C reaches a server run in a console.
- **The process tree comes from ToolHelp, listeners from `GetExtendedTcpTable`** ([local_servers.rs](../src-tauri/src/local_servers.rs)). Windows keeps a dead parent's pid on its children and reuses pids, so a parent link counts only where the parent is older than the child — the walk's result is killed. A process's working directory is out of reach, so only listeners under the agent count as a session's dev servers.
- **Paths.** `canonicalize` goes through `dunce`, since std's answers `\\?\C:\…` and matches nothing git or the reader writes. Binaries resolve as `name.exe`, then npm's `name.cmd`, never the bare name: npm leaves a `sh` script of that name beside the shim. `PATH` is re-read from the registry where a login shell would be asked.
- **Git for Windows sets `core.autocrlf`.** Anything that reads back what git restored turns it off for its own calls, as the bots' folder does.
- **Window chrome is Linux's**: undecorated, opaque, drawn controls, flat surfaces (`tauri.windows.conf.json`, `useGlass`).
- **Agents run through Git Bash.** Claude Code finds it on its own; it has a PowerShell tool besides, which anything denying Bash must deny too (`title.rs`).

## Not on Windows yet

- The in-app browser (CEF builds for Mac and Linux only) and `dray browser`'s headless Chromium, whose DevTools pipe rides fds 3 and 4.
- Dictation (hidden: `HAS_DICTATION`), Dray Island, Open in (apps list is empty), the dock badge.
- `dray server install|start` and `dray update` are systemd/launchd and `install.sh`.
- Authenticode. The release is unsigned, so SmartScreen warns on the download; the switch is under _Releasing_ below.
- A Windows button on the site's downloads page.
- A refused upload reads as a reset connection, not 401: the server answers before reading the body and Windows resets a socket closed with unread data.

## Releasing

**`release.yml`'s `windows` job builds an NSIS installer and an MSI, x64**, beside the Linux job and the same way: held out of tags until the repo variable `RELEASE_WINDOWS` is `true`, built as artifacts alone on a manual run, and put into each manifest by `manifest` ([windows-release.sh](../../../.github/scripts/windows-release.sh)). On R2 each also lands as `Dray_x64-setup.exe` and `Dray_x64.msi` behind the dmg's guard.

- **The updater signs each installer**, with the minisign key the Mac and Linux use, and the app updates by running it: NSIS per user with no prompt, the MSI through `msiexec`. The manifest carries `windows-x86_64-nsis` and `windows-x86_64-msi` and never the bare `windows-x86_64` the plugin falls back to, since an MSI install handed the NSIS installer ends up installed twice.
- **A beta ships no MSI.** WiX takes a version of numbers alone and `-beta.N` is not one, so an MSI install stays on stable.
- **The binary is `dray-app.exe`** (`mainBinaryName` in [tauri.windows-release.conf.json](../src-tauri/tauri.windows-release.conf.json)). The installer finds a running app by its exe's name before replacing it, and as `dray.exe` every running `dray` CLI would count.
- **The CLI rides the bundle as `dray-cli.exe`**; the app copies it to `~/.local/bin/dray.exe` on launch and puts that folder on the user `PATH` ([orchestration.md](orchestration.md)).
- **Authenticode is one switch**: the repo variable `WINDOWS_SIGN_COMMAND` becomes the bundler's `bundle.windows.signCommand` (`%1` is the file), which signs the app, the CLI and both installers before the updater signature is taken over them. Set, the job fails unless every one carries a valid signature; the secrets the command reads go in the build step's `env`. Unset, the job runs unsigned and says so.

## Building and testing on a VM

- Toolchain: Git, rustup (MSVC), Visual Studio Build Tools with the C++ workload, Node, pnpm, CMake and LLVM (transcribe-cpp's ggml). WebView2 ships with Windows.
- `pnpm tauri dev` works as everywhere. `pnpm tauri build` makes the MSI and NSIS installers; without the updater key, pass a `--config` file holding `{"bundle":{"createUpdaterArtifacts":false}}`. The release's shape is `scripts/cli-sidecar.sh` under Git Bash, then `pnpm tauri build --config src-tauri/tauri.windows-release.conf.json`.
- **Git checks `.sh` files out LF** (`.gitattributes`): Git for Windows, a runner's included, would hand bash CRLF otherwise.
- `cargo test --no-default-features --features serve --lib` passes on Windows; tests that spawn `sh`, `cat` or `sleep`, or build `/`-paths, are `#[cfg(unix)]`.
- **A GUI started over SSH has no desktop.** Run it in the logged-in RDP session through a scheduled task with an interactive principal (`New-ScheduledTaskPrincipal -LogonType Interactive`), and screenshot the same way (`CopyFromScreen`).
- **Testing an installer on a VM another task uses**: build it with a `--config` naming another `productName` and `identifier` (and a fresh `bundle.windows.wix.upgradeCode`), or it installs over theirs, and launch it with its own `DRAY_HOME`. **An update's relaunch drops that `DRAY_HOME`**: the installer starts the new app through Explorer, with Explorer's environment, so the relaunched test app lands on `~/.dray` and the two apps restart each other's server (#495). Quit it at once (`confirm_quit` through DevTools), or test updates on a VM of your own.
- **Testing the updater locally**: sign with a throwaway key (`pnpm tauri signer generate`), put its public half and `dangerousInsecureTransportProtocol` in the test `--config`, and point `STABLE_MANIFEST` in updater.rs at a local `stable.json` in the test build alone. `check_update` then `install_update` through DevTools run the real path.
- **Driving the dev app**: Tauri's own WebView2 arguments override `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS`, so the dev shim passes that variable on; set it to `--remote-debugging-port=9222` and DevTools' protocol on that port clicks, types and screenshots the webview.
