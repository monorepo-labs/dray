// The whole app on Dray Cloud (#857), in a plain browser: one real `dray-serve`
// stands in for This Mac, and two or more others are spare cloud machines, one
// handed to each task as it starts. Tauri's IPC is mocked and the mock does in
// the page what `servers.rs` and `cloud.rs` do in Rust — the control plane is
// faked here, and a panel in the corner stands in for boat: stop a machine, or
// make the next start fail.
//
//   T=$(openssl rand -hex 32)          # one serve token, as the control plane derives
//   for h in mac c1 c2; do mkdir -p /tmp/dray-cloud/$h && echo $T > /tmp/dray-cloud/$h/serve-token; done
//   DRAY_HOME=/tmp/dray-cloud/mac dray-serve --port 7320 &
//   DRAY_HOME=/tmp/dray-cloud/c1  dray-serve --port 7321 &
//   DRAY_HOME=/tmp/dray-cloud/c2  dray-serve --port 7322 &
//   open "/demo/cloud.html?serveToken=$T&machines=7321,7322"
//
// Attach a project with a GitHub remote on This Mac, pick Cloud beside it and
// send. A clone onto a cloud machine runs `gh repo clone` for real, into
// `~/dray/<repo>`, which every machine here shares. `&account=1` starts signed
// in to Dray, `&key=1` with the old shared key saved, both at once as the switch
// from key to account starts. Settings → Servers takes any key but `bad`.

import { emit } from "@tauri-apps/api/event";
import { mockConvertFileSrc, mockIPC } from "@tauri-apps/api/mocks";
import React, { useSyncExternalStore } from "react";
import ReactDOM from "react-dom/client";
import "streamdown/styles.css";

import { channel } from "@/lib/channel";
import { connect, type Socket } from "@/demo/serveSocket";
import type { CloudInfo, ServerInfo } from "@/types/events";

const query = new URLSearchParams(location.search);
const token = query.get("serveToken") ?? "";

/// How long a faked resume takes, standing in for boat's minutes.
const WAKE_MS = 3000;

const local = connect(
  `ws://127.0.0.1:${query.get("local") ?? "7320"}`,
  token,
  (event, payload) => void emit(event, payload),
  () => {},
);

type State = "running" | "stopped" | "starting";
type Machine = {
  sandbox: string;
  state: State;
  /// Handed to a task. A spare one is no machine yet, and lists as none.
  listed: boolean;
  info: ServerInfo;
  conn: Socket;
  /// Whether the socket is meant to be open. `connect` opens one on its own,
  /// and asking it to open twice leaves two.
  wanted: boolean;
};

const machines: Machine[] = [];
const keyed = { key: !!query.get("key"), signedIn: !!query.get("account") };
let cloud: CloudInfo = { on: keyed.key || keyed.signedIn, keyed: keyed.key || keyed.signedIn, ...keyed, error: null };
const changed = channel<void>();

const announce = () => {
  void emit(
    "servers_changed",
    listed().map((m) => m.info),
  );
  changed.emit();
};
const announceCloud = () => {
  void emit("cloud_changed", cloud);
  changed.emit();
};

/// `servers.rs`'s row for it: a stopped machine reads as a stopped boat row.
function setState(m: Machine, state: State) {
  m.state = state;
  const phase = state === "running" ? "running" : state === "stopped" ? "stopped" : "resuming";
  m.info = { ...m.info, boat: { phase, stopsAt: null, warning: false, note: null } };
  const want = state === "running" && cloud.on;
  if (want !== m.wanted) m.conn.setOn(want);
  m.wanted = want;
  announce();
}

const waitUp = (m: Machine) =>
  new Promise<void>((resolve) => {
    const check = () => (m.info.status === "connected" ? resolve() : setTimeout(check, 200));
    check();
  });

/// The control plane's resume, then boat's minutes, then the server answering.
async function resume(m: Machine) {
  if (m.info.status === "connected") return;
  if (m.state !== "starting") {
    setState(m, "starting");
    await new Promise((r) => setTimeout(r, WAKE_MS));
    setState(m, "running");
  }
  await waitUp(m);
}

const listed = () => machines.filter((m) => m.listed);
/// The panel's switch: the next start fails as an unreachable control plane would.
let failNext = false;
const kept = new Map<string, unknown>();

/// `POST /machines`: a spare `dray-serve` becomes this task's machine.
async function start(): Promise<string> {
  if (!cloud.keyed) throw "Sign in to Dray in Settings, Account, to use Dray Cloud.";
  if (failNext) {
    failNext = false;
    changed.emit();
    throw "Couldn't reach Dray Cloud: connection refused";
  }
  const spare = machines.find((m) => !m.listed);
  if (!spare) throw "No spare dray-serve left in this demo.";
  spare.listed = true;
  setState(spare, "starting");
  await new Promise((r) => setTimeout(r, WAKE_MS));
  setState(spare, "running");
  await waitUp(spare);
  return spare.info.id;
}

