// The whole app on Dray Cloud (#857), in a plain browser: one real `dray-serve`
// stands in for This Mac, and two or more others for cloud machines. Tauri's IPC
// is mocked and the mock does in the page what `servers.rs` and `cloud.rs` do in
// Rust — the control plane is faked here, and a panel in the corner stands in
// for boat: stop a machine, or set the load its `machine_load` answers.
//
//   T=$(openssl rand -hex 32)          # one serve token, as the control plane derives
//   for h in mac c1 c2; do mkdir -p /tmp/dray-cloud/$h && echo $T > /tmp/dray-cloud/$h/serve-token; done
//   DRAY_HOME=/tmp/dray-cloud/mac dray-serve --port 7320 &
//   DRAY_HOME=/tmp/dray-cloud/c1  dray-serve --port 7321 &
//   DRAY_HOME=/tmp/dray-cloud/c2  dray-serve --port 7322 &
//   open "/demo/cloud.html?serveToken=$T&machines=7321,7322&states=running,stopped"
//
// Attach a project with a GitHub remote on This Mac, pick Cloud beside it and
// send. A clone onto a cloud machine runs `gh repo clone` for real, into
// `~/dray/<repo>`, which every machine here shares. `&key=` starts with a key
// saved; without it, Settings → Servers asks for one, and any key but `bad` is
// taken. `machine_load` is always the panel's, so this works against a
// `dray-serve` that predates it.

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
  /// When it last stopped, which a resume for room picks by.
  stoppedAt: number;
  turns: number;
  memAvailableMb: number;
  info: ServerInfo;
  conn: Socket;
  /// Whether the socket is meant to be open. `connect` opens one on its own,
  /// and asking it to open twice leaves two.
  wanted: boolean;
};

const machines: Machine[] = [];
let cloud: CloudInfo = { on: !!query.get("key"), keyed: !!query.get("key"), error: null };
const changed = channel<void>();

const announce = () => {
  void emit(
    "servers_changed",
    machines.map((m) => m.info),
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
  if (state === "stopped") m.stoppedAt = Date.now();
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

/// `POST /machines`: the most recently stopped resumes. With no spare
/// `dray-serve` there is nothing to fork, so that case answers the cap.
async function addRoom(): Promise<string> {
  if (!cloud.keyed) throw "Dray Cloud has no key. Add it in Settings, Servers.";
  const stopped = machines.filter((m) => m.state === "stopped").sort((a, b) => b.stoppedAt - a.stoppedAt)[0];
  if (!stopped) throw "Dray Cloud is at its limit of 3 running machines. Try again once one stops.";
  await resume(stopped);
  return stopped.info.id;
}

mockConvertFileSrc("macos");
mockIPC(
  async (cmd, args) => {
    const a = (args ?? {}) as Record<string, unknown>;
    const byId = (id: unknown) => machines.find((m) => m.info.id === id);
    switch (cmd) {
      case "list_servers":
        return cloud.keyed ? machines.map((m) => m.info) : [];
      case "local_server":
        return null;
      case "cloud_info":
        return cloud;
      case "set_cloud_key":
        if (a.key === "bad") throw "Dray Cloud didn't accept this key.";
        cloud = { on: !!a.key, keyed: !!a.key, error: null };
        announceCloud();
        for (const m of machines) setState(m, m.state);
        return null;
      case "set_cloud_on":
        cloud = { ...cloud, on: !!a.on };
        for (const m of machines) m.info = { ...m.info, on: !!a.on };
        announceCloud();
        for (const m of machines) setState(m, m.state);
        return null;
      case "add_cloud_room":
        return addRoom();
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
        if (a.cmd === "machine_load") return { turns: m.turns, memAvailableMb: m.memAvailableMb };
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
const states = (query.get("states") ?? "").split(",");
ports.forEach((port, i) => {
  const sandbox = `bx_demo${i + 1}`;
  const id = `cloud${i + 1}`;
  const m: Machine = {
    sandbox,
    state: "running",
    stoppedAt: 0,
    turns: 0,
    memAvailableMb: 6000,
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
  setState(m, (states[i] as State) || "running");
});

/// Boat and the server's load, by hand. Drawn over the app's corner.
function ControlPlane() {
  useSyncExternalStore(changed.subscribe, () => machines.map((m) => `${m.state}${m.turns}${m.memAvailableMb}${m.info.status}`).join());
  const field = "w-14 rounded border border-border bg-transparent px-1 text-right";
  return (
    <div className="fixed right-3 bottom-3 z-[1000] flex flex-col gap-1.5 rounded-xl border border-border bg-popover p-3 text-ui shadow-lg">
      <span className="font-medium">Faked control plane</span>
      {machines.map((m) => (
        <div key={m.sandbox} className="flex items-center gap-2">
          <span className="w-24 truncate">{m.info.name}</span>
          <span className="w-20 text-muted-foreground">{m.info.status === "connected" ? m.state : `${m.state} · ${m.info.status}`}</span>
          <button
            className="w-16 rounded border border-border px-1"
            onClick={() => (m.state === "stopped" ? void resume(m) : setState(m, "stopped"))}
          >
            {m.state === "stopped" ? "Resume" : "Stop"}
          </button>
          <label className="flex items-center gap-1">
            turns
            <input className={field} type="number" value={m.turns} onChange={(e) => ((m.turns = +e.target.value), changed.emit())} />
          </label>
          <label className="flex items-center gap-1">
            MB
            <input
              className={field}
              type="number"
              step={500}
              value={m.memAvailableMb}
              onChange={(e) => ((m.memAvailableMb = +e.target.value), changed.emit())}
            />
          </label>
        </div>
      ))}
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
