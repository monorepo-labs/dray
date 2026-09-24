import { afterEach, describe, expect, it, vi } from "vitest";
import type { CodeHighlighterPlugin } from "streamdown";

import { streamingCodePlugin } from "./codePlugin";

type Result = NonNullable<ReturnType<CodeHighlighterPlugin["highlight"]>>;

// Colours every line "red", so a coloured line is one the base plugin tokenized.
function fakeBase() {
  const calls: string[] = [];
  const plugin = {
    name: "shiki",
    type: "code-highlighter",
    highlight: ({ code }: { code: string }) => {
      calls.push(code);
      return {
        tokens: code.split("\n").map((content) => [{ content, color: "red" }]),
      } as unknown as Result;
    },
  } as unknown as CodeHighlighterPlugin;
  return { plugin, calls };
}

const colours = (r: Result | null) => r!.tokens.map((line) => line[0].color);
const ask = (p: CodeHighlighterPlugin, code: string, cb?: (r: Result) => void) =>
  p.highlight({ code, language: "ts" as never, themes: ["a", "b"] as never }, cb);

afterEach(() => vi.useRealTimers());

describe("streamingCodePlugin", () => {
  it("tokenizes a growing block once, after it stops growing", () => {
    vi.useFakeTimers();
    const { plugin, calls } = fakeBase();
    const streaming = streamingCodePlugin(plugin);
    const delivered: Result[] = [];

    let code = "";
    for (const piece of ["const a", " = 1;\n", "const b", " = 2;\n", "const c"]) {
      code += piece;
      expect(colours(ask(streaming, code, (r) => delivered.push(r)))).not.toContain("red");
      vi.advanceTimersByTime(50);
    }
    expect(calls).toEqual([]);

    vi.advanceTimersByTime(200);
    expect(calls).toEqual([code]);
    expect(colours(delivered.at(-1)!)).toEqual(["red", "red", "red"]);
    expect(colours(ask(streaming, code))).toEqual(["red", "red", "red"]);
  });

  it("keeps a settled prefix's finished lines coloured as the block grows past it", () => {
    vi.useFakeTimers();
    const { plugin } = fakeBase();
    const streaming = streamingCodePlugin(plugin);

    ask(streaming, "a\nb", () => {});
    vi.advanceTimersByTime(200);

    // `b` may have been a partial line, so only `a` is final.
    expect(colours(ask(streaming, "a\nbc\nd"))).toEqual(["red", "inherit", "inherit"]);
  });

  it("still answers a fence whose text a later fence starts with", () => {
    vi.useFakeTimers();
    const { plugin, calls } = fakeBase();
    const streaming = streamingCodePlugin(plugin);
    const first: Result[] = [];
    const second: Result[] = [];

    ask(streaming, "npm i", (r) => first.push(r));
    ask(streaming, "npm i\nnpm run dev", (r) => second.push(r));
    vi.advanceTimersByTime(200);

    expect(calls).toEqual(["npm i\nnpm run dev"]);
    expect(first[0].tokens.map((line) => line[0].content)).toEqual(["npm i"]);
    expect(colours(first[0])).toEqual(["red"]);
    expect(colours(second[0])).toEqual(["red", "red"]);
  });
});