mockConvertFileSrc("macos");
mockIPC(
  async (cmd, args) => {
    const a = (args ?? {}) as Record<string, unknown>;
    const byId = (id: unknown) => machines.find((m) => m.info.id === id);
    switch (cmd) {
      case "list_servers":
        return cloud.keyed ? listed().map((m) => m.info) : [];
      case "local_server":
        return null;
      case "cloud_info":
        return cloud;
      case "set_cloud_key":
        if (a.key === "bad") throw "Dray Cloud didn't accept this key.";
        cloud = a.key
          ? { ...cloud, on: true, keyed: true, key: true, error: null }
          : { ...cloud, on: cloud.signedIn && cloud.on, keyed: cloud.signedIn, key: false, error: null };
        announceCloud();
        for (const m of machines) setState(m, m.state);
        return null;
      case "set_cloud_on":
        cloud = { ...cloud, on: !!a.on };
        for (const m of machines) m.info = { ...m.info, on: !!a.on };
        announceCloud();
        for (const m of machines) setState(m, m.state);
        return null;
      case "start_cloud_machine":
        return start();
      case "drop_cloud_machine": {
        const m = byId(a.id);
        if (m) {
          m.listed = false;
          setState(m, "stopped");
        }
        return null;
      }
      case "save_cloud_transcript":
        kept.set(`${a.server}/${a.sessionId}`, a.snapshot);
        return null;
      case "cloud_transcript":
        return kept.get(`${a.server}/${a.sessionId}`) ?? null;
      case "resume_boat": {
        const m = byId(a.id);
        if (!m) throw "This server is not a boat sandbox.";
        return resume(m);
      }
      case "reconnect_servers":
        for (const m of machines) m.conn.reconnect();
        return null;
      case "server_invoke": {
        if (a.server === "local") return local.call(String(a.cmd), a.args);
        const m = byId(a.server);
        if (!m) throw `no server named ${a.server}`;
        return m.conn.call(String(a.cmd), a.args);
      }
      default:
        return local.call(cmd, a);
    }
  },
  { shouldMockEvents: true },
);

// After the mock, since a row announces itself as it is made.
const ports = (query.get("machines") ?? "7321,7322").split(",");
ports.forEach((port, i) => {
  const sandbox = `bx_demo${i + 1}`;
  const id = `cloud${i + 1}`;
  const m: Machine = {
    sandbox,
    state: "stopped",
    listed: false,
    wanted: true,
    info: {
      id,
      name: `cloud-demo${i + 1}`,
      named: true,
      url: `ws://127.0.0.1:${port}`,
      ssh: null,
      on: true,
      status: "disconnected",
      stage: null,
      error: null,
      fix: null,
      release: null,
      beta: false,
      latest: null,
      app: false,
      restarting: false,
      boat: { phase: "running", stopsAt: null, warning: false, note: null },
      cloud: true,
    },
    conn: connect(
      `ws://127.0.0.1:${port}`,
      token,
      (event, payload) => void emit("server_event", { server: id, event, payload }),
      (status, error) => {
        m.info = { ...m.info, status, error: m.state === "stopped" ? "Stopped" : (error ?? null) };
        announce();
      },
    ),
  };
  machines.push(m);
  setState(m, "stopped");
});

/// Boat, by hand. Drawn over the app's corner.
function ControlPlane() {
  useSyncExternalStore(changed.subscribe, () => `${failNext}${machines.map((m) => `${m.listed}${m.state}${m.info.status}`).join()}`);
  return (
    <div className="fixed right-3 bottom-3 z-[1000] flex flex-col gap-1.5 rounded-xl border border-border bg-popover p-3 text-ui shadow-lg">
      <span className="font-medium">Faked control plane</span>
      {listed().map((m) => (
        <div key={m.sandbox} className="flex items-center gap-2">
          <span className="w-24 truncate">{m.info.name}</span>
          <span className="w-28 text-muted-foreground">{m.info.status === "connected" ? m.state : `${m.state} · ${m.info.status}`}</span>
          <button
            className="w-16 rounded border border-border px-1"
            onClick={() => (m.state === "stopped" ? void resume(m) : setState(m, "stopped"))}
          >
            {m.state === "stopped" ? "Resume" : "Stop"}
          </button>
        </div>
      ))}
      <span className="text-muted-foreground">{machines.filter((m) => !m.listed).length} spare</span>
      <label className="flex items-center gap-1.5">
        <input type="checkbox" checked={failNext} onChange={(e) => ((failNext = e.target.checked), changed.emit())} />
        Fail the next start
      </label>
    </div>
  );
}

// After the mock: the app's modules reach for Tauri as they load.
const { default: App } = await import("@/App");
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
    <ControlPlane />
  </React.StrictMode>,
);
