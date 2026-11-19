import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import { StreamdownMarkdown } from "@/components/chat/Markdown";
import WordsMarkdown from "@/components/chat/WordsMarkdown";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ChatSessionContext } from "@/hooks/useChatSession";
import { STREAMED, TRANSCRIPT } from "@/bench/markdownCorpus";

/// Streamdown against Words, inside the running dev app: same webview, same
/// stylesheet, same chat column. Dev only — reached from Settings → Developer.
///
/// `words-bare` is Words with no element hooks. Any hook stops Words extending
/// its output in place, so it shows what our hooks cost on their own.
export const VARIANTS = ["streamdown", "words", "words-bare"] as const;
export type Variant = (typeof VARIANTS)[number];

const RUNS = 7;
/// Characters added per frame while streaming: a fast model's rate, about
/// 1900 characters a second at 60Hz.
const CHUNK = 32;
const FRAME = 1000 / 60;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const frame = () => new Promise<number>((r) => requestAnimationFrame(r));
async function frames(n: number) {
  for (let i = 0; i < n; i += 1) await frame();
}

export const median = (xs: number[]) => {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};

/// `text` with every fence's first line changed invisibly, so each run
/// tokenizes cold while grammars and themes stay loaded — both renderers
/// cache highlighted blocks by their text.
export function freshen(text: string, run: number): string {
  let inFence = false;
  let openNext = false;
  return text
    .split("\n")
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) {
        inFence = !inFence;
        openNext = inFence;
        return line;
      }
      if (openNext) {
        openNext = false;
        return "​".repeat(run + 1) + line;
      }
      return line;
    })
    .join("\n");
}

/// Resident memory of the webview's own process, read by the dev server
/// (`bench/markdown/server.mjs`). `null` where it cannot tell.
async function rss(): Promise<number | null> {
  try {
    const res = await fetch("/__md-bench/rss");
    return (await res.json()).rss ?? null;
  } catch {
    return null;
  }
}

/// Resolves once `el` has gone `ms` without a DOM change, with the time of the
/// last change — when async highlighting has landed.
function quiet(el: HTMLElement, ms = 500, cap = 15000): Promise<number> {
  return new Promise((resolve) => {
    let last = performance.now();
    let timer = setTimeout(done, ms);
    const cutoff = setTimeout(done, cap);
    const observer = new MutationObserver(() => {
      last = performance.now();
      clearTimeout(timer);
      timer = setTimeout(done, ms);
    });
    observer.observe(el, { subtree: true, childList: true, characterData: true, attributes: true });
    function done() {
      observer.disconnect();
      clearTimeout(timer);
      clearTimeout(cutoff);
      resolve(last);
    }
  });
}

function Message({ variant, text, streaming }: { variant: Variant; text: string; streaming: boolean }) {
  if (variant === "streamdown") {
    return (
      <StreamdownMarkdown streaming={streaming} linkFilePaths>
        {text}
      </StreamdownMarkdown>
    );
  }
  return (
    <WordsMarkdown streaming={streaming} linkFilePaths bare={variant === "words-bare"}>
      {text}
    </WordsMarkdown>
  );
}

/// The chat column `Chat.tsx` draws, holding `messages`.
function Column({ variant, messages, streaming = false }: { variant: Variant; messages: string[]; streaming?: boolean }) {
  return (
    <ChatSessionContext value={{ cwd: "/home/user/project", sessionId: null }}>
      <TooltipProvider>
        <div className="mx-auto flex max-w-3xl flex-col gap-4 px-6 py-6">
          {messages.map((text, i) => (
            <Message key={i} variant={variant} text={text} streaming={streaming && i === messages.length - 1} />
          ))}
        </div>
      </TooltipProvider>
    </ChatSessionContext>
  );
}

export type FullRun = { sync: number; firstFrame: number; settled: number; nodes: number; rssDelta: number | null };
export type StreamRun = {
  chunks: number;
  chunkMedian: number;
  chunkP95: number;
  chunkMax: number;
  dropped: number;
  longFrames: number;
  wall: number;
  commit: number;
};

type Stage = { el: HTMLElement; content: HTMLElement; status: HTMLElement; root: Root };

function mountStage(): Stage {
  const el = document.createElement("div");
  el.className = "fixed inset-0 z-[2147483646] overflow-auto bg-background text-foreground";
  const status = document.createElement("div");
  status.className = "fixed top-2 right-3 z-[2147483647] rounded bg-muted px-2 py-1 font-mono text-xs";
  const content = document.createElement("div");
  el.append(content);
  document.body.append(el, status);
  return { el, content, status, root: createRoot(content) };
}

async function fullRun(stage: Stage, variant: Variant, run: number): Promise<FullRun> {
  const messages = TRANSCRIPT.map((t) => freshen(t, run));
  flushSync(() => stage.root.render(null));
  await frames(3);
  await sleep(800);
  const before = await rss();

  const t0 = performance.now();
  flushSync(() => stage.root.render(<Column variant={variant} messages={messages} />));
  void stage.content.offsetHeight;
  const sync = performance.now() - t0;
  await frame();
  const firstFrame = performance.now() - t0;
  const last = await quiet(stage.content);
  const settled = Math.max(firstFrame, last - t0);
  const nodes = stage.content.getElementsByTagName("*").length;
  await sleep(300);
  const after = await rss();
  return { sync, firstFrame, settled, nodes, rssDelta: before !== null && after !== null ? after - before : null };
}

