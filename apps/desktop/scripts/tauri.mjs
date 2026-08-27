#!/usr/bin/env node
// `pnpm tauri` shim. The Tauri CLI merges an extra config only when it is named
// on the command line, and the name has to be per-subcommand — so `dev` gets the
// dev flavour (its own product name and icon) while `build` stays untouched.
//
// It also picks the dev server's port, because Vite and Tauri have to agree on
// one and only this side can choose it before either starts.
import { spawn } from "node:child_process";
import { createConnection } from "node:net";

const BASE_PORT = 1420;
const PORT_TRIES = 20;

/// Whether anything is already listening on `host:port`.
///
/// Asked by dialling it rather than by trying to bind it. Binding is the obvious
/// probe and it lies here: Node sets `SO_REUSEADDR`, so a wildcard bind succeeds
/// against a port a server already holds on one address — which reported 1420
/// free while Vite was listening on `[::1]:1420`, and handed back the very port
/// that had just failed.
function inUse(port, host) {
  return new Promise((resolve) => {
    const probe = createConnection({ port, host });
    const done = (answer) => {
      probe.destroy();
      resolve(answer);
    };
    probe.setTimeout(300);
    probe.once("connect", () => done(true));
    probe.once("timeout", () => done(true));
    // Refused is the one answer that means nobody is there. Anything else —
    // unreachable family, no route — says nothing about the port, and skipping
    // it costs one number out of twenty.
    probe.once("error", (err) => done(err.code !== "ECONNREFUSED"));
  });
}

/// Whether nothing holds `port` on either loopback family.
///
/// Both asked, because Vite binds `localhost` and which family that resolves to
/// is not ours to assume — a server on `[::1]` leaves `127.0.0.1` free, and a
/// probe of one family alone answers "yes" for a port Vite would then fail on.
async function isFree(port) {
  return !(await inUse(port, "127.0.0.1")) && !(await inUse(port, "::1"));
}

/// The first free port at or above [`BASE_PORT`].
///
/// A busy 1420 used to be a hard failure, which is one worktree's dev build
/// refusing to start because another's is already running — the ordinary case
/// with several sessions open, and nothing about it is worth stopping for.
/// `strictPort` on the Vite side still holds and still should: this chooses the
/// port up front, where that stops Vite wandering onto a different one than
/// Tauri was told to load.
async function pickPort() {
  for (let port = BASE_PORT; port < BASE_PORT + PORT_TRIES; port++) {
    if (await isFree(port)) return port;
  }
  throw new Error(
    `no free port in ${BASE_PORT}..${BASE_PORT + PORT_TRIES - 1} for the dev server`,
  );
}

const args = process.argv.slice(2);
const env = { ...process.env };

if (args[0] === "dev" && !args.some((a) => a === "-c" || a === "--config")) {
  const port = await pickPort();
  // Read by `vite.config.ts` for the server it starts, and handed to Tauri as
  // the URL it loads. Both from this one value, so they cannot disagree.
  env.DRAY_DEV_PORT = String(port);
  if (port !== BASE_PORT) {
    console.log(`  Info Port ${BASE_PORT} is taken; using ${port} for the dev server`);
  }
  // Merged in order, so the port lands over whatever the dev flavour says.
  args.push("--config", "src-tauri/tauri.dev.conf.json");
  args.push("--config", JSON.stringify({ build: { devUrl: `http://localhost:${port}` } }));
}

const child = spawn("tauri", args, { stdio: "inherit", env });
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});
