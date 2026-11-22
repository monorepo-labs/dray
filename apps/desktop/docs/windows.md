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
- The CLI ships in no Windows bundle and nothing copies it onto `PATH`, so an agent in the release app has no `dray`. `dray server install|start` and `dray update` are systemd/launchd and `install.sh`.
- `release.yml` has no Windows job, no code signing (SmartScreen warns) and no updater manifest entry.
- A refused upload reads as a reset connection, not 401: the server answers before reading the body and Windows resets a socket closed with unread data.

## Building and testing on a VM

- Toolchain: Git, rustup (MSVC), Visual Studio Build Tools with the C++ workload, Node, pnpm, CMake and LLVM (transcribe-cpp's ggml). WebView2 ships with Windows.
- `pnpm tauri dev` works as everywhere. `pnpm tauri build` makes the MSI and NSIS installers; without the updater key, pass a `--config` file holding `{"bundle":{"createUpdaterArtifacts":false}}`.
- `cargo test --no-default-features --features serve --lib` passes on Windows; tests that spawn `sh`, `cat` or `sleep`, or build `/`-paths, are `#[cfg(unix)]`.
- **A GUI started over SSH has no desktop.** Run it in the logged-in RDP session through a scheduled task with an interactive principal (`New-ScheduledTaskPrincipal -LogonType Interactive`), and screenshot the same way (`CopyFromScreen`).
- **Driving the dev app**: Tauri's own WebView2 arguments override `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS`, so the dev shim passes that variable on; set it to `--remote-debugging-port=9222` and DevTools' protocol on that port clicks, types and screenshots the webview.
