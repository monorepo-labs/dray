# Markdown renderer benchmark (#1297)

Streamdown, which ships, against Pierre's Words (`@pierre/words` 0.2.2, beta),
inside the running dev app.

## Running it

- **Timing, memory, DOM**: dev build → Settings → Appearance → Developer →
  Markdown benchmark → Run. Takes about seven minutes. Touch nothing while it
  runs: input, screenshots and other CPU work all land in the frame timings.
  Medians show in Settings; the full run lands in `results/` (gitignored).
- **Side by side**: same section, Side by side → Show. Escape closes it.
- **Bundle size**: `node bench/markdown/bundle.mjs` from `apps/desktop`.
- **Parity**: `node bench/markdown/parity.mjs` prints what Words draws for each
  shape our Streamdown plugins handle.
- **The switch**: Markdown renderer → Words draws every `Markdown` in the app
  with Words. Dev builds only; a production build folds it away.

## What it measures

The runner ([markdownBench.tsx](../../src/bench/markdownBench.tsx)) mounts the
real `Markdown` components in a full-window layer over the app, in the chat
column `Chat.tsx` draws, with `linkFilePaths` on as the chat has it.

- **Corpus**: real content only. The two long agent replies in the Claude Code
  fixtures (`complex.jsonl`, `multi_turn.jsonl`) and four agent-written docs
  from this repo (CODEX.md, FILES-PLAN.md, SSH-PLAN.md, README.md), which carry
  the tables, fences, lists and links. The transcript is all six twice: 12
  messages, 117k characters.
- **Full render**: mount the transcript in one `flushSync`. *Sync* is render
  plus forced layout; *settled* is the last DOM change, when async highlighting
  has landed.
- **Streaming**: one 18.6k-character message (an agent reply then FILES-PLAN)
  grown by 32 characters a frame, about 1900 characters a second, as one
  `flushSync` per `requestAnimationFrame`, following the tail. *Per chunk* is
  each render plus layout; *dropped frames* counts the vsyncs each frame
  interval spans past its first; *final commit* is the switch from streaming to
  committed.
- **Memory**: resident memory of the WebKit web process before and after
  mounting the transcript, read from `/proc` by the dev server
  ([server.mjs](server.mjs)). WebKit collects garbage when it likes, so this is
  noisy; DOM node count is the steadier proxy.
- Every run changes each fence's first line invisibly, so highlighting is cold
  per run while grammars and themes stay loaded. One discarded warm-up per
  renderer, then the renderers interleaved, seven rounds.

`words-bare` is Words with no element hooks. Any hook stops Words extending its
output in place, so it isolates what our hooks (table cell wrap, file links)
cost.

## Results

Linux sandbox, WebKitGTK 2.52.6, 8 cores, **no GPU** (llvmpipe paints on the CPU,
which inflates frame drops for both). Fresh app launch, median of 7.

| | Streamdown | Words | Words, no hooks |
|---|---:|---:|---:|
| Full transcript, render + layout | 389 ms | 81 ms | 72 ms |
| Full transcript, settled | 422 ms | 101 ms | 91 ms |
| DOM nodes | 4,643 | 3,145 | 2,917 |
| Webview RSS added | 14.3 MB | 11.4 MB | 6.5 MB |
| Streaming, per chunk, median | 5 ms | 2 ms | 2 ms |
| Streaming, per chunk, p95 | 23 ms | 4 ms | 3 ms |
| Streaming, per chunk, max | 34 ms | 21 ms | 13 ms |
| Dropped frames over 582 | 80 | 4 | 2 |
| Stream wall time (ideal 9.7 s) | 11.0 s | 9.7 s | 9.7 s |
| Streaming → committed | 56 ms | 1 ms | 1 ms |

An earlier pass agreed within noise. A pass run in a webview grown to 1 GB over
two earlier runs was about twice as slow for all three, with the same ratios.

Bundle, gzip, built alone with React and `@pierre/diffs` external (both stay):

| | gzip |
|---|---:|
| Streamdown + our plugins | 168 KB |
| Words + `@pierre/highlights` + Pierre themes | 273 KB (+106 KB) |
| Words, highlighting left to the app's Shiki | 83 KB (−85 KB) |

`@pierre/highlights` is a second highlighter beside the Shiki the diff view
already loads, and both its and Words' wasm ship as base64 inside the JS.
