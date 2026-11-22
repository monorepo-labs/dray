#!/usr/bin/env node
// `pnpm tauri` shim. The Tauri CLI merges an extra config only when it is named
// on the command line, and the name has to be per-subcommand — so `dev` gets the
// dev flavour (its own product name and icon) while `build` stays untouched.
//
// It also picks the dev server's port, because Vite and Tauri have to agree on
// one and only this side can choose it before either starts.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";

/// A port nothing holds, from the OS: `listen(0)` hands out one no socket on
/// any address is using, which a probe of our own got wrong across two
/// loopback families. Released before Vite takes it; ephemeral ports are not
/// re-issued that fast.
function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

const args = process.argv.slice(2);
const env = { ...process.env };

if (args[0] === "dev" && !args.some((a) => a === "-c" || a === "--config")) {
  // A fixed 1420 was one worktree's dev build refusing to start because
  // another's held it. `strictPort` on the Vite side still holds: the port is
  // known free, and Vite wandering off it leaves Tauri loading a URL nothing
  // serves.
  const port = await freePort();
  // Read by `vite.config.ts` for the server it starts, and handed to Tauri as
  // the URL it loads. Both from this one value, so they cannot disagree.
  env.DRAY_DEV_PORT = String(port);
  console.log(`  Info dev server on port ${port}`);
  // Merged in order, so the port lands over whatever the dev flavour says.
  args.push("--config", "src-tauri/tauri.dev.conf.json");
  args.push("--config", JSON.stringify({ build: { devUrl: `http://localhost:${port}` } }));
  // Linux's and Windows' window is opaque and undecorated
  // (tauri.linux.conf.json, tauri.windows.conf.json), but the dev flavour
  // restates the window list whole after it, which brings back the Mac's
  // transparency and the system's bar.
  if (process.platform === "linux" || process.platform === "win32") {
    const { app } = JSON.parse(readFileSync("src-tauri/tauri.dev.conf.json", "utf8"));
    // Tauri hands WebView2 browser args of its own, which win over the
    // `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` that would otherwise turn on
    // DevTools' port for driving the app in a test. Passed on beside Tauri's.
    const extra = process.platform === "win32" && env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS;
    const browserArgs = extra
      ? { additionalBrowserArgs: `--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection ${extra}` }
      : {};
    const windows = app.windows.map((w) => ({ ...w, transparent: false, decorations: false, ...browserArgs }));
    args.push("--config", JSON.stringify({ app: { windows } }));
  }
}

// The CLI's own script under this node, not the `tauri` bin: on Windows that
// is a `.cmd` shim, which node spawns only through a shell, and cmd.exe would
// then have to quote the JSON configs above.
const cli = createRequire(import.meta.url).resolve("@tauri-apps/cli/tauri.js");
const child = spawn(process.execPath, [cli, ...args], { stdio: "inherit", env });
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});
