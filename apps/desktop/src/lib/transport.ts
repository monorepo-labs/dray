// The one door to the Rust core. Inside the desktop app it is Tauri's own
// `invoke` and `listen` for the local core, and `server_invoke`/`server_event`
// for each remote `dray-serve` Rust holds a connection to. Pointed at a
// `dray-serve` from a plain browser it is a WebSocket speaking the same two
// calls. See SERVE-PLAN.md and SERVERS-PLAN.md.
//
// A browser names its server by the page's URL: `?token=…`, plus
// `&server=ws://…` for anything but the default. That server is `local` there.

import { convertFileSrc, invoke as tauriInvoke } from "@tauri-apps/api/core";
import { listen as tauriListen, type Event, type UnlistenFn } from "@tauri-apps/api/event";

/// `"local"` for the in-process core, an id from `servers.json` for a remote one.
export type ServerId = string;
export const LOCAL: ServerId = "local";

/// An event, saying which server sent it.
export type ServerEvent<T> = Event<T> & { server: ServerId };
export type ServerEventCallback<T> = (event: ServerEvent<T>) => void;

// ── paths ─────────────────────────────────────────────────────────────────────

/// A remote path, in the frontend, is `dray://<server>/abs/path`, so every key
/// built on a cwd or a project path is unique across servers with nothing else
/// changed. `invoke` is the only thing that unwraps one.
const SCHEME = "dray://";

/// The server a path lives on, and the path as that server spells it.
export function splitPath(path: string): { server: ServerId; path: string } {
  if (!path.startsWith(SCHEME)) return { server: LOCAL, path };
  const rest = path.slice(SCHEME.length);
  const slash = rest.indexOf("/");
  return slash < 0 ? { server: rest, path: "/" } : { server: rest.slice(0, slash), path: rest.slice(slash) };
}

export const serverOfPath = (path: string): ServerId => splitPath(path).server;

/// What a reader sees: the path as its own machine spells it.
export const displayPath = (path: string): string => splitPath(path).path;

/// `path` as the frontend keys it on `server`. Relative and already-qualified
/// paths come back untouched.
export function qualify(path: string, server: ServerId): string {
  if (server === LOCAL || !path.startsWith("/")) return path;
  return `${SCHEME}${server}${path}`;
}

// ── sessions ──────────────────────────────────────────────────────────────────

/// Which server each session lives on. A session never moves servers, so an
/// entry is never wrong once written.
const sessionServers = new Map<string, ServerId>();

export function noteSession(sessionId: string, server: ServerId): void {
  if (server !== LOCAL) sessionServers.set(sessionId, server);
}

export const serverOfSession = (sessionId: string | null | undefined): ServerId =>
  (sessionId && sessionServers.get(sessionId)) || LOCAL;

// ── answers that carry paths ──────────────────────────────────────────────────

type Rec = Record<string, unknown>;

/// Qualifies the path fields of a project, index item or snapshot, and of
/// a send's or fork's `snapshot`. Events inside are left as the agent wrote them.
function qualifyRecord(value: unknown, server: ServerId): unknown {
  if (Array.isArray(value)) return value.map((v) => qualifyRecord(v, server));
  if (!value || typeof value !== "object") return value;
  const out: Rec = { ...(value as Rec) };
  for (const key of ["cwd", "projectPath", "path"]) {
    if (typeof out[key] === "string") out[key] = qualify(out[key] as string, server);
  }
  if (out.snapshot) out.snapshot = qualifyRecord(out.snapshot, server);
  if (typeof out.sessionId === "string") noteSession(out.sessionId, server);
  return out;
}

/// Commands whose answer names project or session paths. A remote answer to one
/// is qualified before any caller sees it.
const QUALIFIED = new Set([
  "list_projects",
  "add_project",
  "remove_project",
  "set_project_space",
  "move_project",
  "retag_space",
  "list_session_index_items",
  "session_index_item",
  "detach_session",
  "remove_session_worktree",
  "set_session_flags",
  "get_session_by_id",
  "fork_session",
  "send_msg",
  "read_file",
]);

/// Events whose payload names paths, and how to qualify it.
const QUALIFIED_EVENTS: Record<string, (payload: unknown, server: ServerId) => unknown> = {
  session_created: qualifyRecord,
  doc_changed: (payload, server) => (typeof payload === "string" ? qualify(payload, server) : payload),
};

// ── invoke ────────────────────────────────────────────────────────────────────

/// Unwraps every qualified argument — top level, and strings inside arrays —
/// and answers the one server they name. Two servers in one call is a bug in
/// the caller, refused rather than sent half to each.
function unwrapArgs(args: Rec): { args: Rec; server: ServerId | null } {
  let server: ServerId | null = null;
  const take = (value: string): string => {
    if (!value.startsWith(SCHEME)) return value;
    const split = splitPath(value);
    if (server && server !== split.server) {
      throw new Error(`one call names two servers (${server}, ${split.server})`);
    }
    server = split.server;
    return split.path;
  };
  const out: Rec = {};
  for (const [key, value] of Object.entries(args)) {
    if (typeof value === "string") out[key] = take(value);
    else if (Array.isArray(value)) out[key] = value.map((v) => (typeof v === "string" ? take(v) : v));
    else out[key] = value;
  }
  return { args: out, server };
}

/// Commands that name a session but act on this Mac — its browser tabs, its
/// banners — and so never follow the session to its server.
const onThisMac = (cmd: string): boolean => cmd.startsWith("browser_") || cmd === "notify_session";

