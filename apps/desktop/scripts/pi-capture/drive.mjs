// Capture harness: spawn `pi --mode rpc`, tee BOTH directions into one wrapped
// JSONL file, play a scripted scenario. Same shape CODEX-PLAN.md §9 asks for.
import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import fs from "node:fs";

const [, , outFile, scenarioFile] = process.argv;

// Scenarios name paths as ${VAR} so one file works on any machine. PI_BIN,
// PROBE and NODE_BIN are the three that matter; see README.md.
const raw = fs
  .readFileSync(scenarioFile, "utf8")
  .replace(/\$\{(\w+)\}/g, (m, name) => process.env[name] ?? m);
const scenario = JSON.parse(raw);
const cwd = scenario.cwd || process.cwd();
const args = ["--mode", "rpc", ...(scenario.args || [])];
const out = fs.createWriteStream(outFile);

const child = spawn(scenario.bin || "pi", args, {
  cwd,
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env, ...(scenario.env || {}) },
});
const started = Date.now();
const rec = (dir, line) =>
  out.write(JSON.stringify({ dir, t: Date.now() - started, line }) + "\n");

// Strict LF framing. Deliberately not readline: the docs warn it also splits on
// U+2028/U+2029, which are legal inside JSON strings.
function jsonl(stream, onLine) {
  const dec = new StringDecoder("utf8");
  let buf = "";
  stream.on("data", (c) => {
    buf += typeof c === "string" ? c : dec.write(c);
    for (;;) {
      const i = buf.indexOf("\n");
      if (i === -1) break;
      let l = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (l.endsWith("\r")) l = l.slice(0, -1);
      if (l.length) onLine(l);
    }
  });
}

const seen = [];
jsonl(child.stdout, (l) => {
  rec("out", l);
  seen.push(l);
  try {
    const e = JSON.parse(l);
    console.error(
      "<<",
      e.type,
      e.command || e.assistantMessageEvent?.type || e.method || e.toolName || "",
    );
  } catch {
    console.error("<< UNPARSEABLE", l.slice(0, 160));
  }
});
child.stderr.on("data", (d) => {
  const s = d.toString();
  rec("err", s);
  process.stderr.write("!! " + s);
});

const send = (o) => {
  const l = JSON.stringify(o);
  rec("in", l);
  console.error(">>", o.type);
  child.stdin.write(l + "\n");
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (pred, ms) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    for (const l of seen) {
      try {
        if (pred(JSON.parse(l))) return true;
      } catch {}
    }
    await sleep(80);
  }
  return false;
};

for (const step of scenario.steps) {
  if (step.send) send(step.send);
  if (step.sleep) await sleep(step.sleep);
  if (step.waitFor) {
    const ok = await waitFor(
      (e) => Object.entries(step.waitFor).every(([k, v]) => e[k] === v),
      step.timeout || 180000,
    );
    console.error(
      ok
        ? `-- saw ${JSON.stringify(step.waitFor)}`
        : `-- TIMEOUT ${JSON.stringify(step.waitFor)}`,
    );
  }
  // Answer any extension_ui_request that is still unanswered, if asked to.
  if (step.answerUi) {
    const answered = new Set();
    for (const l of seen) {
      try {
        const e = JSON.parse(l);
        if (e.type === "extension_ui_request" && e.id && !answered.has(e.id)) {
          answered.add(e.id);
          if (["select", "confirm", "input", "editor"].includes(e.method)) {
            send({ type: "extension_ui_response", id: e.id, ...step.answerUi });
          }
        }
      } catch {}
    }
  }
}
await sleep(600);
child.stdin.end();
child.kill("SIGTERM");
await sleep(400);
out.end();
console.error(`\n== ${seen.length} out-lines -> ${outFile}`);
process.exit(0);
