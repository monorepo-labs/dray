import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useSyncExternalStore } from "react";

import { readLocalStorage } from "@/hooks/useLocalStorage";
import { channel } from "@/lib/channel";
import type { ChromiumStatus } from "@/types/events";
import { zoomLevel } from "@/lib/zoom";

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
};

const EMPTY: BrowserTab[] = [];
const tabsBySession = new Map<string, BrowserTab[]>();
const fetched = new Set<string>();
const { emit: notify, subscribe } = channel<void>();
let started = false;

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
  // `dray browser screenshot` opening and closing its shutter. The view
  // hides for the shot and the page's own still stands in its place, so the
  // reflow the capture needs happens where nobody is looking. Nothing is
  // drawn on top of that still: it is the page pixel for pixel, so the
  // whole shot is invisible, which is the point.
  void listen<{ sessionId: string; shooting: boolean; shot: number }>("browser_shooting", (e) => {
    const { sessionId, shooting: on } = e.payload;
    if (on) shooting.add(sessionId);
    else shooting.delete(sessionId);
    shot = e.payload.shot;
    const winner = presenter();
    // Nothing of this session's page is on screen, so there is no reflow to
    // hide and nothing to wait for. Answered before `present`, which in
    // that case does no work and would leave the shot waiting on a hide
    // that is never going to happen.
    if (on && (!shown || winner?.sessionId !== sessionId)) shutterReady(shot);
    present();
    notify();
  });
  void listen<{ sessionId: string; recording: boolean }>("browser_recording", (e) => {
    if (e.payload.recording) recording.add(e.payload.sessionId);
    else recording.delete(e.payload.sessionId);
    notify();
  });
  // Whether Chromium is on disk yet. The first read fails in a build without
  // the browser, which leaves `null` and both surfaces silent. The listener
  // is *awaited* before the snapshot is asked for, and the snapshot dropped
  // if an event landed meanwhile: a download finishing inside the round trip
  // is otherwise put back to "downloading" by the older answer, with nothing
  // later to correct it.
  void (async () => {
    let events = 0;
    await listen<ChromiumStatus>("chromium_status", (e) => {
      events++;
      setChromium(e.payload);
    });
    const seen = events;
    const status = await invoke<ChromiumStatus>("chromium_status").catch(() => null);
    if (status && events === seen) setChromium(status);
  })();
  // Radix puts `pointer-events: none` on body while a modal is open — a
  // menu as much as a dialog — and the native view would sit over one that
  // lands on it. `childList` is a submenu portalling in later. The judging
  // is deferred two frames, since the popper is placed a moment after the
  // style lands and an unplaced menu measures off-screen.
  new MutationObserver(() => {
    const blocked = document.body.style.pointerEvents === "none";
    if (blocked !== modalOpen) {
      modalOpen = blocked;
      occluded = null;
      present();
    }
    judgeSoon();
  }).observe(document.body, { attributes: true, attributeFilter: ["style"], childList: true });
}

/// Two frames on, so a popper just portalled in has been placed. Called
/// from every change that could put the view under something: the body
/// mutation, and a claim landing or moving while a modal is already up.
function judgeSoon() {
  if (modalOpen && !occluded) requestAnimationFrame(() => requestAnimationFrame(judgeOcclusion));
}

/// What a modal puts on screen: menus in their popper wrapper, dialogs by
/// their full-window overlay. Anything else open is taken to cover the view.
const OPEN_SURFACES = '[data-radix-popper-content-wrapper], [data-slot$="-overlay"]';

