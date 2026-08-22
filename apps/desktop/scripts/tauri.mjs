#!/usr/bin/env node
// `pnpm tauri` shim. The Tauri CLI merges an extra config only when it is named
// on the command line, and the name has to be per-subcommand — so `dev` gets the
// dev flavour (its own product name and icon) while `build` stays untouched.
import { spawn } from "node:child_process";

const args = process.argv.slice(2);
if (args[0] === "dev" && !args.some((a) => a === "-c" || a === "--config")) {
  args.push("--config", "src-tauri/tauri.dev.conf.json");
}

const child = spawn("tauri", args, { stdio: "inherit" });
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});
