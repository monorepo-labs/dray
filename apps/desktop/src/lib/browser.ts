import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useSyncExternalStore } from "react";

/// The in-app browser's frontend half: tabs per session as the backend
/// reports them, and the one rule about who presents the native view.
///
/// Chromium draws straight into the window above the webview, so React
/// cannot compose it. Two panes can show a session's browser — the Browser
/// tab and the right panel's Live slot — and each *claims* the view with its
/// rect; the highest-priority live claim wins and its rect goes to Rust. No
/// claim, or a modal open, hides the view.

export type BrowserTab = {
  id: number;
  url: string;
  title: string;
  favicon: string;
  loading: boolean;
  active: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  /// The main frame's last load failure, from Chromium's own words.
  error: string | null;
  /// CEF's level: 0 is 100%, a step is ×1.2.
  zoom: number;
};

const EMPTY: BrowserTab[] = [];
const tabsBySession = new Map<string, BrowserTab[]>();
const fetched = new Set<string>();
const listeners = new Set<() => void>();
let started = false;

function notify() {
  for (const l of listeners) l();
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => void listeners.delete(l);
}

function start() {
  if (started) return;
  started = true;
  void listen<{ sessionId: string; tabs: BrowserTab[] }>("browser_tabs", (e) => {
    const { sessionId, tabs } = e.payload;
    // A tab arriving is what the pending new tab was waiting for, whoever
    // opened it — the URL bar, a link in the chat, a popup.
    if (tabs.length > (tabsBySession.get(sessionId)?.length ?? 0)) {
      pending.delete(sessionId);
      openErrors.delete(sessionId);
    }
    tabsBySession.set(sessionId, tabs);
    fetched.add(sessionId);
    notify();
  });
  void listen<{ sessionId: string; element: PickedElement | null }>("browser_pick", (e) => {
    picking.delete(e.payload.sessionId);
    notify();
    pickHandler?.(e.payload.sessionId, e.payload.element);
  });
  // A ⌘-chord pressed inside the page. Chromium's view has focus, so the
  // document never saw the key; re-raise it as a synthetic event, which is
  // all `useHotkey` needs. Shifted letters arrive upper-cased, as a real
  // event carries them.
  void listen<{ key: string; code: string; shift: boolean; alt: boolean; ctrl: boolean }>("cef_key", (e) => {
    const { key, code, shift, alt, ctrl } = e.payload;
    document.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: shift && key.length === 1 ? key.toUpperCase() : key,
        code,
        metaKey: true,
        shiftKey: shift,
        altKey: alt,
        ctrlKey: ctrl,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  // `dray browser set viewport|device`: the agent's size lands in the same
  // store the device bar writes, so the bar shows what the agent set.
  void listen<{ sessionId: string; preset: string; width: number; height: number }>("browser_viewport", (e) => {
    const { sessionId, preset, width, height } = e.payload;
    setViewport(sessionId, { preset, width, height });
  });
  // Radix puts `pointer-events: none` on body while a modal is open. The
  // native view would sit over the dialog otherwise.
  new MutationObserver(() => {
    const blocked = document.body.style.pointerEvents === "none";
    if (blocked !== modalOpen) {
      modalOpen = blocked;
      present();
    }
  }).observe(document.body, { attributes: true, attributeFilter: ["style"] });
}

function fetchTabs(sessionId: string) {
  if (fetched.has(sessionId)) return;
  fetched.add(sessionId);
  void invoke<BrowserTab[]>("browser_tabs", { sessionId })
    .then((tabs) => {
      tabsBySession.set(sessionId, tabs);
      notify();
    })
    .catch(() => fetched.delete(sessionId));
}

export function useBrowserTabs(sessionId: string | null): BrowserTab[] {
  start();
  if (sessionId) fetchTabs(sessionId);
  return useSyncExternalStore(subscribe, () =>
    sessionId ? (tabsBySession.get(sessionId) ?? EMPTY) : EMPTY,
  );
}

/// Why the last open in a session failed, or `null`. Held here rather than
/// in the pane, so every route that opens — the URL bar, a local server
/// row, a link in the chat — reports through one place, and the next open
/// or a dismissed new tab clears it.
const openErrors = new Map<string, string>();

export function useOpenError(sessionId: string): string | null {
  return useSyncExternalStore(subscribe, () => openErrors.get(sessionId) ?? null);
}

export function openInBrowser(sessionId: string, url: string, newTab = false) {
  openErrors.delete(sessionId);
  notify();
  return invoke("browser_open", { sessionId, url, newTab }).catch((e: unknown) => {
    openErrors.set(sessionId, String(e));
    notify();
    throw e;
  });
}

export function activateTab(sessionId: string, id: number) {
  return invoke("browser_activate", { sessionId, id });
}

export function closeTab(sessionId: string, id: number) {
  return invoke("browser_close", { sessionId, id });
}

export function navigate(sessionId: string, action: "back" | "forward" | "reload" | "stop" | "hard_reload") {
  return invoke("browser_nav", { sessionId, action });
}

export function zoom(sessionId: string, action: "in" | "out" | "reset") {
  return invoke("browser_zoom", { sessionId, action });
}

export function openDevTools(sessionId: string) {
  return invoke("browser_devtools", { sessionId });
}

/// CEF's zoom level as the percentage Chrome would show.
export function zoomPercent(level: number) {
  return Math.round(1.2 ** level * 100);
}

// --- Picking an element ------------------------------------------------------

export type PickedElement = {
  url: string;
  title: string;
  selector: string;
  tag: string;
  text: string;
  attrs: Record<string, string>;
  rect: { x: number; y: number; width: number; height: number };
  styles: { color: string; background: string; font: string };
};

const picking = new Set<string>();
let pickHandler: ((sessionId: string, element: PickedElement | null) => void) | null = null;

/// `App` installs the one handler, since what a pick *does* — land in the
/// composer — needs the composer.
export function setPickHandler(fn: typeof pickHandler) {
  pickHandler = fn;
}

export function usePicking(sessionId: string): boolean {
  return useSyncExternalStore(subscribe, () => picking.has(sessionId));
}

export function pickElement(sessionId: string, on: boolean) {
  if (on) picking.add(sessionId);
  else picking.delete(sessionId);
  notify();
  return invoke("browser_pick", { sessionId, start: on });
}

/// The block a pick appends to the draft: enough for the agent to find the
/// element in the source without a screenshot.
export function describePick(el: PickedElement): string {
  const attrs = Object.entries(el.attrs)
    .filter(([k]) => k !== "class" || el.attrs.class.length < 80)
    .map(([k, v]) => `${k}="${v}"`)
    .join(" ");
  const text = el.text ? ` "${el.text}"` : "";
  return [
    `Browser element: \`${el.selector}\` on ${el.url}`,
    `<${el.tag}${attrs ? " " + attrs : ""}>${text} · ${el.rect.width}×${el.rect.height} at (${el.rect.x}, ${el.rect.y}) · ${el.styles.font} · ${el.styles.color} on ${el.styles.background}`,
  ].join("\n");
}

// --- The pending new tab -----------------------------------------------------

/// A new tab is nothing until it has a URL: no Chromium browser is made for
/// it, so the pane can draw its own empty state where the page would be
/// (the page is a native view the DOM cannot draw over). One per session,
/// and it turns into a real tab the moment one arrives.
const pending = new Set<string>();

export function usePendingTab(sessionId: string): boolean {
  return useSyncExternalStore(subscribe, () => pending.has(sessionId));
}

export function setPendingTab(sessionId: string, on: boolean) {
  if (on) pending.add(sessionId);
  else {
    pending.delete(sessionId);
    openErrors.delete(sessionId);
  }
  notify();
}

// --- Local servers -----------------------------------------------------------

export type LocalServer = { port: number; process: string; mine: boolean };

export function listLocalServers(sessionId: string) {
  return invoke<LocalServer[]>("list_local_servers", { sessionId });
}

// --- Device viewport ---------------------------------------------------------

export type Viewport = { preset: string; width: number; height: number };

export const VIEWPORT_PRESETS: readonly { id: string; label: string; width: number; height: number }[] = [
  { id: "iphone-se", label: "iPhone SE", width: 375, height: 667 },
  { id: "iphone-15", label: "iPhone 15", width: 393, height: 852 },
  { id: "pixel-8", label: "Pixel 8", width: 412, height: 915 },
  { id: "ipad-mini", label: "iPad Mini", width: 768, height: 1024 },
  { id: "ipad-air", label: "iPad Air", width: 820, height: 1180 },
  { id: "laptop", label: "Laptop", width: 1280, height: 800 },
  { id: "desktop", label: "Desktop", width: 1440, height: 900 },
];

const viewportBySession = new Map<string, Viewport>();

export function useViewport(sessionId: string): Viewport | null {
  return useSyncExternalStore(subscribe, () => viewportBySession.get(sessionId) ?? null);
}

/// `null` is the responsive default: the page fills the pane.
export function setViewport(sessionId: string, viewport: Viewport | null) {
  if (viewport) viewportBySession.set(sessionId, viewport);
  else viewportBySession.delete(sessionId);
  notify();
}

// --- Presenting the native view ---------------------------------------------

type Claim = { priority: number; sessionId: string; rect: DOMRectReadOnly };
const claims = new Map<string, Claim>();
let modalOpen = false;
let lastSession: string | null = null;

/// A pane says "I am showing this session's browser here". `null` withdraws.
export function claimPresenter(key: string, claim: Claim | null) {
  if (claim) claims.set(key, claim);
  else claims.delete(key);
  present();
}

function present() {
  let winner: Claim | null = null;
  for (const c of claims.values()) {
    if (c.rect.width > 0 && c.rect.height > 0 && (!winner || c.priority > winner.priority)) winner = c;
  }
  if (winner && !modalOpen) {
    lastSession = winner.sessionId;
    const r = winner.rect;
    void invoke("browser_layout", {
      sessionId: winner.sessionId,
      x: r.left,
      y: r.top,
      width: r.width,
      height: r.height,
      visible: true,
    }).catch(() => undefined);
  } else if (lastSession) {
    void invoke("browser_layout", {
      sessionId: lastSession,
      x: 0,
      y: 0,
      width: 0,
      height: 0,
      visible: false,
    }).catch(() => undefined);
  }
}

/// What the URL bar opens. A scheme is taken as written; `host:port` looks
/// like a scheme, so a scheme wants its `//`. Loopback hosts read as `http`,
/// since that is what a dev server speaks. Anything that is not a host —
/// a space in it, or no dot — is a search.
export function normalizeUrl(input: string): string {
  const s = input.trim();
  if (!s) return s;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s) || /^(about|data|mailto|blob|chrome):/i.test(s)) return s;
  const host = s.split(/[/?#]/)[0] ?? "";
  const loopback = /^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(:\d+)?$/i.test(host);
  if (loopback) return `http://${s}`;
  if (/\s/.test(s) || !host.includes(".")) {
    return `https://www.google.com/search?q=${encodeURIComponent(s)}`;
  }
  return `https://${s}`;
}