/// `invoke`, routed: to `server` where given, else to the server a qualified
/// argument names, else to the session's, else local.
export async function invoke<T>(cmd: string, args?: Rec, server?: ServerId): Promise<T> {
  const unwrapped = unwrapArgs(args ?? {});
  const sessionId = typeof unwrapped.args.sessionId === "string" ? unwrapped.args.sessionId : null;
  const target = server ?? unwrapped.server ?? (onThisMac(cmd) ? LOCAL : serverOfSession(sessionId));
  // A new session's first send routes by its cwd; this is where its id learns
  // its server.
  if (sessionId && unwrapped.server) noteSession(sessionId, unwrapped.server);
  if (target === LOCAL) return browser ? remoteInvoke<T>(browser, cmd, unwrapped.args) : tauriInvoke<T>(cmd, unwrapped.args);
  const answer = await tauriInvoke<unknown>("server_invoke", { server: target, cmd, args: unwrapped.args });
  return (QUALIFIED.has(cmd) ? qualifyRecord(answer, target) : answer) as T;
}

/// A URL the webview can load a server's file through: Tauri's asset protocol
/// for a local one; `drayserver://`, which Rust answers with the token in a
/// header, for a remote one. A remote server serves attachments and browser
/// recordings alone, so any other path answers 404.
export function fileSrc(path: string): string {
  const { server, path: raw } = splitPath(path);
  if (server !== LOCAL) {
    return `drayserver://localhost/?${new URLSearchParams({ server, path: raw })}`;
  }
  if (!browser) return convertFileSrc(raw);
  const base = browser.url.replace(/^ws/, "http").replace(/\/+$/, "");
  return `${base}/file?${new URLSearchParams({ token: browser.token, path: raw })}`;
}

// ── listen ────────────────────────────────────────────────────────────────────

type Handler = (event: ServerEvent<unknown>) => void;
const handlers = new Map<string, Set<Handler>>();
let remoteEvents: Promise<UnlistenFn> | null = null;

function deliver(event: string, payload: unknown, server: ServerId): void {
  const set = handlers.get(event);
  if (!set) return;
  if (server !== LOCAL && payload && typeof payload === "object") {
    const sessionId = (payload as Rec).sessionId;
    if (typeof sessionId === "string") noteSession(sessionId, server);
  }
  const fix = server === LOCAL ? null : QUALIFIED_EVENTS[event];
  const delivered = fix ? fix(payload, server) : payload;
  for (const handler of [...set]) handler({ event, id: 0, payload: delivered, server });
}

/// Every server's `event`, local and remote, with `server` on each.
export async function listen<T>(event: string, handler: ServerEventCallback<T>): Promise<UnlistenFn> {
  const set = handlers.get(event) ?? new Set();
  handlers.set(event, set);
  set.add(handler as Handler);
  if (browser) {
    // Not awaited: Tauri's `listen` never fails for a server being down, and a
    // failed open retries on its own while a listener is registered.
    connect(browser).catch(() => {});
  } else {
    remoteEvents ??= tauriListen<{ server: ServerId; event: string; payload: unknown }>("server_event", ({ payload }) =>
      deliver(payload.event, payload.payload, payload.server),
    );
    await remoteEvents;
  }
  const local = browser ? null : await tauriListen(event, ({ payload }) => {
    if (set.has(handler as Handler)) (handler as Handler)({ event, id: 0, payload, server: LOCAL });
  });
  return () => {
    local?.();
    set.delete(handler as Handler);
    if (set.size === 0) handlers.delete(event);
  };
}

// ── a plain browser pointed at one dray-serve ────────────────────────────────

/** Stated again from serve.rs's `PROTOCOL`; the server refuses a mismatch by name. */
const PROTOCOL = 1;
const DEFAULT_SERVER = "ws://127.0.0.1:7317";

type Remote = { url: string; token: string };

function browserServer(): Remote | null {
  if (typeof location === "undefined") return null;
  const query = new URLSearchParams(location.search);
  const token = query.get("token");
  return token ? { url: query.get("server") ?? DEFAULT_SERVER, token } : null;
}

const browser = browserServer();

type Pending = { resolve: (value: unknown) => void; reject: (reason: unknown) => void };

const pending = new Map<number, Pending>();
let nextId = 0;
let socket: Promise<WebSocket> | null = null;

/** Opens the socket and settles once the server has admitted us. */
function connect(server: Remote): Promise<WebSocket> {
  socket ??= new Promise<WebSocket>((resolve, reject) => {
    const ws = new WebSocket(server.url);
    let admitted = false;
    ws.onopen = () => ws.send(JSON.stringify({ v: PROTOCOL, token: server.token }));
    ws.onmessage = ({ data }) => {
      const frame = JSON.parse(data);
      if (!admitted) {
        if ("err" in frame) return reject(new Error(`dray-serve refused: ${frame.err}`));
        admitted = true;
        return resolve(ws);
      }
      if ("id" in frame) {
        const call = pending.get(frame.id);
        pending.delete(frame.id);
        if ("err" in frame) call?.reject(frame.err);
        else call?.resolve(frame.ok);
      } else {
        deliver(frame.event, frame.payload, LOCAL);
      }
    };
    ws.onclose = () => {
      socket = null;
      if (!admitted) reject(new Error(`could not reach dray-serve at ${server.url}`));
      for (const call of pending.values()) call.reject("connection to dray-serve closed");
      pending.clear();
      // Something is waiting on events, and nothing else would reopen the
      // socket for it. The server opens every connect with `live_state`, which
      // is what catches the page up.
      if (handlers.size > 0) setTimeout(() => void connect(server).catch(() => {}), 1000);
    };
  });
  return socket;
}

async function remoteInvoke<T>(server: Remote, cmd: string, args: Rec): Promise<T> {
  const ws = await connect(server);
  const id = ++nextId;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
    ws.send(JSON.stringify({ id, cmd, args }));
  });
}
