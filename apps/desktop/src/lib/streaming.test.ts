import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { streamingCall } from "@/lib/streaming";

const FIXTURES = new URL(
  "../../src-tauri/src/harness/claude_code/fixtures/",
  import.meta.url,
);

function lines(name: string): Record<string, any>[] {
  return readFileSync(new URL(name, FIXTURES), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

/// The `input_json_delta` fragments of each `tool_use` block, in arrival order —
/// exactly what the frontend accumulates into `StreamingBlock.text`.
function toolBlocks(name: string): { tool: string; fragments: string[] }[] {
  const blocks: { tool: string; fragments: string[] }[] = [];
  let open: { tool: string; fragments: string[] } | null = null;

  for (const line of lines(name)) {
    if (line.type !== "stream_event") continue;
    const event = line.event;

    if (event.type === "content_block_start") {
      open =
        event.content_block?.type === "tool_use"
          ? { tool: event.content_block.name, fragments: [] }
          : null;
      if (open) blocks.push(open);
    }
    if (event.type === "content_block_delta" && event.delta?.type === "input_json_delta") {
      open?.fragments.push(event.delta.partial_json);
    }
    if (event.type === "content_block_stop") open = null;
  }

  return blocks;
}

describe("streamingCall", () => {
  it("counts the lines of a Write's content as they arrive", () => {
    expect(streamingCall("Write", '{"file_path":"/a/b/c.py","content":"one\\ntwo\\nthree"')).toEqual(
      { target: "b/c.py", added: 3 },
    );
  });

  it("does not open a line a trailing newline hasn't started", () => {
    expect(streamingCall("Write", '{"file_path":"/a/c.py","content":"one\\ntwo\\n"').added).toBe(2);
  });

  it("reports zero for content that has only just opened", () => {
    expect(streamingCall("Write", '{"file_path":"/a/c.py","content":""').added).toBe(0);
  });

  it("survives a fragment that ends mid-escape", () => {
    // The tail is half an escape sequence, which is not valid JSON on its own.
    expect(streamingCall("Write", '{"file_path":"/a/c.py","content":"tail\\').added).toBe(1);
  });

  it("does not let an escaped quote end the value early", () => {
    expect(
      streamingCall("Write", '{"file_path":"/a/c.py","content":"say \\"hi\\" now\\nnext').added,
    ).toBe(2);
  });

  it("counts NotebookEdit's new_source", () => {
    expect(
      streamingCall("NotebookEdit", '{"notebook_path":"/a/n.ipynb","new_source":"x = 1\\ny = 2"')
        .added,
    ).toBe(2);
  });

  // The reviewer's bug. `content` is scanned by substring, so a nested one used
  // to match: field-keying counted the first todo as a line of an added file on
  // a call that writes no file at all.
  it("ignores a content key nested inside TodoWrite's todos", () => {
    expect(
      streamingCall("TodoWrite", '{"todos":[{"content":"Fix the bug","status":"pending"'),
    ).toEqual({ target: null, added: null });
  });

  it("ignores a content param on an unenumerated MCP tool", () => {
    expect(streamingCall("mcp__notes__save", '{"content":"one\\ntwo","title":"t"}').added).toBe(
      null,
    );
  });

  it("gives an Edit its path but no line count", () => {
    expect(
      streamingCall("Edit", '{"file_path":"/a/b/c.py","old_string":"a","new_string":"b\\nc"}'),
    ).toEqual({ target: "b/c.py", added: null });
  });

  it("keeps a command whole rather than shortening it as a path", () => {
    expect(streamingCall("Bash", '{"command":"find /a/b -name x"}').target).toBe(
      "find /a/b -name x",
    );
  });

  it("prefers the command over the description when both have landed", () => {
    expect(
      streamingCall("Bash", '{"command":"ls -la","description":"list the files"}').target,
    ).toBe("ls -la");
  });

  it("withholds a target until its closing quote arrives", () => {
    // A path printed while still arriving would grow character by character,
    // which reads as a glitch rather than as progress.
    expect(streamingCall("Write", '{"file_path":"/a/b/part').target).toBe(null);
  });

  // `args` lands first on the wire and is a paragraph on a long brief, so the
  // preview stays on the generic label until the short key behind it closes.
  it("names a Skill once its name has landed, not while its brief streams", () => {
    expect(streamingCall("Skill", '{"args":"screenshot localhost:1420').target).toBe(null);
    expect(
      streamingCall("Skill", '{"args":"screenshot localhost:1420","skill":"agent-browser"').target,
    ).toBe("agent-browser");
  });

  it("reads nothing out of an empty prefix", () => {
    expect(streamingCall("Write", "")).toEqual({ target: null, added: null });
  });
});

describe("against real captured output", () => {
  it("names a Write and its path long before the call commits", () => {
    const write = toolBlocks("file_write.jsonl").find((b) => b.tool === "Write");
    expect(write).toBeDefined();

    const { fragments } = write!;
    // The capture this fixture came from spent 39.5s on these fragments.
    expect(fragments.length).toBeGreaterThan(50);

    // The path resolves within the first few fragments — the whole reason the
    // preview can name the file rather than sitting on a generic label.
    const pathAt = fragments.findIndex(
      (_, i) => streamingCall("Write", fragments.slice(0, i + 1).join("")).target !== null,
    );
    expect(pathAt).toBeGreaterThanOrEqual(0);
    expect(pathAt).toBeLessThan(fragments.length / 10);
  });

  it("climbs the line count monotonically to the file's real length", () => {
    const { fragments } = toolBlocks("file_write.jsonl").find((b) => b.tool === "Write")!;

    let previous = 0;
    for (let i = 0; i < fragments.length; i += 1) {
      const { added } = streamingCall("Write", fragments.slice(0, i + 1).join(""));
      if (added === null) continue;
      expect(added).toBeGreaterThanOrEqual(previous);
      previous = added;
    }

    // The committed input is what the row will show once it swaps, so the
    // preview's last reading has to be the same file. Counted the way an editor
    // shows it: a file ending in a newline has not started a further line, which
    // is the rule the capture exercises — its content ends with one.
    const { content } = JSON.parse(fragments.join("")) as { content: string };
    expect(content.endsWith("\n")).toBe(true);
    expect(previous).toBe(content.replace(/\n$/, "").split("\n").length);
  });

  it("resolves every captured tool block to the target its committed row shows", () => {
    for (const { tool, fragments } of toolBlocks("file_write.jsonl")) {
      const whole = fragments.join("");
      const input = JSON.parse(whole) as Record<string, string>;
      const expected = input.file_path ?? input.command;
      expect(streamingCall(tool, whole).target).toBe(
        expected.includes("/") && !expected.includes(" ")
          ? expected.split("/").filter(Boolean).slice(-2).join("/")
          : expected,
      );
    }
  });
});

// The preview picks the first *complete* target key, so a tool carrying two of
// them depends on the more specific one arriving first. Bash is the case that
// matters: `description` is a key the committed row never shows, so if the model
// ever emitted it first the row would show a description and then swap. Pinned
// against every capture rather than argued, because the comment in
// `streaming.ts` claims it as fact.
describe("wire ordering the preview depends on", () => {
  it("puts command before description on every captured Bash call", () => {
    let checked = 0;

    for (const file of readdirSync(FIXTURES).filter((f) => f.endsWith(".jsonl"))) {
      for (const line of lines(file)) {
        if (line.type !== "assistant") continue;
        for (const block of line.message?.content ?? []) {
          if (block.type !== "tool_use" || block.name !== "Bash") continue;
          const keys = Object.keys(block.input);
          if (!keys.includes("description")) continue;
          expect(keys.indexOf("command")).toBeLessThan(keys.indexOf("description"));
          checked += 1;
        }
      }
    }

    expect(checked).toBeGreaterThan(0);
  });
});
