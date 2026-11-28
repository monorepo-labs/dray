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

import { channel } from "@/lib/channel";

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

/// A Windows drive or UNC path carries its own root, so the slash after the
/// server id is a separator and not the path's leading slash. Without this a
/// remote Windows server's `C:\…` reads as relative and keys as a local path.
const WINDOWS_ROOT = /^(?:[A-Za-z]:[\\/]|\\\\)/;

/// The server a path lives on, and the path as that server spells it.
export function splitPath(path: string): { server: ServerId; path: string } {
  if (!path.startsWith(SCHEME)) return { server: LOCAL, path };
  const rest = path.slice(SCHEME.length);
  const slash = rest.indexOf("/");
  if (slash < 0) return { server: rest, path: "/" };
  const qualified = rest.slice(slash);
  return {
    server: rest.slice(0, slash),
    path: WINDOWS_ROOT.test(qualified.slice(1)) ? qualified.slice(1) : qualified,
  };
}

export const serverOfPath = (path: string): ServerId => splitPath(path).server;

/// What a reader sees: the path as its own machine spells it.
export const displayPath = (path: string): string => splitPath(path).path;

/// `path` as the frontend keys it on `server`. Relative and already-qualified
/// paths come back untouched.
export function qualify(path: string, server: ServerId): string {
  if (server === LOCAL || (!path.startsWith("/") && !WINDOWS_ROOT.test(path))) return path;
  return `${SCHEME}${server}${path.startsWith("/") ? "" : "/"}${path}`;
}

// ── sessions ──────────────────────────────────────────────────────────────────

/// Which server each session lives on. A session never moves servers, so an
/// entry is never wrong once written.
const sessionServers = new Map<string, ServerId>();
const sessionNoted = channel<void>();

export function noteSession(sessionId: string, server: ServerId): void {
  if (server === LOCAL || sessionServers.get(sessionId) === server) return;
  sessionServers.set(sessionId, server);
  sessionNoted.emit();
}

/// Hears a session learning its server, which a new one does at its first send.
export const onSessionNoted = sessionNoted.subscribe;

export const serverOfSession = (sessionId: string | null | undefined): ServerId =>
  (sessionId && sessionServers.get(sessionId)) || LOCAL;

// ── answers that carry paths ──────────────────────────────────────────────────

type Rec = Record<string, unknown>;

/// Qualifies the path fields of a project, index item or snapshot, and of
/// a send's or fork's `snapshot`. Events inside are left as the agent wrote them.
export function qualifyRecord(value: unknown, server: ServerId): unknown {
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
  "github_repos",
  "clone_github_repo",
  "remove_project",
  "set_project_space",
  "move_project",
  "retag_space",
  "list_session_index_items",
  "session_index_item",
  "detach_session",
  "attach_session",
  "remove_session_worktree",
  "set_session_flags",
  "get_session_by_id",
  "fork_session",
  "send_msg",
  "start_pr_session",
  "read_file",
  "list_bots",
  "create_bot",
  "start_bot",
]);

