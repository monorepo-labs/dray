import React, { useState } from "react";
import ReactDOM from "react-dom/client";

import BrowserPane from "@/components/browser/BrowserPane";
import RightPanel, { TabBody, tabOrder } from "@/components/RightPanel";
import { TooltipProvider } from "@/components/ui/tooltip";
import DemoThemeBar from "@/demo/ThemeBar";
import "../App.css";

/// What the browser pane shows while `dray browser record` runs.
///
/// A recording only happens under an agent driving a CEF build, which a plain
/// browser cannot be, so the real pane is mounted in the real right panel and
/// the Tauri bridge is stubbed *outside* them — nothing in `src/` carries a
/// demo seam. The page is a picture standing where the native view would be,
/// which is exactly what the pane draws while recording anyway.
const SESSION = "demo-session";

const TABS = [
  {
    id: 1,
    url: "http://localhost:3000/",
    title: "Acme — Ship faster",
    favicon: "",
    loading: false,
    active: true,
    canGoBack: true,
    canGoForward: false,
    error: null,
  },
  {
    id: 2,
    url: "http://localhost:3000/pricing",
    title: "Pricing — Acme",
    favicon: "",
    loading: false,
    active: false,
    canGoBack: false,
    canGoForward: false,
    error: null,
  },
];

/// The still the pane holds: an SVG sliced to whatever size the pane is, so
/// dragging the panel crops the page rather than squashing it.
const PAGE = `data:image/svg+xml,${encodeURIComponent(`
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 520 900" preserveAspectRatio="xMidYMin slice">
  <rect width="520" height="900" fill="#fff"/>
  <rect width="520" height="52" fill="#fafafa"/><rect y="52" width="520" height="1" fill="#e5e5e5"/>
  <text x="20" y="32" font-family="system-ui" font-size="16" font-weight="700" fill="#111">Acme</text>
  <text x="330" y="32" font-family="system-ui" font-size="13" fill="#666">Pricing   Docs   Sign in</text>
  <text x="20" y="120" font-family="system-ui" font-size="28" font-weight="700" fill="#111">Ship faster with Acme</text>
  <text x="20" y="152" font-family="system-ui" font-size="14" fill="#555">Everything your team needs to plan, build and launch.</text>
  <rect x="20" y="176" width="124" height="38" rx="8" fill="#2563eb"/>
  <text x="42" y="200" font-family="system-ui" font-size="14" font-weight="600" fill="#fff">Get started</text>
  <rect x="20" y="250" width="232" height="140" rx="10" fill="#f3f4f6"/>
  <rect x="268" y="250" width="232" height="140" rx="10" fill="#f3f4f6"/>
  <rect x="20" y="406" width="232" height="140" rx="10" fill="#f3f4f6"/>
  <rect x="268" y="406" width="232" height="140" rx="10" fill="#f3f4f6"/>
</svg>`)}`;

// The bridge: events are routed to whichever handler `listen` registered, so
// the demo drives the pane with the very events Rust sends.
const callbacks = new Map<number, (event: unknown) => void>();
const handlers = new Map<string, number[]>();
let nextId = 1;
Object.assign(window, {
  __TAURI_INTERNALS__: {
    transformCallback: (cb: (event: unknown) => void) => {
      const id = nextId++;
      callbacks.set(id, cb);
      return id;
    },
    invoke: async (cmd: string, args: { event?: string; handler?: number }) => {
      switch (cmd) {
        case "plugin:event|listen":
          handlers.set(args.event!, [...(handlers.get(args.event!) ?? []), args.handler!]);
          return args.handler;
        case "chromium_status":
          return { state: "ready", version: "demo", sizeBytes: 0 };
        case "browser_tabs":
          return TABS;
        case "browser_snapshot":
          return PAGE;
        case "list_local_servers":
        case "list_open_apps":
          return [];
        case "browser_layout":
        case "browser_shutter_ready":
        case "plugin:event|unlisten":
          return null;
        default:
          // What a plain browser answers anyway, and what the app already
          // handles; a `null` passed off as an answer is what it does not.
          throw new Error(`demo: nothing stubbed for ${cmd}`);
      }
    },
  },
  __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} },
});

function emit(event: string, payload: unknown) {
  for (const id of handlers.get(event) ?? []) callbacks.get(id)?.({ event, id, payload });
}

let shot = 0;
/// Recording on is what the app sends at `record start`: the shutter, then
/// the recording itself. Off keeps the shutter open, so the pane goes on
/// drawing the page picture where a browser would draw the page.
function setRecording(on: boolean) {
  emit("browser_shooting", { sessionId: SESSION, shooting: true, shot: ++shot });
  emit("browser_recording", { sessionId: SESSION, recording: on });
}

function Demo() {
  const [recording, setRecordingState] = useState(false);
  const toggleRecording = () => {
    setRecording(!recording);
    setRecordingState(!recording);
  };
  // The pane mounts, claims the stage, then the shutter goes up: a frame on,
  // so its listeners exist before the first event is sent.
  React.useEffect(() => {
    const id = setTimeout(() => setRecording(false), 300);
    return () => clearTimeout(id);
  }, []);

  return (
    <TooltipProvider>
      <div className="flex h-screen">
        <div className="flex min-w-0 flex-1 flex-col gap-3 p-10">
          <h1 className="mb-2 text-lg font-medium">Browser pane while an agent records</h1>
          <p className="max-w-sm text-xs text-muted-foreground">
            The real pane in the real right panel. Drag the panel's edge to check narrow widths.
          </p>
          <div className="flex gap-2">
            <button type="button" onClick={toggleRecording} className="rounded-md border border-border px-3 py-1.5 text-sm">
              {recording ? "Stop recording" : "Start recording"}
            </button>
          </div>
        </div>

        <RightPanel
          open
          tabs={tabOrder({ pr: false, docs: false, issue: false, more: false })}
          tab="browser"
          onTabChange={() => {}}
          cwd="/Users/you/code/acme"
        >
          <TabBody active>
            <BrowserPane sessionId={SESSION} active mode="panel" />
          </TabBody>
        </RightPanel>
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
