import React, { useState } from "react";
import ReactDOM from "react-dom/client";

import RichInput from "@/components/composer/RichInput";
import DemoThemeBar from "@/demo/ThemeBar";
import "../App.css";

/// Whether the composer's colours follow the text as it is edited (#372).
///
/// **Run it in WebKit — Safari, or the app's own webview — never the session
/// browser.** Where a typed character lands is the engine's call, and Chromium
/// makes it differently enough to pass on code that fails in the app.
/// `execCommand("insertText")` stands in for a keystroke: it is the same typing
/// command a key press runs, so it inherits the caret's style the same way.
async function paintCheck(): Promise<string> {
  const box = document.querySelector<HTMLElement>("#composer [role=textbox]")!;
  const tick = () => new Promise((r) => setTimeout(r, 30));
  const type = async (text: string) => {
    for (const ch of text) {
      document.execCommand("insertText", false, ch);
      await tick();
    }
  };
  const backspace = async (n: number) => {
    for (let i = 0; i < n; i++) {
      document.execCommand("delete");
      await tick();
    }
  };
  const paste = async (text: string) => {
    const clipboardData = new DataTransfer();
    clipboardData.setData("text/plain", text);
    box.dispatchEvent(new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }));
    await tick();
  };
  const clear = async () => {
    box.focus();
    document.getSelection()!.selectAllChildren(box);
    document.execCommand("delete");
    await tick();
  };

  const cases: [string, () => Promise<boolean>][] = [
    [
      "a command backspaced to `/` paints what follows plain",
      async () => {
        await paste("/compact ");
        await backspace(8);
        await type(" hi");
        return box.innerHTML === "/ hi";
      },
    ],
    [
      "text after a command stays out of its colour",
      async () => {
        await paste("/compact");
        await type(" now");
        return box.innerHTML === '<span class="text-accent-command">/compact</span> now';
      },
    ],
    [
      "typing prose rebuilds nothing",
      async () => {
        await type("hello");
        const node = box.firstChild;
        await type(" world");
        return box.firstChild === node && box.textContent === "hello world";
      },
    ],
    [
      "typing a command rebuilds nothing once it is coloured",
      async () => {
        await type("/comp");
        const node = box.firstChild;
        await type("act");
        return box.firstChild === node && box.innerHTML === '<span class="text-accent-command">/compact</span>';
      },
    ],
  ];

  const out: string[] = [];
  for (const [name, run] of cases) {
    await clear();
    out.push(`${(await run()) ? "pass" : "FAIL"}  ${name}\n      ${box.innerHTML}`);
  }
  return out.join("\n");
}

function Demo() {
  const [check, setCheck] = useState("");
  const [draft, setDraft] = useState({ value: "", caret: 0 });

  return (
    <div className="flex h-screen flex-col gap-8 p-10">
      <h1 className="text-lg font-medium">Composer colours follow the text</h1>
      <div className="flex items-start gap-3">
        <button
          type="button"
          onClick={() => void paintCheck().then(setCheck, (e) => setCheck(String(e)))}
          className="rounded-md border border-border px-3 py-1.5 text-sm"
        >
          Run paint check
        </button>
        <pre id="paint-check" className="text-xs text-muted-foreground">
          {check}
        </pre>
      </div>
      <div id="composer" className="max-w-2xl rounded-lg border border-border bg-card p-3">
        <RichInput
          value={draft.value}
          caret={draft.caret}
          onChange={(value, caret) => setDraft({ value, caret })}
          onCaretChange={(caret) => setDraft((d) => (d.caret === caret ? d : { ...d, caret }))}
          placeholder="Type /compact, then delete it"
        />
      </div>
      <DemoThemeBar />
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <Demo />
  </React.StrictMode>,
);
