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
  loading: boolean;
  active: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
};

const EMPTY: BrowserTab[] = [];
const tabsBySession = new Map<string, BrowserTab[]>();
const fetched = new Set<string>();
const listeners = new Set<() => void>();
let started = false;

function notify() {
  for (const l of listeners) l();
}

function start() {
  if (started) return;
  started = true;
  void listen<{ sessionId: string; tabs: BrowserTab[] }>("browser_tabs", (e) => {
    tabsBySession.set(e.payload.sessionId, e.payload.tabs);
    fetched.add(e.payload.sessionId);
    notify();
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
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => (sessionId ? (tabsBySession.get(sessionId) ?? EMPTY) : EMPTY),
  );
}

export function openInBrowser(sessionId: string, url: string, newTab = false) {
  return invoke("browser_open", { sessionId, url, newTab });
}

export function activateTab(sessionId: string, id: number) {
  return invoke("browser_activate", { sessionId, id });
}

export function closeTab(sessionId: string, id: number) {
  return invoke("browser_close", { sessionId, id });
}

export function navigate(sessionId: string, action: "back" | "forward" | "reload" | "stop") {
  return invoke("browser_nav", { sessionId, action });
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
