import React, { useState } from "react";
import ReactDOM from "react-dom/client";

import BrowserPane from "@/components/browser/BrowserPane";
import FileTabs from "@/components/files/FileTabs";
import { TooltipProvider } from "@/components/ui/tooltip";
import DemoThemeBar from "@/demo/ThemeBar";
import type { OpenFile } from "@/hooks/useOpenFiles";
import "../App.css";

/// Dragging tabs along the browser pane's strip and the Files view's strip.
///
/// Both strips are the real components. The browser's tab order lives in Rust,
/// so the bridge is stubbed here to answer `browser_move` the way the app does:
/// reorder, then publish `browser_tabs`.
const SESSION = "demo-session";

let tabs = ["Acme", "Pricing", "Docs", "Changelog", "Blog", "Careers"].map(
  (title, i) => ({
    id: i + 1,
    url: `http://localhost:3000/${i}`,
    title,
    favicon: "",
    loading: false,
    active: i === 0,
    canGoBack: false,
    canGoForward: false,
    error: null,
  }),
);

const callbacks = new Map<number, (event: unknown) => void>();
const handlers = new Map<string, number[]>();
let nextId = 1;

function emit(event: string, payload: unknown) {
  for (const id of handlers.get(event) ?? []) callbacks.get(id)?.({ event, id, payload });
}

Object.assign(window, {
  __TAURI_INTERNALS__: {
    transformCallback: (cb: (event: unknown) => void) => {
      const id = nextId++;
      callbacks.set(id, cb);
      return id;
    },
    invoke: async (
      cmd: string,
      args: { event?: string; handler?: number; id?: number; to?: number },
    ) => {
      switch (cmd) {
        case "plugin:event|listen":
          handlers.set(args.event!, [...(handlers.get(args.event!) ?? []), args.handler!]);
          return args.handler;
        case "chromium_status":
          return { state: "ready", version: "demo", sizeBytes: 0 };
        case "browser_tabs":
          return tabs;
        case "browser_move": {
          const next = tabs.filter((t) => t.id !== args.id);
          next.splice(args.to!, 0, tabs.find((t) => t.id === args.id)!);
          tabs = next;
          emit("browser_tabs", { sessionId: SESSION, tabs });
          return tabs;
        }
        case "browser_activate":
          tabs = tabs.map((t) => ({ ...t, active: t.id === args.id }));
          emit("browser_tabs", { sessionId: SESSION, tabs });
          return null;
        case "browser_snapshot":
          return null;
        case "list_local_servers":
        case "list_open_apps":
          return [];
        case "browser_layout":
        case "browser_shutter_ready":
        case "plugin:event|unlisten":
          return null;
        default:
          throw new Error(`demo: nothing stubbed for ${cmd}`);
      }
    },
  },
  __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} },
});

const FILES: OpenFile[] = ["src/App.tsx", "src/lib/browser.ts", "src-tauri/src/lib.rs", "README.md"].map(
  (path) => ({ path: `/repo/${path}`, reveal: 0, state: { status: "loading" } }),
);

/// Drags each strip's first tab past its next two neighbours with synthetic
/// pointer events and reports the order before and after, for an agent
/// checking this page without a real pointer.
async function dragCheck(): Promise<string> {
  const frame = () => new Promise((r) => requestAnimationFrame(r));
  const cases: [string, string, (tabs: HTMLElement[]) => number, number][] = [
    ["files, past two", "#file-tabs", (tabs) => tabs[2].getBoundingClientRect().right - 5, 0],
    ["browser, past one", "#browser-tabs", (tabs) => tabs[1].getBoundingClientRect().right - 5, 0],
    // Held at the strip's edge, so it has to scroll to go further.
    [
      "browser, held at the edge",
      "#browser-tabs",
      (tabs) => tabs[0].parentElement!.getBoundingClientRect().right - 5,
      60,
    ],
  ];
  const out: string[] = [];
  for (const [name, root, target, hold] of cases) {
    const sel = `${root} [role=tab]`;
    const read = () => [...document.querySelectorAll(sel)].map((t) => t.textContent?.trim());
    const before = read().join(" | ");
    const tabs = [...document.querySelectorAll<HTMLElement>(sel)];
    const strip = tabs[0].parentElement!;
    strip.scrollLeft = 0;
    await frame();
    const r = tabs[0].getBoundingClientRect();
    const x0 = r.left + 10;
    const x1 = target(tabs);
    const base = { pointerId: 1, pointerType: "mouse", isPrimary: true, bubbles: true, button: 0 };
    const at = (x: number, buttons: number) => ({ ...base, buttons, clientX: x, clientY: r.top + r.height / 2 });
    tabs[0].dispatchEvent(new PointerEvent("pointerdown", at(x0, 1)));
    for (let i = 1; i <= 10; i++) {
      tabs[0].dispatchEvent(new PointerEvent("pointermove", at(x0 + ((x1 - x0) * i) / 10, 1)));
      await frame();
    }
    for (let i = 0; i < hold; i++) await frame();
    const mid = `held ${tabs[0].style.transform}, neighbour ${tabs[1].style.transform}, scrolled ${strip.scrollLeft}px`;
    tabs[0].dispatchEvent(new PointerEvent("pointerup", at(x1, 0)));
    await new Promise((r) => setTimeout(r, 100));
    out.push(`${name}\n  before: ${before}\n  mid: ${mid}\n  after: ${read().join(" | ")}`);
  }
  return out.join("\n");
}

function Demo() {
  const [check, setCheck] = useState("");
  const [files, setFiles] = useState(FILES);
  const [active, setActive] = useState(FILES[0].path);
  const move = (path: string, delta: number) =>
    setFiles((open) => {
      const next = [...open];
      const at = next.findIndex((f) => f.path === path);
      next.splice(at + delta, 0, ...next.splice(at, 1));
      return next;
    });

  return (
    <TooltipProvider>
      <div className="flex h-screen flex-col gap-8 p-10">
        <h1 className="text-lg font-medium">Drag tabs to reorder them</h1>
        <div className="flex items-start gap-3">
          <button
            type="button"
            onClick={() => void dragCheck().then(setCheck, (e) => setCheck(String(e)))}
            className="rounded-md border border-border px-3 py-1.5 text-sm"
          >
            Run drag check
          </button>
          <pre id="drag-check" className="text-xs text-muted-foreground">
            {check}
          </pre>
        </div>
        <section className="flex max-w-2xl flex-col gap-2">
          <h2 className="text-ui text-muted-foreground">Files view</h2>
          <div id="file-tabs" className="rounded-lg border border-border bg-card">
            <FileTabs
              files={files}
              active={active}
              onSelect={setActive}
              onClose={(path) => setFiles((open) => open.filter((f) => f.path !== path))}
              onMove={move}
            />
          </div>
        </section>
        <section className="flex max-w-md flex-col gap-2">
          <h2 className="text-ui text-muted-foreground">Browser pane</h2>
          <div id="browser-tabs" className="h-40 overflow-hidden rounded-lg border border-border bg-card">
            <BrowserPane sessionId={SESSION} active mode="panel" />
          </div>
        </section>
      </div>
      <DemoThemeBar />
    </TooltipProvider>
  );
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <Demo />
  </React.StrictMode>,
);
