#!/usr/bin/env node
// Connects to a Dray Cloud machine the way the app does and fails unless it is
// one a task can run on (#1011). cloud-snapshot.sh runs it against a machine
// made from a candidate snapshot, before `dray-cloud` moves to that snapshot.
//
//   DRAY_VERIFY_TOKEN=… node cloud-verify.mjs <wss-url> <protocol> [cli-v tag]
//
// Passes when the hello is admitted, the welcome names the tag (where one is
// given) and is not stale, and the machine reports every agent in AGENTS
// installed. Waits up to DEADLINE for the server and boat's relay to come up:
// the URL answers 502 until both have.

const AGENTS = ["claude_code", "codex"];
const DEADLINE = 180_000;

const [url, protocol, tag] = process.argv.slice(2);
// The welcome names the version alone, without the tag's prefix.
const release = tag?.replace(/^cli-v/, "");
const token = process.env.DRAY_VERIFY_TOKEN;
if (!url || !protocol || !token) {
  console.error("usage: DRAY_VERIFY_TOKEN=… cloud-verify.mjs <wss-url> <protocol> [cli-v tag]");
  process.exit(2);
}
if (typeof WebSocket !== "function") {
  console.error("cloud-verify: needs Node 22 or newer, for its built-in WebSocket");
  process.exit(2);
}

/// A failure retrying cannot change: the server answered and said no.
class Refused extends Error {}

/// One attempt. Resolves with what the machine said, rejects with why not.
function attempt() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let welcome = null;
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error("no answer in 20s"));
    }, 20_000);
    const done = (fn, value) => {
      clearTimeout(timer);
      ws.close();
      fn(value);
    };
    ws.onopen = () => ws.send(JSON.stringify({ v: Number(protocol), token }));
    ws.onerror = () => done(reject, new Error("could not connect"));
    ws.onclose = () => done(reject, new Error("closed before answering"));
    ws.onmessage = (msg) => {
      if (typeof msg.data !== "string") return;
      const frame = JSON.parse(msg.data);
      if (!welcome) {
        if (frame.err) return done(reject, new Refused(`refused: ${frame.err}`));
        welcome = frame;
        // Before the snapshot frame and every event: nothing past the welcome
        // is read until this call answers.
        ws.send(JSON.stringify({ id: 1, cmd: "agent_availability" }));
        return;
      }
      if (frame.id !== 1) return;
      if (frame.err) return done(reject, new Refused(`agent_availability failed: ${JSON.stringify(frame.err)}`));
      done(resolve, { welcome, agents: frame.ok });
    };
  });
}

const until = Date.now() + DEADLINE;
let answer;
for (;;) {
  try {
    answer = await attempt();
    break;
  } catch (e) {
    if (e instanceof Refused || Date.now() > until) {
      console.error(`cloud-verify: ${e.message}`);
      process.exit(1);
    }
    console.log(`  waiting for the machine: ${e.message}`);
    await new Promise((r) => setTimeout(r, 5000));
  }
}

const { welcome, agents } = answer;
const problems = [];
if (release && welcome.release !== release) {
  problems.push(`runs release ${welcome.release ?? "(none)"}, not ${release}`);
}
if (welcome.stale) problems.push("reports its binary moved since it started");
for (const harness of AGENTS) {
  const agent = agents.find((a) => a.harness === harness);
  if (!agent?.available) problems.push(`${harness} is not installed${agent?.reason ? `: ${agent.reason}` : ""}`);
}
if (problems.length) {
  console.error(`cloud-verify: ${problems.join("; ")}`);
  process.exit(1);
}
console.log(`  connected: dray-serve ${welcome.release ?? welcome.version}, ${AGENTS.join(" and ")} installed`);