/// Events whose payload names paths, and how to qualify it.
const QUALIFIED_EVENTS: Record<string, (payload: unknown, server: ServerId) => unknown> = {
  session_created: qualifyRecord,
  session_changed: qualifyRecord,
  session_model_changed: qualifyRecord,
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
/// banners, the island's pick and its done pill — and so never follow the
/// session to its server.
const onThisMac = (cmd: string): boolean =>
  cmd.startsWith("browser_") || ["notify_session", "set_app_selection", "island_done"].includes(cmd);

/// What the app answers itself: the browser, dictation, banners, the updater,
/// the server list, opening apps and terminals. Every other local command goes
/// to this Mac's background server, which owns the sessions. `lib.rs`'s
/// `generate_handler!` is the same list, and a test holds the two together —
/// a name missing here is sent to a server that answers `unknown command`.
export const APP_COMMANDS = new Set([
  "list_servers",
  "local_server",
  "add_server",
  "remove_server",
  "server_unfinished",
  "save_server_cache",
  "server_caches",
  "reconnect_servers",
  "server_invoke",
  "server_cancel",
  "update_server",
  "restart_server_now",
  "servers_behind",
  "set_server_beta",
  "ignore_server_update",
  "check_server_update",
  "forward_port",
  "add_ssh_server",
  "cancel_add_server",
  "set_server_on",
  "network_offline",
  "network_hint",
  "rename_server",
  "set_server_address",
  "trust_host_key",
  "survey_server",
  "install_on_server",
  "run_server_login",
  "run_gh_login",
  "note_merge_for_star",
  "star_dray",
  "upload_attachment",
  "resume_boat",
  "extend_boat",
  "cloud_info",
  "set_cloud_key",
  "set_cloud_on",
  "start_cloud_machine",
  "drop_cloud_machine",
  "save_cloud_transcript",
  "cloud_transcript",
  "paste_attachments",
  "read_file",
  "browser_open",
  "browser_tabs",
  "browser_history",
  "browser_activate",
  "browser_close",
  "browser_move",
  "browser_nav",
  "browser_layout",
  "browser_pins",
  "browser_shutter_ready",
  "browser_devtools",
  "browser_pick",
  "browser_snapshot",
  "chromium_status",
  "chromium_download",
  "chromium_remove",
  "notify_session",
  "set_window_urgent",
  "check_update",
  "install_update",
  "confirm_quit",
  "dismiss_quit",
  "list_open_apps",
  "open_in_app",
  "configure_island",
  "island_running",
  "set_app_selection",
  "idle_seconds",
  "island_done",
  "island_prefs",
  "set_island_pref",
  "open_login_terminal",
  "run_agent_login",
  "update_agent_in_terminal",
  "install_agent_in_terminal",
  "transcription_status",
  "download_transcription_model",
  "cancel_transcription_download",
  "delete_transcription_model",
  "select_transcription_model",
  "select_transcription_device",
  "set_transcription_mute",
  "start_transcription",
  "transcription_level",
  "stop_transcription",
  "retry_transcription",
  "cancel_transcription",
]);

/// What an aborted `invoke` rejects with, so a caller can tell a drop it asked
/// for from a failure.
export const CANCELLED = "cancelled";

let nextTicket = 0;

/// `invoke`, routed: to `server` where given, else to the server a qualified
/// argument names, else to the session's, else local.
///
/// `signal` rejects the call with [`CANCELLED`] at once and tells the server
/// to stop, so the rest of the answer never crosses the wire. Only reads stop
/// there (`CANCELLABLE` in serve.rs); any other call still runs to its end.
export async function invoke<T>(cmd: string, args?: Rec, server?: ServerId, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) throw CANCELLED;
  const unwrapped = unwrapArgs(args ?? {});
  const sessionId = typeof unwrapped.args.sessionId === "string" ? unwrapped.args.sessionId : null;
  const target = server ?? unwrapped.server ?? (onThisMac(cmd) ? LOCAL : serverOfSession(sessionId));
  // A new session's first send routes by its cwd; this is where its id learns
  // its server.
  if (sessionId && unwrapped.server) noteSession(sessionId, unwrapped.server);
  if (target === LOCAL) {
    if (browser) return remoteInvoke<T>(browser, cmd, unwrapped.args, signal);
    if (APP_COMMANDS.has(cmd)) return tauriInvoke<T>(cmd, unwrapped.args);
  }
  const ticket = signal ? `t${++nextTicket}` : undefined;
  const call = tauriInvoke<unknown>("server_invoke", { server: target, cmd, args: unwrapped.args, ticket });
  const answer = await (signal && ticket ? abortable(call, signal, () => void tauriInvoke("server_cancel", { ticket }).catch(() => {})) : call);
  return (QUALIFIED.has(cmd) ? qualifyRecord(answer, target) : answer) as T;
}

/// `call`, rejected with [`CANCELLED`] the moment `signal` aborts, which also
/// runs `cancel` — once, and only while the call is still out.
function abortable<T>(call: Promise<T>, signal: AbortSignal, cancel: () => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cancel();
      reject(CANCELLED);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    const settle = () => {
      settled = true;
      signal.removeEventListener("abort", onAbort);
    };
    call.then(
      (value) => {
        settle();
        resolve(value);
      },
      (error) => {
        settle();
        reject(error);
      },
    );
  });
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

async function remoteInvoke<T>(server: Remote, cmd: string, args: Rec, signal?: AbortSignal): Promise<T> {
  // Watched while the socket opens too, or a pointer leaving then is lost
  // and the read goes out once it connects.
  const ws = await (signal ? abortable(connect(server), signal, () => {}) : connect(server));
  if (signal?.aborted) throw CANCELLED;
  const id = ++nextId;
  const call = new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
    ws.send(JSON.stringify({ id, cmd, args }));
  });
  if (!signal) return call;
  return abortable(call, signal, () => {
    pending.delete(id);
    ws.send(JSON.stringify({ cancel: id }));
  });
}
