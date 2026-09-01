// A scripted OpenAI-completions provider. Real pi, real RPC, real tool
// execution; only the model's tokens are canned. Lets every event type be
// captured with no API key and no cost.
import http from "node:http";

const PORT = 8787;

// Each call to /v1/chat/completions consumes the next script entry.
const script = [
  // 1. thinking + text + two tool calls in one assistant message
  {
    reasoning: "Let me look at the file first, then write the result.",
    text: "I'll read the notes and then write out.txt.",
    tools: [
      { id: "call_read_1", name: "read", args: { path: "notes.txt" } },
      { id: "call_bash_1", name: "bash", args: { command: "echo hi from bash" } },
    ],
  },
  // 2. an edit, so a diff-shaped tool call is captured
  {
    text: "Now editing src.ts.",
    tools: [
      {
        id: "call_edit_1",
        name: "edit",
        args: { path: "src.ts", oldText: "export const b = 2;", newText: "export const b = 3;" },
      },
    ],
  },
  // 3. a write, then stop
  {
    text: "Writing out.txt.",
    tools: [{ id: "call_write_1", name: "write", args: { path: "out.txt", content: "ok\n" } }],
  },
  // 4. final answer, no tools
  { text: "Done: read notes.txt, ran bash, edited src.ts and wrote out.txt." },
];

let step = 0;

const sse = (res, obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
const chunk = (delta, finish = null) => ({
  id: "chatcmpl-stub",
  object: "chat.completion.chunk",
  created: Math.floor(Date.now() / 1000),
  model: "stub-1",
  choices: [{ index: 0, delta, finish_reason: finish }],
});

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", () => {
    if (!req.url.includes("chat/completions")) {
      res.writeHead(404).end();
      return;
    }
    // Reset the script whenever a fresh conversation starts, so one server
    // serves many captures.
    try {
      const req = JSON.parse(body);
      const users = (req.messages || []).filter((m) => m.role === "user").length;
      const assistants = (req.messages || []).filter((m) => m.role === "assistant").length;
      if (users >= 1 && assistants === 0) step = 0;
    } catch {}
    // A prompt containing LONGBASH always gets one long-running shell call, so
    // abort can be captured mid-tool.
    let entry;
    if (body.includes("LONGBASH")) {
      entry = {
        text: "Running the long command.",
        tools: [{ id: "call_long_1", name: "bash", args: { command: "sleep 30 && echo done" } }],
      };
    } else {
      entry = script[Math.min(step, script.length - 1)];
      step += 1;
    }
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });

    sse(res, chunk({ role: "assistant", content: "" }));

    if (entry.reasoning) {
      for (const w of entry.reasoning.split(" ")) {
        sse(res, chunk({ reasoning_content: w + " " }));
      }
    }
    for (const w of (entry.text || "").split(" ")) {
      sse(res, chunk({ content: w + " " }));
    }
    (entry.tools || []).forEach((t, i) => {
      sse(
        res,
        chunk({
          tool_calls: [
            { index: i, id: t.id, type: "function", function: { name: t.name, arguments: "" } },
          ],
        }),
      );
      // Split the arguments so `toolcall_delta` is exercised, not just a
      // single-shot argument blob.
      const json = JSON.stringify(t.args);
      for (let c = 0; c < json.length; c += 12) {
        sse(
          res,
          chunk({
            tool_calls: [{ index: i, function: { arguments: json.slice(c, c + 12) } }],
          }),
        );
      }
    });

    sse(res, chunk({}, entry.tools ? "tool_calls" : "stop"));
    sse(res, {
      id: "chatcmpl-stub",
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: "stub-1",
      choices: [],
      usage: { prompt_tokens: 1200 + step * 400, completion_tokens: 40, total_tokens: 1240 + step * 400 },
    });
    res.write("data: [DONE]\n\n");
    res.end();
  });
});

server.listen(PORT, "127.0.0.1", () => console.error(`stub provider on :${PORT}`));
