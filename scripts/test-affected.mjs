#!/usr/bin/env node
/// Runs only the test suites this branch's changes can reach, against its
/// merge base with origin/main, uncommitted and untracked files included.
///
///   node scripts/test-affected.mjs [--base <ref>] [--dry-run] [--full]
///
/// A Rust crate runs whole when a file in it changed, or in a crate it depends
/// on through a `path` dependency. Vitest runs `related` on the changed files,
/// so only tests importing them; other JS suites run whole when their app
/// changed. A file read by path rather than imported (`include_str!`, a
/// fixture a test opens) counts as a change to whichever source names it. An
/// app's own config runs that app's suite whole; a root config or the
/// lockfile runs everything.
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, posix } from "node:path";

const args = process.argv.slice(2);
const git = (...a) => execFileSync("git", a, { encoding: "utf8" }).trim();
const lines = (s) => s.split("\n").filter(Boolean);
const root = git("rev-parse", "--show-toplevel");
process.chdir(root);

const base = args.includes("--base")
  ? args[args.indexOf("--base") + 1]
  : git("merge-base", "HEAD", "origin/main");
const changed = [
  ...new Set([
    ...lines(git("diff", "--name-only", base)),
    ...lines(git("ls-files", "--others", "--exclude-standard")),
  ]),
];
const tracked = lines(git("ls-files"));

// The GPUI rewrite is an unshipped experiment; nothing here tests it, --full included.
const skipped = ["apps/gpui"];
const suites = [
  ...tracked
    .filter((f) => f.endsWith("/Cargo.toml") && !skipped.includes(posix.dirname(f)))
    .map((f) => ({ kind: "cargo", dir: posix.dirname(f) })),
  ...tracked
    .filter((f) => /^apps\/[^/]+\/package\.json$/.test(f))
    .map((f) => ({ dir: posix.dirname(f), test: JSON.parse(readFileSync(f, "utf8")).scripts?.test }))
    .filter((s) => s.test)
    .map((s) => ({ kind: s.test.startsWith("vitest") ? "vitest" : "node", dir: s.dir })),
];
for (const s of suites) {
  s.files = new Set();
  s.deps = [];
}
const owner = (f) =>
  suites.filter((s) => f.startsWith(s.dir + "/")).sort((a, b) => b.dir.length - a.dir.length)[0];

for (const s of suites.filter((s) => s.kind === "cargo")) {
  const toml = readFileSync(join(s.dir, "Cargo.toml"), "utf8");
  for (const [, p] of toml.matchAll(/^\s*[\w-]+\s*=\s*\{[^}\n]*\bpath\s*=\s*"([^"]+)"/gm)) {
    const dep = suites.find((d) => d.dir === posix.normalize(posix.join(s.dir, p)));
    if (dep) s.deps.push(dep);
  }
}

// Paths a source file names with `../` are things it reads at build or test
// time that no import graph sees. Keyed on the part after the last `../`.
const readers = new Map();
for (const f of tracked) {
  const s = owner(f);
  if (!s || !/\.(rs|tsx?|mjs|js)$/.test(f)) continue;
  for (const [, lit] of readFileSync(f, "utf8").matchAll(/["'`]([^"'`\n]*\.\.\/[^"'`\n]*)["'`]/g)) {
    const tail = lit.slice(lit.lastIndexOf("../") + 3);
    if (!/\.\w+$|\/$/.test(tail)) continue;
    if (!readers.has(tail)) readers.set(tail, []);
    readers.get(tail).push(f);
  }
}
const readersOf = (f) =>
  [...readers].flatMap(([tail, files]) =>
    (tail.endsWith("/") ? ("/" + f).includes("/" + tail) : f === tail || f.endsWith("/" + tail)) ? files : [],
  );

// Prose counts only inside a crate, where `include_str!` makes prompts source,
// or where code names it by path, as the app's crate reads the CLI's SKILL.md.
const ignored = (f) => /\.md$|^LICENSE$|^\.github\//.test(f) && owner(f)?.kind !== "cargo";
let all = args.includes("--full");
for (const f of changed) {
  if (ignored(f)) {
    for (const r of readersOf(f)) owner(r)?.files.add(r);
    continue;
  }
  const s = owner(f);
  if (!s && !/^(apps|crates|charts)\//.test(f)) all = true;
  // An app's top-level files are its config: package.json, vite.config.ts, tsconfig.
  if (s && s.kind !== "cargo" && !f.slice(s.dir.length + 1).includes("/")) s.whole = true;
  for (const r of [f, ...readersOf(f)]) owner(r)?.files.add(r);
}

const affected = (s) => all || s.whole || s.files.size > 0 || s.deps.some(affected);
const plan = suites.filter(affected).sort((a, b) => (a.kind === "cargo") - (b.kind === "cargo"));

console.log(`base ${base.slice(0, 10)}, ${changed.length} changed file(s)${all ? ", running everything" : ""}`);
if (!plan.length) console.log("nothing to test");
const results = [];
for (const s of plan) {
  const related = s.kind === "vitest" && !all && !s.whole;
  const cmd =
    s.kind === "cargo"
      ? ["cargo", "test"]
      : related
        ? ["pnpm", "exec", "vitest", "related", "--run", "--passWithNoTests",
           ...[...s.files].map((f) => f.slice(s.dir.length + 1))]
        : ["pnpm", "run", "test"];
  console.log(`\n▶ ${s.dir}: ${cmd.join(" ")}`);
  if (args.includes("--dry-run")) continue;
  const start = Date.now();
  const { status } = spawnSync(cmd[0], cmd.slice(1), { cwd: s.dir, stdio: "inherit" });
  results.push({ dir: s.dir, ok: status === 0, secs: ((Date.now() - start) / 1000).toFixed(1) });
}
for (const r of results) console.log(`${r.ok ? "✓" : "✗"} ${r.dir} ${r.secs}s`);
process.exit(results.every((r) => r.ok) ? 0 : 1);