async function streamRun(stage: Stage, variant: Variant, run: number): Promise<StreamRun> {
  const text = freshen(STREAMED, run);
  flushSync(() => stage.root.render(<Column variant={variant} messages={[""]} streaming />));
  await frames(5);
  await sleep(300);

  const costs: number[] = [];
  const intervals: number[] = [];
  const start = performance.now();
  await new Promise<void>((resolve) => {
    let at = 0;
    let prev = -1;
    const step = (now: number) => {
      if (prev >= 0) intervals.push(now - prev);
      prev = now;
      at = Math.min(text.length, at + CHUNK);
      const t = performance.now();
      flushSync(() => stage.root.render(<Column variant={variant} messages={[text.slice(0, at)]} streaming />));
      // The transcript follows the tail, as Chat does while a turn streams.
      stage.el.scrollTop = stage.el.scrollHeight;
      costs.push(performance.now() - t);
      if (at >= text.length) resolve();
      else requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
  const wall = performance.now() - start;

  const t = performance.now();
  flushSync(() => stage.root.render(<Column variant={variant} messages={[text]} />));
  void stage.content.offsetHeight;
  const commit = performance.now() - t;
  await quiet(stage.content);

  return {
    chunks: costs.length,
    chunkMedian: median(costs),
    chunkP95: pct(costs, 95),
    chunkMax: Math.max(...costs),
    // Every vsync a frame interval spans past its first is one not drawn.
    dropped: intervals.reduce((n, iv) => n + Math.max(0, Math.round(iv / FRAME) - 1), 0),
    longFrames: intervals.filter((iv) => iv > 50).length,
    wall,
    commit,
  };
}

export type BenchResult = {
  date: string;
  userAgent: string;
  runs: number;
  corpus: { messages: number; chars: number; streamedChars: number; chunk: number };
  full: Record<Variant, FullRun[]>;
  stream: Record<Variant, StreamRun[]>;
  medians: Record<Variant, Record<string, number | null>>;
};

function medianOf<T>(rows: T[], key: keyof T): number | null {
  const xs = rows.map((r) => r[key]).filter((x): x is number & T[keyof T] => typeof x === "number");
  return xs.length ? median(xs as number[]) : null;
}

/// Runs everything: a discarded warm-up per variant, then `RUNS` rounds with
/// the variants interleaved, so drift over the run lands on all of them.
export async function runMarkdownBench(variants: readonly Variant[] = VARIANTS): Promise<BenchResult> {
  const stage = mountStage();
  const say = (s: string) => (stage.status.textContent = s);
  const full = Object.fromEntries(variants.map((v) => [v, [] as FullRun[]])) as Record<Variant, FullRun[]>;
  const stream = Object.fromEntries(variants.map((v) => [v, [] as StreamRun[]])) as Record<Variant, StreamRun[]>;

  try {
    for (const v of variants) {
      say(`warm-up ${v}`);
      await fullRun(stage, v, 99);
      await streamRun(stage, v, 99);
    }
    for (let run = 0; run < RUNS; run += 1) {
      for (const v of variants) {
        say(`run ${run + 1}/${RUNS} · ${v} · full`);
        full[v].push(await fullRun(stage, v, run));
        say(`run ${run + 1}/${RUNS} · ${v} · stream`);
        stream[v].push(await streamRun(stage, v, run));
      }
    }
  } finally {
    stage.root.unmount();
    stage.el.remove();
    stage.status.remove();
  }

  const medians = Object.fromEntries(
    variants.map((v) => [
      v,
      {
        fullSync: medianOf(full[v], "sync"),
        fullFirstFrame: medianOf(full[v], "firstFrame"),
        fullSettled: medianOf(full[v], "settled"),
        domNodes: medianOf(full[v], "nodes"),
        rssDeltaMB: (() => {
          const m = medianOf(full[v], "rssDelta");
          return m === null ? null : m / 1024 / 1024;
        })(),
        chunkMedian: medianOf(stream[v], "chunkMedian"),
        chunkP95: medianOf(stream[v], "chunkP95"),
        chunkMax: medianOf(stream[v], "chunkMax"),
        droppedFrames: medianOf(stream[v], "dropped"),
        longFrames: medianOf(stream[v], "longFrames"),
        streamWall: medianOf(stream[v], "wall"),
        streamChunks: medianOf(stream[v], "chunks"),
        finalCommit: medianOf(stream[v], "commit"),
      },
    ]),
  ) as unknown as BenchResult["medians"];

  const result: BenchResult = {
    date: new Date().toISOString(),
    userAgent: navigator.userAgent,
    runs: RUNS,
    corpus: {
      messages: TRANSCRIPT.length,
      chars: TRANSCRIPT.reduce((n, t) => n + t.length, 0),
      streamedChars: STREAMED.length,
      chunk: CHUNK,
    },
    full,
    stream,
    medians,
  };
  await fetch("/__md-bench/results", { method: "POST", body: JSON.stringify(result) }).catch(() => {});
  return result;
}
