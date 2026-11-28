import { useSyncExternalStore } from "react";

import { channel } from "@/lib/channel";
import { invoke, listen, LOCAL } from "@/lib/transport";

/// Whether this machine is offline, as the app's probe last found
/// ([network.rs](../../src-tauri/src/network.rs)). The webview's own
/// `online`/`offline` events are only hints to it: `navigator.onLine` stays
/// true behind a captive portal or a link that carries nothing.
let offline = false;
let started = false;
const changed = channel<void>();

function set(next: boolean) {
  if (next === offline) return;
  offline = next;
  changed.emit();
}

function start() {
  if (started) return;
  started = true;
  void listen<boolean>("network_changed", ({ payload, server }) => {
    if (server === LOCAL) set(payload);
  }).then(() => invoke<boolean>("network_offline", {}, LOCAL).then(set).catch(() => {}));
  if (typeof window === "undefined") return;
  const hint = (online: boolean) => void invoke("network_hint", { online }, LOCAL).catch(() => {});
  window.addEventListener("online", () => hint(true));
  window.addEventListener("offline", () => {
    set(true);
    hint(false);
  });
  if (!navigator.onLine) hint(false);
}

export function subscribeNetwork(listener: () => void): () => void {
  start();
  return changed.subscribe(listener);
}

export const networkOffline = (): boolean => offline;

export function useNetworkOffline(): boolean {
  return useSyncExternalStore(subscribeNetwork, networkOffline, networkOffline);
}

/// The words a call to an unreachable server fails with, Rust's own and the
/// network stack's under them.
const CONNECTION_FAILURE =
  /lost the connection to|is not connected|could not reach|error sending request|dns error|failed to lookup address|network is unreachable|error connecting to/i;

/// Whether `message` is a failure being offline explains, which the offline
/// line already says and an error banner would only repeat.
export const offlineFailure = (message: string): boolean => offline && CONNECTION_FAILURE.test(message);
