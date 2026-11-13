import { spawn } from "node:child_process";
import { createServer } from "node:net";

/// `next dev` for a test file. Next 16 allows one dev server per directory, so
/// `pnpm test` runs files one at a time.

async function freePort() {
  const server = createServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  await new Promise((r) => server.close(r));
  return port;
}

/// Starts `next dev` with `env` and waits until it answers.
export async function next(env) {
  const port = await freePort();
  const child = spawn("node_modules/.bin/next", ["dev", "-p", String(port), "-H", "127.0.0.1"], {
    cwd: new URL("..", import.meta.url),
    env: { ...process.env, ...env, NEXT_TELEMETRY_DISABLED: "1" },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  let log = "";
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 240; i++) {
    if (child.exitCode !== null) throw new Error(`next dev exited:\n${log}`);
    try {
      await fetch(`${base}/api/cloud/machines`);
      const stop = () => {
        const exited = new Promise((r) => child.once("exit", r));
        process.kill(-child.pid, "SIGTERM");
        return exited;
      };
      return { base, log: () => log, stop };
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  child.kill();
  throw new Error(`next dev never answered:\n${log}`);
}