/// Hides the view only where something open lands on it, so a menu opened
/// elsewhere leaves the page live and untouched — the swap to a picture is
/// visible on its own. Escalates only: a submenu closing does not bring the
/// view back under the menu that stays.
function judgeOcclusion() {
  if (!modalOpen || occluded) return;
  const view = presenter()?.rect;
  if (!view) return;
  const open = [...document.querySelectorAll(OPEN_SURFACES)];
  occluded =
    open.length === 0 ||
    open.some((el) => {
      const r = el.getBoundingClientRect();
      return r.left < view.right && r.right > view.left && r.top < view.bottom && r.bottom > view.top;
    });
  present();
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

/// `null` until the session's first read answers, so a caller acting on a
/// tab *appearing* can tell one from the list just being learned.
export function useBrowserTabs(sessionId: string | null): BrowserTab[] | null {
  start();
  if (sessionId) fetchTabs(sessionId);
  return useSyncExternalStore(subscribe, () =>
    sessionId ? (tabsBySession.get(sessionId) ?? null) : EMPTY,
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

/// For a caller that answers a failed open some other way — the link
/// opener falls back to the system browser — so the pane does not later
/// report a failure that was already handled.
export function clearOpenError(sessionId: string) {
  openErrors.delete(sessionId);
  notify();
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

/// Moves a tab to place `to` in its session's strip.
export function moveTab(sessionId: string, id: number, to: number) {
  return invoke("browser_move", { sessionId, id, to });
}

export function closeTab(sessionId: string, id: number) {
  return invoke("browser_close", { sessionId, id });
}

export function navigate(sessionId: string, action: "back" | "forward" | "reload" | "stop" | "hard_reload") {
  return invoke("browser_nav", { sessionId, action });
}

export function openDevTools(sessionId: string) {
  return invoke("browser_devtools", { sessionId });
}

// --- Picking an element ------------------------------------------------------

type PickedElement = {
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

/// Sessions `dray browser record` is recording, as `browser_recording` says.
const recording = new Set<string>();

export function useRecording(sessionId: string): boolean {
  return useSyncExternalStore(subscribe, () => recording.has(sessionId));
}

/// Read at a keypress, where a hook's copy would be the last render's.
export function isRecording(sessionId: string): boolean {
  return recording.has(sessionId);
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

// --- Chromium itself ---------------------------------------------------------

/// The framework is downloaded after install, not shipped; until it lands the
/// browser has nothing to draw pages with. `null` is a build with no browser.
let chromium: ChromiumStatus | null = null;

function setChromium(next: ChromiumStatus) {
  chromium = next;
  notify();
}

export function useChromium(): ChromiumStatus | null {
  start();
  return useSyncExternalStore(subscribe, () => chromium);
}

/// Starts the download, or retries a failed one. The status event answers.
export function downloadChromium() {
  return invoke("chromium_download");
}

export function removeChromium() {
  return invoke("chromium_remove");
}

// --- Local servers -----------------------------------------------------------

export type LocalServer = { port: number; process: string; mine: boolean };

export function listLocalServers(sessionId: string) {
  return invoke<LocalServer[]>("list_local_servers", { sessionId });
}

// --- Device viewport ---------------------------------------------------------

/// `preset` is a device id, a built-in one or a saved one.
export type Viewport = { preset: string; width: number; height: number };

export type Device = { id: string; label: string; width: number; height: number };

/// The MacBook Pro sizes are macOS's default scaled resolution, the one a
/// page actually lays out at, not the panel's pixel count.
export const VIEWPORT_PRESETS: readonly Device[] = [
  { id: "iphone-se", label: "iPhone SE", width: 375, height: 667 },
  { id: "iphone-15", label: "iPhone 15", width: 393, height: 852 },
  { id: "pixel-8", label: "Pixel 8", width: 412, height: 915 },
  { id: "ipad-mini", label: "iPad Mini", width: 768, height: 1024 },
  { id: "ipad-air", label: "iPad Air", width: 820, height: 1180 },
  { id: "laptop", label: "Laptop", width: 1280, height: 800 },
  { id: "desktop", label: "Desktop", width: 1440, height: 900 },
  { id: "macbook-pro-14", label: "MacBook Pro 14", width: 1512, height: 982 },
  { id: "macbook-pro-16", label: "MacBook Pro 16", width: 1728, height: 1117 },
  { id: "1080p", label: "1080p", width: 1920, height: 1080 },
  { id: "4k", label: "4K", width: 3840, height: 2160 },
];

/// The reader's saved sizes. A module store rather than `useLocalStorage`,
/// since the panel and the full view each mount the pane and a per-component
/// copy would miss a size saved in the other.
const DEVICES_KEY = "ade.browserDevices";
let customDevices: Device[] = readLocalStorage<Device[]>(DEVICES_KEY, []);

function storeDevices(next: Device[]) {
  customDevices = next;
  localStorage.setItem(DEVICES_KEY, JSON.stringify(next));
  notify();
}

export function useCustomDevices(): Device[] {
  return useSyncExternalStore(subscribe, () => customDevices);
}

/// A blank name saves under its size.
export function saveCustomDevice(name: string, width: number, height: number): Device {
  const device = {
    id: `custom-${crypto.randomUUID()}`,
    label: name.trim() || `${width} × ${height}`,
    width,
    height,
  };
  storeDevices([...customDevices, device]);
  return device;
}

export function removeCustomDevice(id: string) {
  // Another session may still be on it, which would leave a size the menu cannot name.
  for (const [session, v] of viewportBySession) if (v.preset === id) viewportBySession.delete(session);
  storeDevices(customDevices.filter((d) => d.id !== id));
}

const viewportBySession = new Map<string, Viewport>();

export function useViewport(sessionId: string): Viewport | null {
  return useSyncExternalStore(subscribe, () => viewportBySession.get(sessionId) ?? null);
}

/// `null` is the default: the page fills the pane. Any pick leaves
/// responsive mode, which is a pick of its own.
export function setViewport(sessionId: string, viewport: Viewport | null) {
  if (viewport) viewportBySession.set(sessionId, viewport);
  else viewportBySession.delete(sessionId);
  responsiveSessions.delete(sessionId);
  notify();
}

/// Responsive mode: the page fills the pane as it does by default, with the
/// bar up showing its live size so it can be saved as a device.
const responsiveSessions = new Set<string>();

export function useResponsive(sessionId: string): boolean {
  return useSyncExternalStore(subscribe, () => responsiveSessions.has(sessionId));
}

export function setResponsive(sessionId: string) {
  viewportBySession.delete(sessionId);
  responsiveSessions.add(sessionId);
  notify();
}

// --- Presenting the native view ---------------------------------------------

type Claim = { priority: number; sessionId: string; rect: DOMRectReadOnly };
const claims = new Map<string, Claim>();
let modalOpen = false;
/// Something open lands on the view: `null` until judged for this modal,
/// cleared with it, so this alone says whether the view hides. A view not
/// yet on screen waits for the judgement; one already up stays up, since
/// hiding it and bringing it back is the flash this exists to remove.
let occluded: boolean | null = null;
let shown = false;
let lastSession: string | null = null;

/// A picture of the page drawn in the native view's place while a modal has
/// it hidden, or the pane is a hole for as long as a menu is open. `url` is
/// `null` where the capture failed: the view still hides, over nothing.
/// One object per capture, and callbacks compare against it: two menus in
/// a row over an unchanged page capture the same URL, so a URL cannot tell
/// the first capture's late fallback from the second's image.
export type Snapshot = { sessionId: string; url: string | null };
let snapshot: Snapshot | null = null;
let capturing = false;

/// The sessions whose page `dray browser screenshot` or `record` is laying
/// out at another size, which is a visible reflow in the pane the reader is
/// watching — so the view hides and the page's own still is drawn in its
/// place. The still is what makes it a cover rather than a hole: the shutter
/// opens *before* the override lands, so what is photographed is the page as
/// the reader last saw it, and the swap is invisible. A set, since a
/// recording holds its session's shutter open for its whole length and
/// another session's screenshot must not close it.
const shooting = new Set<string>();
/// The newest shot, as `browser_shooting` numbered it.
let shot = 0;

/// Whether the native view is off screen: a modal landed on it, or a shot
/// is under way on the session presenting it. One predicate, because the
/// still, the paint callback and the layout call must all agree about it —
/// they each asked `occluded` separately before, which left a shot drawing
/// a still nothing would hide behind.
function hiding(): boolean {
  if (occluded) return true;
  const winner = presenter();
  return !!winner && shooting.has(winner.sessionId);
}

export function useBrowserSnapshot(sessionId: string): Snapshot | null {
  return useSyncExternalStore(subscribe, () => (snapshot?.sessionId === sessionId ? snapshot : null));
}

/// Captured *before* the view hides, so the pane never blanks; a menu over
/// the page lands a few frames late instead. Capped so a stuck capture
/// cannot leave that menu under the view. WebKit keeps no decoded cache for
/// a data URL, so the hide waits on the mounted `<img>` itself, with a
/// fallback clock for a pane that never mounts one.
function captureSnapshot(sessionId: string) {
  capturing = true;
  const timeout = new Promise<null>((r) => setTimeout(() => r(null), 400));
  void Promise.race([invoke<string>("browser_snapshot", { sessionId }), timeout])
    .catch(() => null)
    .then((url) => {
      capturing = false;
      if (!hiding()) return;
      const taken: Snapshot = { sessionId, url };
      snapshot = taken;
      notify();
      if (url) setTimeout(() => snapshotPainted(taken), 500);
      else present();
    });
}

/// The pane's image is decoded: two frames on so it has painted, then hide.
export function snapshotPainted(of: Snapshot) {
  if (snapshot !== of || !hiding()) return;
  requestAnimationFrame(() => requestAnimationFrame(present));
}

/// A pane says "I am showing this session's browser here". `null` withdraws.
export function claimPresenter(key: string, claim: Claim | null) {
  if (claim) claims.set(key, claim);
  else claims.delete(key);
  present();
  judgeSoon();
}

function presenter(): Claim | null {
  let winner: Claim | null = null;
  for (const c of claims.values()) {
    if (c.rect.width > 0 && c.rect.height > 0 && (!winner || c.priority > winner.priority)) winner = c;
  }
  return winner;
}

function present() {
  const winner = presenter();
  if (winner && modalOpen && occluded === null && !shown) return;
  // A shot hides the view the same way a modal does, and only for the
  // session being photographed: another session's page is not reflowing.
  const hidden = hiding();
  if (winner && !hidden) {
    shown = true;
    lastSession = winner.sessionId;
    const r = winner.rect;
    // The picture stays until the view is back over it, or the pane is a
    // hole for the round trip.
    const held = snapshot;
    // DOM rects are CSS pixels and the native view is placed in window points.
    const z = zoomLevel();
    void invoke("browser_layout", {
      sessionId: winner.sessionId,
      x: r.left * z,
      y: r.top * z,
      width: r.width * z,
      height: r.height * z,
      visible: true,
    })
      .catch(() => undefined)
      .then(() => {
        if (held && snapshot === held && !hiding()) {
          snapshot = null;
          notify();
        }
      });
  } else if (lastSession) {
    // Read now, not when the hide answers: by then the shot this hide is
    // for may be over and `shot` may name the next one.
    const covering = shot;
    // Hold the view up until its picture is in; the capture calls back here.
    if (hidden && winner && !snapshot) {
      if (!capturing) captureSnapshot(winner.sessionId);
      return;
    }
    shown = false;
    // Nothing claims the view, so nothing is drawing the still either — the
    // pane that was is gone. Dropped here because the only other place that
    // clears one is the view coming *back*, which for a withdrawn pane
    // never happens: the picture would sit in memory until the next shot
    // replaced it. Never where a winner remains, since there the still is
    // what is on screen.
    if (!winner && snapshot) {
      snapshot = null;
      notify();
    }
    void invoke("browser_layout", {
      sessionId: lastSession,
      x: 0,
      y: 0,
      width: 0,
      height: 0,
      visible: false,
    })
      .catch(() => undefined)
      // The shot is held until here, so it photographs a page the reader
      // is no longer looking at. Answered after the hide lands, never
      // before: the whole point is that the reflow happens off screen.
      .then(() => shutterReady(covering));
  }
}

/// Tells shot `of` the page is covered. Also the answer when there is
/// nothing to cover — no pane presenting this session, so no reflow anybody
/// can see — since otherwise every screenshot taken with the browser tab
/// shut would sit out the full timeout for a cover it never needed.
///
/// **Which shot is named, and it has to be.** One shot is answered twice
/// where the pane has nothing to cover: once here, and again when the hide
/// it asked for lands. Unnumbered, that spare answer released the *next*
/// shot before its own still was painted — the reflow, back on screen every
/// other capture. The number is captured where the answer is promised, not
/// read when it arrives, so a hide finishing after its shot is over names
/// the shot it belonged to and releases nothing.
function shutterReady(of: number) {
  void invoke("browser_shutter_ready", { shot: of }).catch(() => undefined);
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
