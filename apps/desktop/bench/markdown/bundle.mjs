// Bundle cost of each markdown stack, gzipped: what the app would add or drop
// by switching. Run from apps/desktop: `node bench/markdown/bundle.mjs`.
//
// Each side is built alone, as the app's own Vite would build it, with what
// stays either way left external: React, `@pierre/diffs` (the diff view keeps
// it), and the app's own modules. Streamdown's side carries our glue —
// markdownPlugins and codePlugin — since a switch removes those too.
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { build } from "vite";

const root = fileURLToPath(new URL("../..", import.meta.url));
const work = mkdtempSync(join(tmpdir(), "md-bundle-"));

const ENTRIES = {
  streamdown: `
    export { Streamdown } from "streamdown";
    export * from "${root}src/lib/markdownPlugins.ts";
    export * from "${root}src/lib/codePlugin.ts";
  `,
  words: `
    export { Markdown } from "@pierre/words/react";
    export { createHighlightsPlugin } from "@pierre/words/highlights";
    export { escapeHtml } from "@pierre/words/html";
    export { default as pierreLight } from "@pierre/highlights/themes/pierre-light";
    export { default as pierreDark } from "@pierre/highlights/themes/pierre-dark";
    import "@pierre/words/styles.css";
  `,
  // Words with code highlighting left to the Shiki the app already ships,
  // through an adapter it does not have yet.
  "words-no-highlights": `
    export { Markdown } from "@pierre/words/react";
    export { escapeHtml } from "@pierre/words/html";
    import "@pierre/words/styles.css";
  `,
};

const external = (id) =>
  /^(react|react-dom)(\/|$)/.test(id) || /^@pierre\/diffs(\/|$)/.test(id) || id.startsWith("@/");

function files(dir) {
  return readdirSync(dir, { recursive: true })
    .map((f) => join(dir, f))
    .filter((f) => statSync(f).isFile());
}

const out = {};
for (const [name, source] of Object.entries(ENTRIES)) {
  const entry = join(root, `.md-bundle-${name}.js`);
  writeFileSync(entry, source);
  const outDir = join(work, name);
  try {
    await build({
      root,
      configFile: false,
      publicDir: false,
      logLevel: "error",
      resolve: { alias: { "@": join(root, "src") } },
      build: {
        outDir,
        emptyOutDir: true,
        minify: true,
        lib: { entry, formats: ["es"], fileName: "entry" },
        rollupOptions: { external },
      },
    });
  } finally {
    rmSync(entry);
  }
  const rows = files(outDir).map((f) => {
    const bytes = readFileSync(f);
    return { file: f.slice(outDir.length + 1), raw: bytes.length, gzip: gzipSync(bytes, { level: 9 }).length };
  });
  // Streamdown loads Mermaid only for a mermaid fence, which our chat never
  // enables; every other chunk is reached on first render.
  const initial = rows.filter((r) => !/mermaid/i.test(r.file));
  const sum = (rs, k) => rs.reduce((n, r) => n + r[k], 0);
  out[name] = {
    initialGzip: sum(initial, "gzip"),
    totalGzip: sum(rows, "gzip"),
    totalRaw: sum(rows, "raw"),
    files: rows.sort((a, b) => b.gzip - a.gzip),
  };
}
rmSync(work, { recursive: true, force: true });

const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
for (const [name, r] of Object.entries(out)) {
  console.log(`${name}: entry ${kb(r.initialGzip)} gzip, all chunks ${kb(r.totalGzip)} gzip (${kb(r.totalRaw)} raw)`);
  for (const f of r.files.slice(0, 10)) console.log(`  ${kb(f.gzip).padStart(10)}  ${f.file}`);
}
for (const name of ["words", "words-no-highlights"]) {
  console.log(`switching to ${name}: ${kb(out[name].initialGzip - out.streamdown.initialGzip)} gzip (+ adds)`);
}
writeFileSync(join(root, "bench/markdown/results/bundle.json"), JSON.stringify(out, null, 2));
